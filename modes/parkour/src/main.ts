import {
  createClockSync,
  createLocalController,
  createSnapshotClient,
  createSnapshotReassembler,
  keysToMovement,
  type LocalController,
  type LocalWorld,
} from '@mp/client'
import { clamp, startFixedLoop, type EntityId, type Vec3 } from '@mp/core'
import {
  decodePong,
  decodeRoster,
  decodeSnapshot,
  decodeWelcome,
  encodePing,
  encodeState,
  MSG_PONG,
  MSG_ROSTER,
  MSG_SNAPSHOT,
  MSG_WELCOME,
  NET_CHANNEL,
  readMessageType,
} from '@mp/net'
import { createPhysicsWorld, initPhysics, type PhysicsBody } from '@mp/physics'
import {
  THREE,
  createThreeStage,
  applyGreyboxEnvironment,
  createPostFX,
  addLevel,
  type LevelView,
} from '@mp/render-three'
import {
  addCharacter,
  CHAR_HALF_HEIGHT,
  CHAR_RADIUS,
  DEFAULT_TUNING,
  playerSpawn,
  stepCharacter,
  TICK_DT,
  TICK_RATE_HZ,
  type CharacterState,
  type CharacterTuning,
} from '@mp/character'
import { instantiateLevel, validateLevel, type LoadedLevel } from '@mp/content'
import { Client, type Room } from 'colyseus.js'
import { Pane } from 'tweakpane'

import { showcase } from './showcase'

const SERVER_URL = `ws://${location.hostname}:9200`

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!
const canvas = $<HTMLCanvasElement>('#view')
const statusEl = $<HTMLDivElement>('#status')

// --- scene ---
const stage = createThreeStage({ canvas, cameraPosition: [0, 6, 10], lookAt: [0, 1, 0] })
// Polished greybox pipeline (content pipeline C3): IBL + ACES + soft shadows, with GTAO +
// SMAA post-FX. Level meshes, materials (the "High-contrast dev" palette) and markers are
// realized by the shared @mp/render-three renderer — same code the viewer uses.
applyGreyboxEnvironment(stage.renderer, stage.scene, { shadowRadius: 30, sunIntensity: 2.4 })
const postfx = createPostFX(stage.renderer, stage.scene, stage.camera, { ao: true, bloom: true, bloomStrength: 0.3 })

// Nametags live on an overlay layer drawn AFTER post-FX. GTAO renders the scene into its
// own depth/normal buffer to compute occlusion; a sprite left in the world pipeline shows
// up there as a hard dark AO ghost (the tilted black quad). Keeping the sprites on a layer
// the world camera never sees during post-FX excludes them from GTAO entirely; we then draw
// them on top, free of AO and tone mapping.
const OVERLAY_LAYER = 1
stage.setRenderStep(() => {
  postfx.render() // world + AO + bloom to screen (camera sees layer 0 only)
  const r = stage.renderer
  r.setRenderTarget(null)
  // A solid-colour scene.background forces a buffer clear on render() even with
  // autoClear off — which would wipe the composer output. Null it for the overlay only.
  const bg = stage.scene.background
  stage.scene.background = null
  r.autoClear = false
  stage.camera.layers.set(OVERLAY_LAYER) // render only the overlay (nametags), on top
  r.clearDepth()
  r.render(stage.scene, stage.camera)
  stage.camera.layers.set(0) // restore the world layer for the next frame
  stage.scene.background = bg
  r.autoClear = true
})

// A character: capsule + a "nose" so facing is visible.
const charGeo = new THREE.CapsuleGeometry(CHAR_RADIUS, CHAR_HALF_HEIGHT * 2, 6, 16)
const makeCharacter = (color: number): THREE.Group => {
  const g = new THREE.Group()
  const body = new THREE.Mesh(charGeo, new THREE.MeshStandardMaterial({ color, roughness: 0.6 }))
  body.castShadow = true
  g.add(body)
  const nose = new THREE.Mesh(
    new THREE.BoxGeometry(0.15, 0.15, 0.4),
    new THREE.MeshStandardMaterial({ color: 0x0b1020 }),
  )
  nose.position.set(0, 0.2, CHAR_RADIUS) // +z front
  nose.castShadow = true
  g.add(nose)
  stage.scene.add(g)
  return g
}
interface Rendered {
  group: THREE.Group
  facing: number
  last: Vec3
  label?: THREE.Sprite
  labelText?: string
}
const chars = new Map<EntityId, Rendered>()
const charFor = (id: EntityId, isSelf: boolean): Rendered => {
  let r = chars.get(id)
  if (r === undefined) {
    r = { group: makeCharacter(isSelf ? 0xfacc15 : 0xf97316), facing: 0, last: { x: 0, y: 0, z: 0 } }
    chars.set(id, r)
  }
  return r
}

// A billboard nametag above a character (a Sprite always faces the camera). Rebuilt
// only when the name changes.
const makeNameLabel = (text: string): THREE.Sprite => {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.font = 'bold 32px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const w = Math.min(248, ctx.measureText(text).width + 24)
  ctx.fillStyle = 'rgba(11,16,32,0.6)'
  ctx.fillRect(128 - w / 2, 10, w, 44)
  ctx.fillStyle = '#e5e7eb'
  ctx.fillText(text, 128, 32)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace // canvas pixels are sRGB — decode them correctly
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false, // draw over the world
      depthWrite: false, // ...and stay out of the depth buffer GTAO reads (was a dark AO ghost)
      toneMapped: false, // in-world UI, not a lit surface — keep it out of ACES tone mapping
    }),
  )
  sprite.scale.set(2, 0.5, 1)
  sprite.position.set(0, CHAR_HALF_HEIGHT + CHAR_RADIUS + 0.5, 0)
  sprite.renderOrder = 999
  sprite.layers.set(OVERLAY_LAYER) // excluded from the world/post-FX pipeline; drawn in the overlay pass
  return sprite
}
const setLabel = (r: Rendered, name: string): void => {
  if (r.labelText === name) return
  if (r.label !== undefined) {
    r.group.remove(r.label)
    r.label.material.map?.dispose()
    r.label.material.dispose()
  }
  r.label = makeNameLabel(name)
  r.labelText = name
  r.group.add(r.label)
}
// Place a character, easing its facing toward `yaw` (or its movement dir if yaw is null).
const placeChar = (r: Rendered, p: Vec3, yaw: number | null): void => {
  r.group.position.set(p.x, p.y, p.z)
  const target = yaw ?? facingFromDelta(r, p)
  if (target !== null) r.facing = easeAngle(r.facing, target, 0.25)
  r.group.rotation.y = r.facing
  r.last = { x: p.x, y: p.y, z: p.z }
}
const facingFromDelta = (r: Rendered, p: Vec3): number | null => {
  const dx = p.x - r.last.x
  const dz = p.z - r.last.z
  return dx * dx + dz * dz > 1e-5 ? Math.atan2(dx, dz) : null
}
const easeAngle = (from: number, to: number, t: number): number => {
  let d = ((to - from + Math.PI) % (Math.PI * 2)) - Math.PI
  if (d < -Math.PI) d += Math.PI * 2
  return from + d * t
}

// --- camera orbit (mouselook via pointer lock) ---
const camera = stage.camera
let camYaw = 0
let camPitch = 0.35
const params = {
  camDistance: 7,
  sensitivity: 0.0025,
}
canvas.addEventListener('click', () => {
  if (document.pointerLockElement !== canvas) void canvas.requestPointerLock()
})
window.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return
  camYaw -= e.movementX * params.sensitivity
  camPitch = clamp(camPitch + e.movementY * params.sensitivity, -0.2, 1.2)
})

// --- input --- (physical key codes: layout-independent)
const keys = new Set<string>()
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault()
  keys.add(e.code)
})
window.addEventListener('keyup', (e) => keys.delete(e.code))
// Camera-relative world-space move direction from WASD/arrows (+ current camera yaw).
const worldMove = (): { x: number; z: number } => {
  const { x: rawX, z: rawZ } = keysToMovement(keys)
  if (rawX === 0 && rawZ === 0) return { x: 0, z: 0 }
  const fwdX = -Math.sin(camYaw)
  const fwdZ = -Math.cos(camYaw)
  const rightX = -fwdZ
  const rightZ = fwdX
  let x = fwdX * -rawZ + rightX * rawX
  let z = fwdZ * -rawZ + rightZ * rawX
  const len = Math.hypot(x, z)
  if (len > 1) {
    x /= len
    z /= len
  }
  return { x, z }
}

// --- debug pane ---
const pane = new Pane({ title: 'Debug' })
const cam = pane.addFolder({ title: 'Camera' })
cam.addBinding(params, 'camDistance', { min: 3, max: 14, step: 0.5, label: 'distance' })
cam.addBinding(params, 'sensitivity', { min: 0.0005, max: 0.006, step: 0.0005, label: 'sensitivity' })

// Live locomotion feel (client-authoritative, so tuning is purely local — ADR 0011/0012).
const tuning: CharacterTuning = { ...DEFAULT_TUNING }
const mv = pane.addFolder({ title: 'Movement (Roblox-like)' })
mv.addBinding(tuning, 'moveSpeed', { min: 1, max: 12, step: 0.1, label: 'speed m/s' })
mv.addBinding(tuning, 'jumpHeight', { min: 0.5, max: 5, step: 0.1, label: 'jump apex m' })
mv.addBinding(tuning, 'gravity', { min: 10, max: 100, step: 1, label: 'gravity m/s²' })
mv.addBinding(tuning, 'groundAccelTime', { min: 0, max: 0.5, step: 0.01, label: 'accel s' })
mv.addBinding(tuning, 'groundStopTime', { min: 0, max: 0.5, step: 0.01, label: 'stop s' })
mv.addBinding(tuning, 'airControl', { min: 0, max: 1, step: 0.05, label: 'air control' })

// Live render tuning (content C3) — the greybox polish is data, so you can dial it here.
const renderParams = { exposure: 1.0, bloom: true, bloomStrength: 0.3 }
const rp = pane.addFolder({ title: 'Render (greybox C3)' })
rp.addBinding(renderParams, 'exposure', { min: 0.4, max: 2, step: 0.05 }).on('change', (e) => {
  stage.renderer.toneMappingExposure = e.value
})
rp.addBinding(renderParams, 'bloom').on('change', (e) => {
  postfx.bloom.enabled = e.value
})
rp.addBinding(renderParams, 'bloomStrength', { min: 0, max: 1.5, step: 0.05, label: 'bloom str' }).on('change', (e) => {
  postfx.bloom.strength = e.value
})

// --- netcode (Colyseus rooms, ADR 0013) ---
const clock = createClockSync()
const reassembler = createSnapshotReassembler()
const interp = createSnapshotClient({ interpolationDelayMs: 100, serverNow: () => clock.serverNow() })
let myId: EntityId | null = null
let controller: LocalController | null = null
let ownFacing = 0
let room: Room | null = null
let loaded: LoadedLevel | null = null // the instantiated level (colliders + markers + visuals)
let levelView: LevelView | null = null // Three meshes for the level; sync() re-poses moving pieces
const names = new Map<EntityId, string>() // peer id -> display name (from ROSTER)

// Auto-assigned random display name (player-chosen names come later — ADR 0013).
const ADJ = ['Swift', 'Brave', 'Calm', 'Lucky', 'Sly', 'Bold', 'Keen', 'Wily']
const NOUN = ['Fox', 'Otter', 'Hawk', 'Wolf', 'Lynx', 'Crow', 'Bear', 'Mole']
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)]!
const myName = `${pick(ADJ)} ${pick(NOUN)}`
// Colyseus onMessage hands us a Uint8Array view; our codecs take a standalone ArrayBuffer.
const toArrayBuffer = (m: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(m.byteLength)
  copy.set(m)
  return copy.buffer
}

const CHECKPOINT_KEY = 'parkour.checkpoint'

const initLocalSim = async (id: EntityId): Promise<void> => {
  await initPhysics()
  // Client-owned world (ADR 0011): gravity is integrated by the character, not Rapier.
  // The loader adds the level's colliders (data-driven, ADR 0013).
  const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
  loaded = instantiateLevel(world, validateLevel(showcase))

  // Build the level's greybox meshes via the shared renderer (content C3). Marker pads are
  // just their (colour-coded) box here; radius/overlay visualization belongs in the viewer.
  levelView = addLevel(stage.scene, loaded.visuals)
  // Gameplay triggers are the pads' own colliders (content C5 seam): the engine reports
  // real contact via char.body.collisions() — no distance heuristics.
  const checkpointTriggers = loaded.triggers.filter((t) => t.kind === 'checkpoint')
  const hazardHandles = new Set(loaded.triggers.filter((t) => t.kind === 'hazard').map((t) => t.colliderHandle))
  const { fallBehavior, fallY } = loaded.config

  // Markers sit on a surface; the capsule's *centre* must clear it by its stand height so
  // the player rests on top rather than sinking in.
  const STAND_OFFSET = CHAR_HALF_HEIGHT + CHAR_RADIUS

  // Spawn: last checkpoint touched (persisted), else the level's spawn marker (spread a
  // little by id so players don't stack), else a fallback.
  const spawnMarker = loaded.markers.find((m) => m.kind === 'spawn')?.position
  const saved = Number(localStorage.getItem(CHECKPOINT_KEY))
  const a = id * 2.399963
  const cp =
    Number.isInteger(saved) && saved >= 0 && saved < checkpointTriggers.length ? checkpointTriggers[saved]!.position : undefined
  const spawn =
    cp !== undefined
      ? { x: cp.x, y: cp.y + STAND_OFFSET, z: cp.z }
      : spawnMarker !== undefined
        ? { x: spawnMarker.x + Math.cos(a) * 2, y: spawnMarker.y + STAND_OFFSET, z: spawnMarker.z + Math.sin(a) * 2 }
        : playerSpawn(id)
  const char: CharacterState = addCharacter(world, spawn)

  // Respawn: teleport to the last checkpoint (or spawn) and kill momentum. Triggered by
  // touching a hazard pad or falling below the level's kill plane (mode config).
  let respawnPos: Vec3 = { ...spawn }
  const respawn = (): void => {
    char.body.setPosition(respawnPos)
    char.vx = 0
    char.vy = 0
    char.vz = 0
    char.grounded = false
  }

  // This local sim IS the truth for our own character (client-authoritative, ADR 0011).
  const local: LocalWorld = {
    applyInput: (cmd) => {
      stepCharacter(char, cmd, TICK_DT, tuning)
      world.step(TICK_DT)
    },
    readState: () => new Map<EntityId, Vec3>([[id, char.body.translation()]]),
  }
  controller = createLocalController({ world: local, tickRateHz: TICK_RATE_HZ })

  // Remote players mirrored as kinematic capsules so walking into one collides locally.
  const remotes = new Map<EntityId, PhysicsBody>()
  const syncRemotes = (): void => {
    const seen = new Set<EntityId>()
    for (const e of interp.sample()) {
      if (e.id === id) continue
      seen.add(e.id)
      let mirror = remotes.get(e.id)
      if (mirror === undefined) {
        mirror = world.addKinematicBody({
          position: e.position,
          shape: { kind: 'capsule', halfHeight: CHAR_HALF_HEIGHT, radius: CHAR_RADIUS },
        })
        remotes.set(e.id, mirror)
      }
      mirror.setNextKinematicTranslation(e.position)
    }
    for (const [rid, mirror] of remotes)
      if (!seen.has(rid)) {
        mirror.remove()
        remotes.delete(rid)
      }
  }

  startFixedLoop({
    tickRateHz: TICK_RATE_HZ,
    onTick: () => {
      syncRemotes()
      const move = worldMove()
      if (move.x !== 0 || move.z !== 0) ownFacing = Math.atan2(move.x, move.z)
      controller!.step(move.x, move.z, keys.has('Space'))
      const p = controller!.state().get(id)
      if (p) {
        room?.sendBytes(NET_CHANNEL, new Uint8Array(encodeState(p)))
        // Real contact: the colliders the capsule pushed against this tick.
        const hits = new Set(char.body.collisions())
        // Checkpoint touched → it becomes the respawn point (persisted).
        for (let i = 0; i < checkpointTriggers.length; i++) {
          const t = checkpointTriggers[i]!
          if (hits.has(t.colliderHandle)) {
            localStorage.setItem(CHECKPOINT_KEY, String(i))
            respawnPos = { x: t.position.x, y: t.position.y + STAND_OFFSET, z: t.position.z }
            break
          }
        }
        // Hazard touched (any side), or fell below the kill plane → respawn.
        const hitHazard = [...hits].some((h) => hazardHandles.has(h))
        if (hitHazard || (fallBehavior === 'respawn-checkpoint' && p.y < fallY)) respawn()
      }
    },
  })
}

const onNet = (m: Uint8Array): void => {
  const buf = toArrayBuffer(m)
  switch (readMessageType(buf)) {
    case MSG_WELCOME:
      myId = decodeWelcome(buf).playerId
      void initLocalSim(myId)
      break
    case MSG_SNAPSHOT:
      // Peers only (the server never relays our own body back to us); interpolate.
      interp.ingest(reassembler.apply(decodeSnapshot(buf)))
      break
    case MSG_ROSTER:
      names.clear()
      for (const e of decodeRoster(buf)) names.set(e.id, e.name)
      break
    case MSG_PONG: {
      const pong = decodePong(buf)
      clock.recordSample(pong.clientTimeMs, pong.serverTimeMs, performance.now())
      break
    }
  }
}

// Colyseus matchmaking: joinOrCreate fills the most-full non-full room, else spins up a
// new one (auto-join, no matchmaking UI — ADR 0013). A raw WebSocket won't do; the SDK
// performs the HTTP seat reservation then upgrades.
const connect = async (): Promise<void> => {
  try {
    room = await new Client(SERVER_URL).joinOrCreate('parkour', { name: myName })
  } catch {
    statusEl.textContent = `couldn't join — is the server up? run 'pnpm dev:server' (${SERVER_URL})`
    return
  }
  statusEl.textContent = `connected: room ${room.roomId} — click to capture the mouse`
  room.onMessage(NET_CHANNEL, onNet)
  room.onLeave(() => {
    statusEl.textContent = `disconnected — run 'pnpm dev:server' (${SERVER_URL})`
  })
  setInterval(() => room?.sendBytes(NET_CHANNEL, new Uint8Array(encodePing({ clientTimeMs: performance.now() }))), 250)
}
void connect()

// --- render ---
let ownPos: Vec3 = { x: 0, y: 1, z: 0 }
stage.start(() => {
  // Advance clock-driven level pieces (moving platforms) on the synced clock — all
  // clients agree since it's a function of server time — and sync their meshes.
  if (loaded !== null) {
    loaded.update(clock.serverNow())
    levelView?.sync()
  }

  // Own character: our authoritative local sim, render-smoothed. Peers: interpolated.
  const seen = new Set<EntityId>()
  if (myId !== null && controller) {
    seen.add(myId)
    ownPos = controller.renderPositions().get(myId) ?? ownPos
    const self = charFor(myId, true)
    placeChar(self, ownPos, ownFacing)
    setLabel(self, myName)
  }
  for (const e of interp.sample())
    if (e.id !== myId) {
      seen.add(e.id)
      const r = charFor(e.id, false)
      placeChar(r, e.position, null)
      setLabel(r, names.get(e.id) ?? '…')
    }
  // Drop characters whose players left the room (no longer relayed).
  for (const [id, r] of chars)
    if (!seen.has(id)) {
      stage.scene.remove(r.group)
      chars.delete(id)
    }

  // orbit camera around the own character
  const target = { x: ownPos.x, y: ownPos.y + 1, z: ownPos.z }
  const cp = Math.cos(camPitch)
  camera.position.set(
    target.x + Math.sin(camYaw) * cp * params.camDistance,
    target.y + Math.sin(camPitch) * params.camDistance + 0.5,
    target.z + Math.cos(camYaw) * cp * params.camDistance,
  )
  camera.lookAt(target.x, target.y, target.z)
})

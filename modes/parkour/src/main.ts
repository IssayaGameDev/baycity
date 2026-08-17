import {
  createClockSync,
  createLocalController,
  createSnapshotClient,
  createSnapshotReassembler,
  keysToMovement,
  type LocalController,
  type LocalWorld,
} from '@mp/client'
import { clamp, createSimClock, startFixedLoop, type EntityId, type Vec3 } from '@mp/core'
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
  STATE_GROUNDED,
  STATE_RISING,
} from '@mp/net'
import { createPhysicsWorld, initPhysics, type PhysicsBody } from '@mp/physics'
import { createThreeStage, applyGreyboxEnvironment, createPostFX, addLevel, type LevelView } from '@mp/render-three'
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
import { getLocale, matchLocale, onLocaleChange, setLocale, t, type TranslationKey } from '@mp/i18n'
import { createUiOverlay, uiButton, type ListItem } from '@mp/render-pixi'
import { Client, type Room } from 'colyseus.js'
import { Pane } from 'tweakpane'

import { createCharacterViews } from './characterView'
import { OVERLAY_LAYER } from './nametag'
import { createPauseMenu } from './pauseMenu'
import { localParkourPersistence } from './persistence'
import { showcase } from './showcase'

// Relay endpoint. Defaults to the dev host on :9200. `?server=wss://host` overrides it, so a
// tunnelled page (served from a different origin than the relay) can point at its own relay URL.
const SERVER_URL = new URLSearchParams(location.search).get('server') ?? `ws://${location.hostname}:9200`

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!
const canvas = $<HTMLCanvasElement>('#view')
const statusEl = $<HTMLDivElement>('#status')
const hintEl = $<HTMLDivElement>('#hint')

// --- localization (ADR 0016) ---
// All player-facing text routes through i18n. The status line is state-driven, so re-render it
// (and the hint) on locale change. Detect the locale up front (stored override, else browser),
// and persist changes.
const LOCALE_KEY = 'mp.locale'
let statusMsg: { key: TranslationKey; params?: Record<string, string | number> } = { key: 'status.connecting' }
const renderStatus = (): void => {
  statusEl.textContent = t(statusMsg.key, statusMsg.params)
}
const setStatus = (key: TranslationKey, params?: Record<string, string | number>): void => {
  statusMsg = params !== undefined ? { key, params } : { key }
  renderStatus()
}
const renderHint = (): void => {
  hintEl.textContent = t('hint.controls')
}
try {
  setLocale(localStorage.getItem(LOCALE_KEY) ?? matchLocale(navigator.language))
} catch {
  setLocale(matchLocale(navigator.language))
}
onLocaleChange(() => {
  try {
    localStorage.setItem(LOCALE_KEY, getLocale())
  } catch {
    // best-effort persistence
  }
  renderStatus()
  renderHint()
})
renderStatus()
renderHint()

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
// them on top, free of AO and tone mapping (OVERLAY_LAYER — see nametag.ts).
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

// Player views (own + peers): capsule + facing-nose + billboard nametag. See characterView.ts.
const views = createCharacterViews(stage.scene)

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
// Own host element with an explicit stacking order: the Pixi UI canvas is at z-index 10, and
// with tweakpane's default wrapper the pause screen covered the pane — i.e. it was unreachable
// exactly when the mouse is free (during play the game holds pointer lock). Dev tooling stays
// on top of the game UI.
const paneHost = document.createElement('div')
paneHost.style.cssText = 'position:fixed;top:8px;right:8px;width:256px;z-index:100'
document.body.appendChild(paneHost)
const pane = new Pane({ title: 'Debug', container: paneHost })
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
let lastSimTickAt = 0 // wall-clock of the last fixed tick, for render-interpolating clock-driven pieces
let requestRespawn: (() => void) | null = null // set once the local sim exists; used by the pause menu's Restart
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

// Per-player state behind a pluggable adapter (mode seam): local now, account-backed later.
const persistence = localParkourPersistence()

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
  const playerState = persistence.load()
  const a = id * 2.399963
  const cp =
    playerState.checkpoint >= 0 && playerState.checkpoint < checkpointTriggers.length
      ? checkpointTriggers[playerState.checkpoint]!.position
      : undefined
  const spawn =
    cp !== undefined
      ? { x: cp.x, y: cp.y + STAND_OFFSET, z: cp.z }
      : spawnMarker !== undefined
        ? { x: spawnMarker.x + Math.cos(a) * 2, y: spawnMarker.y + STAND_OFFSET, z: spawnMarker.z + Math.sin(a) * 2 }
        : playerSpawn(id)
  const char: CharacterState = addCharacter(world, spawn)
  ownState = char // the render loop reads velocity/grounded straight off the sim for our own rig

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
  requestRespawn = respawn // let the pause menu's Restart reach it

  // This local sim IS the truth for our own character (client-authoritative, ADR 0011).
  // Clock-driven pieces advance one fixed step per fixed step, tracking the synced server
  // clock by slewing. Reading `serverNow()` directly here would stall the platforms whenever
  // the loop runs several ticks in one wake, while the character kept advancing a full step
  // each — the platform-carry jitter (see @mp/core simClock).
  const simClock = createSimClock({ tickMs: TICK_DT * 1000, reference: () => clock.serverNow() })

  const local: LocalWorld = {
    applyInput: (cmd) => {
      // Two-phase step so the character resolves against the platforms' CURRENT positions,
      // not last tick's: (A) advance clock-driven pieces on the synced clock and step so they
      // move, (B) step the character against them — the controller's depenetration + snap-to-
      // ground then carry it up a rising platform and push it off a sweeping bar.
      // The piece we are riding is posed without velocity so only our own carry moves us; every
      // other piece keeps its velocity so it can still shove us (the spinning bar). See the loader.
      loaded?.update(simClock.tick(), char.base?.colliderHandle)
      world.step(TICK_DT) // (A) platforms move
      stepCharacter(char, cmd, TICK_DT, tuning, loaded?.basePose) // rides whatever it stands on
      world.step(TICK_DT) // (B) character resolves against the moved platforms
      lastSimTickAt = performance.now()
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
        // Position plus the animation bits a viewer cannot derive from it (v8): vertical velocity
        // passes through zero at every jump apex, so "grounded" has to be told, not inferred.
        const flags = (char.grounded ? STATE_GROUNDED : 0) | (char.vy > 0 ? STATE_RISING : 0)
        room?.sendBytes(NET_CHANNEL, new Uint8Array(encodeState({ position: p, flags })))
        // Real contact: the colliders the capsule pushed against this tick.
        const hits = new Set(char.body.collisions())
        // Checkpoint touched → it becomes the respawn point (persisted). Progress only
        // advances: touching an earlier checkpoint never lowers your saved index.
        for (let i = 0; i < checkpointTriggers.length; i++) {
          const t = checkpointTriggers[i]!
          if (hits.has(t.colliderHandle) && i > playerState.checkpoint) {
            playerState.checkpoint = i
            persistence.save(playerState)
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
    setStatus('status.offline')
    return
  }
  setStatus('status.room', { room: room.roomId })
  room.onMessage(NET_CHANNEL, onNet)
  room.onLeave(() => {
    setStatus('status.offline')
  })
  setInterval(() => room?.sendBytes(NET_CHANNEL, new Uint8Array(encodePing({ clientTimeMs: performance.now() }))), 250)
}
void connect()

// --- render ---
let ownPos: Vec3 = { x: 0, y: 1, z: 0 }
let ownState: CharacterState | null = null // set once the local sim exists; drives our own animation
let lastFrameAt = performance.now()
stage.start(() => {
  // Animation is evaluated per rendered frame, not per sim tick, so it is smooth at any refresh
  // rate; everything it drives is smoothed by half-life rather than per-frame fraction.
  const nowMs = performance.now()
  const frameDt = Math.min(0.1, (nowMs - lastFrameAt) / 1000)
  lastFrameAt = nowMs
  // Clock-driven pieces advance in the fixed sim loop; here we only render-interpolate
  // their meshes between the last two ticks (same timeline as the player), then sync.
  if (loaded !== null) {
    const alpha = clamp((performance.now() - lastSimTickAt) / (1000 / TICK_RATE_HZ), 0, 1)
    loaded.render(alpha)
    levelView?.sync()
  }

  // Own character: our authoritative local sim, render-smoothed. Peers: interpolated.
  const seen = new Set<EntityId>()
  if (myId !== null && controller) {
    seen.add(myId)
    ownPos = controller.renderPositions().get(myId) ?? ownPos
    // Our own inputs are exact — we own the sim — so nothing is derived for us.
    views.upsert(
      myId,
      {
        isSelf: true,
        position: ownPos,
        yaw: ownFacing,
        speed: ownState !== null ? Math.hypot(ownState.vx, ownState.vz) : 0,
        grounded: ownState?.grounded ?? true,
        rising: (ownState?.vy ?? 0) > 0,
        name: myName,
      },
      frameDt,
    )
  }
  for (const e of interp.sample())
    if (e.id !== myId) {
      seen.add(e.id)
      // Peers: facing and speed derived from the interpolated position; grounded/rising off the
      // wire, because vertical velocity cannot tell standing from a jump apex.
      views.upsert(
        e.id,
        {
          isSelf: false,
          position: e.position,
          yaw: null,
          speed: null,
          grounded: (e.flags & STATE_GROUNDED) !== 0,
          rising: (e.flags & STATE_RISING) !== 0,
          name: names.get(e.id) ?? '…',
        },
        frameDt,
      )
    }
  views.prune(seen) // drop players who left the room (no longer relayed)

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

// --- pause screen (Pixi UI, ADR 0015) ---
// A transparent Pixi canvas stacked over the Three canvas. The pause screen composition
// lives in pauseMenu.ts; this wires it to the game (params, roster, respawn) and manages the
// pointer-lock handoff.
const ui = await createUiOverlay({ width: window.innerWidth, height: window.innerHeight })
ui.canvas.style.position = 'fixed'
ui.canvas.style.inset = '0'
ui.canvas.style.zIndex = '10'
document.body.appendChild(ui.canvas)

const SENS_MIN = 0.0005
const SENS_MAX = 0.006

const pause = createPauseMenu(ui, {
  onResume: () => resumePlay(),
  onRestart: () => {
    requestRespawn?.()
    resumePlay()
  },
  sensitivity: {
    get: () => (params.sensitivity - SENS_MIN) / (SENS_MAX - SENS_MIN),
    set: (t) => {
      params.sensitivity = SENS_MIN + t * (SENS_MAX - SENS_MIN)
    },
  },
  players: () => {
    const items: ListItem[] = [{ text: t('pause.self', { name: myName }), highlight: true }]
    for (const [pid, name] of names) if (pid !== myId) items.push({ text: name })
    return items
  },
})

const resumePlay = (): void => {
  pause.close()
  void canvas.requestPointerLock()
}

// Pointer-lock drives pause state: releasing it (Esc / focus loss) opens the menu; re-locking
// closes it. Tapping empty overlay space (menu closed) re-captures the mouse for look control.
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas) pause.close()
  else pause.open()
})
ui.setBackgroundTap(() => {
  if (!pause.isOpen()) void canvas.requestPointerLock()
})

// Top-left pause button (placeholder glyph until skinned). During locked play the cursor is
// hidden, so this is clickable when free; Esc is the primary open while playing.
const pauseBtn = uiButton({
  label: 'II',
  width: 44,
  height: 40,
  color: 0x475569,
  onClick: () => {
    if (document.pointerLockElement === canvas) document.exitPointerLock()
    else pause.open()
  },
})
pauseBtn.view.position.set(16, 16)
ui.root.addChild(pauseBtn.view)

window.addEventListener('resize', () => {
  ui.resize(window.innerWidth, window.innerHeight)
  pauseBtn.view.position.set(16, 16)
  pause.layout()
})

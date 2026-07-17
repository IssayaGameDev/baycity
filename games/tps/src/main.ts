import {
  createClockSync,
  createPredictor,
  createSnapshotClient,
  createSnapshotReassembler,
  createWebSocketClientTransport,
  keysToMovement,
  type PredictedWorld,
  type Predictor,
} from '@mp/client'
import { clamp, startFixedLoop, type EntityId, type Vec3 } from '@mp/core'
import {
  decodePong,
  decodeSnapshot,
  decodeWelcome,
  encodeInput,
  encodePing,
  MSG_PONG,
  MSG_SNAPSHOT,
  MSG_WELCOME,
  readMessageType,
} from '@mp/net'
import { createNetsimClientTransport } from '@mp/netsim'
import { initPhysics, type PhysicsBody } from '@mp/physics'
import { THREE, createThreeStage } from '@mp/render-three'
import {
  addCharacter,
  CHAR_HALF_HEIGHT,
  CHAR_RADIUS,
  createTpsWorld,
  GROUND,
  playerSpawn,
  stepCharacter,
  TICK_DT,
  TICK_RATE_HZ,
  TPS_OBSTACLES,
  type CharacterState,
} from '@mp/server/tps'
import { Pane } from 'tweakpane'

const SERVER_URL = `ws://${location.hostname}:9200`

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!
const canvas = $<HTMLCanvasElement>('#view')
const statusEl = $<HTMLDivElement>('#status')

// --- scene ---
const stage = createThreeStage({ canvas, cameraPosition: [0, 6, 10], lookAt: [0, 1, 0] })
stage.scene.add(new THREE.AmbientLight(0xffffff, 0.6))
const sun = new THREE.DirectionalLight(0xffffff, 1.2)
sun.position.set(10, 20, 10)
stage.scene.add(sun)

const boxMesh = (b: { position: Vec3; halfExtents: Vec3 }, color: number): void => {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(b.halfExtents.x * 2, b.halfExtents.y * 2, b.halfExtents.z * 2),
    new THREE.MeshStandardMaterial({ color }),
  )
  m.position.set(b.position.x, b.position.y, b.position.z)
  stage.scene.add(m)
}
boxMesh(GROUND, 0x1e293b)
for (const o of TPS_OBSTACLES) boxMesh(o, 0x334155)

// A character: capsule + a "nose" so facing is visible.
const charGeo = new THREE.CapsuleGeometry(CHAR_RADIUS, CHAR_HALF_HEIGHT * 2, 6, 16)
const makeCharacter = (color: number): THREE.Group => {
  const g = new THREE.Group()
  g.add(new THREE.Mesh(charGeo, new THREE.MeshStandardMaterial({ color })))
  const nose = new THREE.Mesh(
    new THREE.BoxGeometry(0.15, 0.15, 0.4),
    new THREE.MeshStandardMaterial({ color: 0x0b1020 }),
  )
  nose.position.set(0, 0.2, CHAR_RADIUS) // +z front
  g.add(nose)
  stage.scene.add(g)
  return g
}
interface Rendered {
  group: THREE.Group
  facing: number
  last: Vec3
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
  latency: 40,
  loss: 0,
  prediction: true,
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
const net = pane.addFolder({ title: 'Network' })
net.addBinding(params, 'latency', { min: 0, max: 250, step: 1, label: 'latency ms (1-way)' })
net.addBinding(params, 'loss', { min: 0, max: 30, step: 1, label: 'loss %' })
net.addBinding(params, 'prediction', { label: 'prediction' })
const cam = pane.addFolder({ title: 'Camera' })
cam.addBinding(params, 'camDistance', { min: 3, max: 14, step: 0.5, label: 'distance' })
cam.addBinding(params, 'sensitivity', { min: 0.0005, max: 0.006, step: 0.0005, label: 'sensitivity' })

// --- netcode ---
const transport = createNetsimClientTransport(createWebSocketClientTransport(SERVER_URL), {
  latencyMs: params.latency,
  jitterMs: 10,
  lossRate: params.loss / 100,
})
net.on('change', () => transport.setConditions({ latencyMs: params.latency, jitterMs: 10, lossRate: params.loss / 100 }))
const clock = createClockSync()
const reassembler = createSnapshotReassembler()
const interp = createSnapshotClient({ interpolationDelayMs: 100, serverNow: () => clock.serverNow() })
let myId: EntityId | null = null
let predictor: Predictor | null = null
let ownFacing = 0

const initPrediction = async (id: EntityId): Promise<void> => {
  await initPhysics()
  const world = createTpsWorld()
  const char: CharacterState = addCharacter(world, playerSpawn(id))
  const predicted: PredictedWorld<{ vy: number; grounded: boolean }> = {
    applyInput: (cmd) => {
      stepCharacter(char, cmd, TICK_DT)
      world.step(TICK_DT)
    },
    readState: () => new Map<EntityId, Vec3>([[id, char.body.translation()]]),
    restore: (state) => {
      const p = state.get(id)
      if (p) char.body.setPosition(p)
    },
    // vy/grounded live outside the body; without rolling them back the replay
    // re-integrates gravity from the latest tick and the jump arc jitters.
    saveAux: () => ({ vy: char.vy, grounded: char.grounded }),
    restoreAux: (aux) => {
      char.vy = aux.vy
      char.grounded = aux.grounded
    },
  }
  predictor = createPredictor({ world: predicted, tickRateHz: TICK_RATE_HZ, correctionSmoothingMs: 100 })

  // Remote players mirrored into the predicted world as kinematic capsules (same
  // shape the server collides against), so walking into a player is predicted
  // instead of corrected. Positions come from interpolation (~100 ms past) — for
  // moving remotes the contact point differs slightly from the server's; the
  // reconciliation correction absorbs it.
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
      transport.send(encodeInput(predictor!.predict(move.x, move.z, keys.has('Space'))))
    },
  })
}

transport.onOpen(() => {
  statusEl.textContent = `connected: ${SERVER_URL} — click to capture the mouse`
  setInterval(() => transport.send(encodePing({ clientTimeMs: performance.now() })), 250)
})
transport.onClose(() => {
  statusEl.textContent = `disconnected — run 'pnpm dev:server:tps' (${SERVER_URL})`
})
transport.onMessage((data) => {
  switch (readMessageType(data)) {
    case MSG_WELCOME:
      myId = decodeWelcome(data).playerId
      void initPrediction(myId)
      break
    case MSG_SNAPSHOT: {
      const snap = reassembler.apply(decodeSnapshot(data))
      if (myId !== null && predictor) {
        const me = snap.entities.find((e) => e.id === myId)
        if (me) predictor.reconcile(new Map([[myId, me.position]]), snap.lastProcessedInputSeq)
      }
      interp.ingest(snap)
      break
    }
    case MSG_PONG: {
      const pong = decodePong(data)
      clock.recordSample(pong.clientTimeMs, pong.serverTimeMs, performance.now())
      break
    }
  }
})

// --- render ---
let ownPos: Vec3 = { x: 0, y: 1, z: 0 }
stage.start(() => {
  if (myId !== null && predictor && params.prediction) {
    ownPos = predictor.renderPositions().get(myId) ?? ownPos
    placeChar(charFor(myId, true), ownPos, ownFacing)
    for (const e of interp.sample()) if (e.id !== myId) placeChar(charFor(e.id, false), e.position, null)
  } else {
    for (const e of interp.sample()) {
      if (e.id === myId) ownPos = e.position
      placeChar(charFor(e.id, e.id === myId), e.position, e.id === myId ? ownFacing : null)
    }
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

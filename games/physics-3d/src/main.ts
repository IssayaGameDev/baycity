import {
  createPredictor,
  createSnapshotClient,
  createWebSocketClientTransport,
  type PredictedWorld,
  type Predictor,
} from '@mp/client'
import { startFixedLoop, type EntityId, type Vec3 } from '@mp/core'
import { decodeSnapshot, decodeWelcome, encodeInput, MSG_SNAPSHOT, MSG_WELCOME, readMessageType } from '@mp/net'
import { createNetsimClientTransport } from '@mp/netsim'
import { createPhysicsWorld, initPhysics, type PhysicsBody } from '@mp/physics'
import { THREE, createThreeStage } from '@mp/render-three'
import {
  addBalls,
  addGround,
  addPlayerBody,
  applyPlayerInput,
  GRAVITY,
  isBallId,
  PLAYER_RADIUS,
  playerSpawn,
  TICK_DT,
  TICK_RATE_HZ,
} from '@mp/server/sim'
import { Pane } from 'tweakpane'

const SERVER_URL = `ws://${location.hostname}:9200`

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!
const canvas = $<HTMLCanvasElement>('#view')
const statusEl = $<HTMLDivElement>('#status')

// --- scene (game-owned content) ---
const stage = createThreeStage({ canvas, cameraPosition: [0, 12, 20], lookAt: [0, 1, 0] })
stage.scene.add(new THREE.AmbientLight(0xffffff, 0.6))
const sun = new THREE.DirectionalLight(0xffffff, 1.2)
sun.position.set(10, 20, 10)
stage.scene.add(sun)
stage.scene.add(new THREE.Mesh(new THREE.BoxGeometry(40, 0.2, 40), new THREE.MeshStandardMaterial({ color: 0x1e293b })))

const sphereGeo = new THREE.SphereGeometry(PLAYER_RADIUS, 24, 16)
const meshes = new Map<EntityId, THREE.Mesh>()
const place = (id: EntityId, isSelf: boolean, p: Vec3): void => {
  let m = meshes.get(id)
  if (m === undefined) {
    const color = isSelf ? 0xfacc15 : isBallId(id) ? 0x4fd1c5 : 0xf97316
    m = new THREE.Mesh(sphereGeo, new THREE.MeshStandardMaterial({ color }))
    stage.scene.add(m)
    meshes.set(id, m)
  }
  m.position.set(p.x, p.y, p.z)
}

// --- input ---
const keys = new Set<string>()
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase()
  if (k.startsWith('arrow')) e.preventDefault()
  keys.add(k)
})
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()))
const sampleMove = (): { x: number; z: number } => ({
  x: (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0),
  z: (keys.has('s') || keys.has('arrowdown') ? 1 : 0) - (keys.has('w') || keys.has('arrowup') ? 1 : 0),
})

// --- debug pane (Tweakpane) ---
// interpDelay / correction are DESIGN sliders (game feel) — tune them by feel here.
const params = {
  latency: 80, // one-way ms (netsim)
  jitter: 20, // ms
  loss: 3, // %
  prediction: true,
  interpDelay: 100, // ms — how far in the past remotes render
  correction: 100, // ms — how fast a reconciliation correction eases in
  pending: 0, // readonly monitor
}
const pane = new Pane({ title: 'Debug' })
const net = pane.addFolder({ title: 'Network' })
net.addBinding(params, 'latency', { min: 0, max: 250, step: 1, label: 'latency ms (1-way)' })
net.addBinding(params, 'jitter', { min: 0, max: 100, step: 1, label: 'jitter ms' })
net.addBinding(params, 'loss', { min: 0, max: 30, step: 1, label: 'loss %' })
net.addBinding(params, 'prediction', { label: 'prediction' })
net.addBinding(params, 'interpDelay', { min: 0, max: 300, step: 5, label: 'interp delay ms' })
net.addBinding(params, 'correction', { min: 10, max: 400, step: 5, label: 'correction ms' })
const pendingMonitor = net.addBinding(params, 'pending', { readonly: true, label: 'pending inputs' })

// --- transport (through the network simulator) ---
const transport = createNetsimClientTransport(createWebSocketClientTransport(SERVER_URL), {
  latencyMs: params.latency,
  jitterMs: params.jitter,
  lossRate: params.loss / 100,
})

// --- netcode ---
const interp = createSnapshotClient({ interpolationDelayMs: params.interpDelay })
let myId: EntityId | null = null
let predictor: Predictor | null = null

const applyNet = (): void => {
  transport.setConditions({ latencyMs: params.latency, jitterMs: params.jitter, lossRate: params.loss / 100 })
  interp.setInterpolationDelayMs(params.interpDelay)
  predictor?.setCorrectionSmoothingMs(params.correction)
}
net.on('change', applyNet)

// A predicted entity is the local player or a ball; remote players are not predicted.
const isPredicted = (id: EntityId): boolean => id === myId || isBallId(id)

const initPrediction = async (id: EntityId): Promise<void> => {
  await initPhysics()
  const world = createPhysicsWorld({ gravity: GRAVITY })
  addGround(world)
  const playerBody = addPlayerBody(world, playerSpawn(id))
  const balls = addBalls(world)

  // Predict the local player AND the balls (pulled into the loop, SEED §4) so
  // pushing is instant. Remote players can't be predicted — kinematic obstacles.
  const predicted: PredictedWorld = {
    applyInput: (cmd) => {
      applyPlayerInput(playerBody, cmd)
      world.step(TICK_DT)
    },
    readState: () => {
      const s = new Map<EntityId, Vec3>()
      s.set(id, playerBody.translation())
      for (const b of balls) s.set(b.id, b.body.translation())
      return s
    },
    restore: (state) => {
      const pp = state.get(id)
      if (pp) playerBody.teleport(pp)
      for (const b of balls) {
        const bp = state.get(b.id)
        if (bp) b.body.teleport(bp)
      }
    },
  }
  predictor = createPredictor({ world: predicted, tickRateHz: TICK_RATE_HZ, correctionSmoothingMs: params.correction })
  applyNet()

  const remotes = new Map<EntityId, PhysicsBody>()
  const syncRemotes = (): void => {
    for (const e of interp.sample()) {
      if (isPredicted(e.id)) continue
      let obstacle = remotes.get(e.id)
      if (obstacle === undefined) {
        obstacle = world.addKinematicBody({ position: e.position, shape: { kind: 'ball', radius: PLAYER_RADIUS } })
        remotes.set(e.id, obstacle)
      }
      obstacle.setNextKinematicTranslation(e.position)
    }
  }

  startFixedLoop({
    tickRateHz: TICK_RATE_HZ,
    onTick: () => {
      syncRemotes()
      const move = sampleMove()
      transport.send(encodeInput(predictor!.predict(move.x, move.z)))
    },
  })
}

transport.onOpen(() => {
  statusEl.textContent = `connected: ${SERVER_URL}`
})
transport.onClose(() => {
  statusEl.textContent = `disconnected — run 'pnpm dev:server' (${SERVER_URL})`
})
transport.onMessage((data) => {
  const type = readMessageType(data)
  if (type === MSG_WELCOME) {
    myId = decodeWelcome(data).playerId
    void initPrediction(myId)
  } else if (type === MSG_SNAPSHOT) {
    const snap = decodeSnapshot(data)
    if (myId !== null && predictor) {
      const authoritative = new Map<EntityId, Vec3>()
      for (const e of snap.entities) if (isPredicted(e.id)) authoritative.set(e.id, e.position)
      predictor.reconcile(authoritative, snap.lastProcessedInputSeq)
    }
    interp.ingest(snap)
  }
})

// --- render ---
stage.start(() => {
  if (myId !== null && predictor && params.prediction) {
    for (const [id, pos] of predictor.renderPositions()) place(id, id === myId, pos)
    for (const e of interp.sample()) if (!isPredicted(e.id)) place(e.id, false, e.position)
    params.pending = predictor.pendingInputs()
  } else {
    for (const e of interp.sample()) place(e.id, e.id === myId, e.position)
    params.pending = 0
  }
  pendingMonitor.refresh()
})

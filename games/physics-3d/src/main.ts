import {
  createClockSync,
  createPredictor,
  createSnapshotClient,
  createSnapshotReassembler,
  createWebSocketClientTransport,
  type PredictedWorld,
  type Predictor,
} from '@mp/client'
import { createBrowserInput } from '@mp/client/dom'
import { startFixedLoop, type EntityId, type Vec3 } from '@mp/core'
import {
  decodeHit,
  decodePong,
  decodeSnapshot,
  decodeWelcome,
  encodeFire,
  encodeInput,
  encodePing,
  MSG_HIT,
  MSG_PONG,
  MSG_SNAPSHOT,
  MSG_WELCOME,
  readMessageType,
} from '@mp/net'
import { createNetsimClientTransport } from '@mp/netsim'
import { createPhysicsWorld, initPhysics, type PhysicsBody } from '@mp/physics'
import { createHud } from '@mp/render-pixi'
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
const stageEl = $<HTMLDivElement>('#stage')
const joystickZone = $<HTMLDivElement>('#joystick')

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
const flash = (id: EntityId): void => {
  const m = meshes.get(id)
  if (m === undefined) return
  const mat = m.material as THREE.MeshStandardMaterial
  mat.emissive.setHex(0xff2d2d)
  setTimeout(() => mat.emissive.setHex(0x000000), 200)
}

// --- input (keyboard + touch joystick behind one interface) ---
const input = createBrowserInput(joystickZone)

// --- HUD (PixiJS, stacked over the Three canvas) ---
const hud = await createHud({ width: canvas.width, height: canvas.height })
hud.canvas.className = 'hud'
stageEl.appendChild(hud.canvas)

// --- debug pane (Tweakpane) ---
const params = {
  latency: 80,
  jitter: 20,
  loss: 3,
  prediction: true,
  interpDelay: 100,
  correction: 100,
  lagComp: true,
  pending: 0,
  rtt: 0,
}
const pane = new Pane({ title: 'Debug' })
const net = pane.addFolder({ title: 'Network' })
net.addBinding(params, 'latency', { min: 0, max: 250, step: 1, label: 'latency ms (1-way)' })
net.addBinding(params, 'jitter', { min: 0, max: 100, step: 1, label: 'jitter ms' })
net.addBinding(params, 'loss', { min: 0, max: 30, step: 1, label: 'loss %' })
net.addBinding(params, 'prediction', { label: 'prediction' })
net.addBinding(params, 'lagComp', { label: 'lag compensation' })
net.addBinding(params, 'interpDelay', { min: 0, max: 300, step: 5, label: 'interp delay ms' })
net.addBinding(params, 'correction', { min: 10, max: 400, step: 5, label: 'correction ms' })
const pendingMonitor = net.addBinding(params, 'pending', { readonly: true, label: 'pending inputs' })
const rttMonitor = net.addBinding(params, 'rtt', { readonly: true, label: 'rtt ms' })

// --- transport, clock sync, netcode ---
const transport = createNetsimClientTransport(createWebSocketClientTransport(SERVER_URL), {
  latencyMs: params.latency,
  jitterMs: params.jitter,
  lossRate: params.loss / 100,
})
const clock = createClockSync()
const reassembler = createSnapshotReassembler()
const interp = createSnapshotClient({ interpolationDelayMs: params.interpDelay, serverNow: () => clock.serverNow() })
let myId: EntityId | null = null
let predictor: Predictor | null = null

const applyNet = (): void => {
  transport.setConditions({ latencyMs: params.latency, jitterMs: params.jitter, lossRate: params.loss / 100 })
  interp.setInterpolationDelayMs(params.interpDelay)
  predictor?.setCorrectionSmoothingMs(params.correction)
}
net.on('change', applyNet)

const isPredicted = (id: EntityId): boolean => id === myId || isBallId(id)

const initPrediction = async (id: EntityId): Promise<void> => {
  await initPhysics()
  const world = createPhysicsWorld({ gravity: GRAVITY })
  addGround(world)
  const playerBody = addPlayerBody(world, playerSpawn(id))
  const balls = addBalls(world)

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
      const move = input.movement()
      transport.send(encodeInput(predictor!.predict(move.x, move.z)))
    },
  })
}

// Click to fire (lag-compensated); the HUD canvas is pointer-events:none, so clicks
// reach the Three canvas. The joystick zone captures its own pointers.
const raycaster = new THREE.Raycaster()
canvas.addEventListener('pointerdown', (e) => {
  if (!clock.ready()) return
  const rect = canvas.getBoundingClientRect()
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  )
  raycaster.setFromCamera(ndc, stage.camera)
  const { origin, direction } = raycaster.ray
  const fireTimeMs = clock.serverNow() - (params.lagComp ? params.interpDelay : 0)
  transport.send(
    encodeFire({
      fireTimeMs,
      origin: { x: origin.x, y: origin.y, z: origin.z },
      direction: { x: direction.x, y: direction.y, z: direction.z },
    }),
  )
})

transport.onOpen(() => {
  statusEl.textContent = `connected: ${SERVER_URL}`
  setInterval(() => transport.send(encodePing({ clientTimeMs: performance.now() })), 250)
})
transport.onClose(() => {
  statusEl.textContent = `disconnected — run 'pnpm dev:server' (${SERVER_URL})`
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
        const authoritative = new Map<EntityId, Vec3>()
        for (const e of snap.entities) if (isPredicted(e.id)) authoritative.set(e.id, e.position)
        predictor.reconcile(authoritative, snap.lastProcessedInputSeq)
      }
      interp.ingest(snap)
      break
    }
    case MSG_PONG: {
      const pong = decodePong(data)
      clock.recordSample(pong.clientTimeMs, pong.serverTimeMs, performance.now())
      break
    }
    case MSG_HIT:
      flash(decodeHit(data).targetId)
      break
  }
})

// Draw the joystick indicator on the HUD, offset to the joystick zone's position.
const drawJoystick = (): void => {
  const j = input.joystick()
  if (!j.active) {
    hud.setJoystick(null)
    return
  }
  const zr = joystickZone.getBoundingClientRect()
  const sr = stageEl.getBoundingClientRect()
  const ox = zr.left - sr.left
  const oy = zr.top - sr.top
  hud.setJoystick({
    active: true,
    radius: j.radius,
    baseX: j.baseX + ox,
    baseY: j.baseY + oy,
    knobX: j.knobX + ox,
    knobY: j.knobY + oy,
  })
}

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
  params.rtt = Math.round(clock.rttMs())
  pendingMonitor.refresh()
  rttMonitor.refresh()
  hud.setStatus(myId !== null ? `you #${myId} · rtt ${params.rtt}ms` : 'connecting…')
  drawJoystick()
})

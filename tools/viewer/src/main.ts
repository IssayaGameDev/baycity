import {
  addCharacter,
  CHAR_HALF_HEIGHT,
  CHAR_RADIUS,
  DEFAULT_TUNING,
  stepCharacter,
  TICK_DT,
  TICK_RATE_HZ,
  type CharacterState,
  type CharacterTuning,
} from '@mp/character'
import { instantiateLevel, type LoadedLevel, type VisualItem } from '@mp/content'
import { DEFAULT_REGISTRY, RULE_KINDS } from '@mp/components'
import { createSimClock, startFixedLoop, type LoopHandle, type Vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics, type PhysicsWorld } from '@mp/physics'
import {
  addLevel,
  applyGreyboxEnvironment,
  colorForMarker,
  createPostFX,
  createThreeStage,
  geometryForCollider,
  OrbitControls,
  THREE,
  type LevelView,
} from '@mp/render-three'
import { Pane } from 'tweakpane'

import { ENTRIES, type Entry } from './registry'

const canvas = document.querySelector<HTMLCanvasElement>('#view')!
const titleEl = document.querySelector<HTMLDivElement>('#title')!

// --- scene + polished pipeline (same renderer the game uses) ---
const stage = createThreeStage({ canvas, cameraPosition: [10, 9, 14], lookAt: [0, 1, 0] })
applyGreyboxEnvironment(stage.renderer, stage.scene, { shadowRadius: 40, sunIntensity: 2.4 })
const postfx = createPostFX(stage.renderer, stage.scene, stage.camera, { ao: true, bloom: true, bloomStrength: 0.3 })
stage.setRenderStep(postfx.render)

const controls = new OrbitControls(stage.camera, canvas)
controls.enableDamping = true
controls.target.set(0, 1, 0)

// --- static reference gizmos ---
const grid = new THREE.GridHelper(80, 80, 0x475569, 0x1f2937)
;(grid.material as THREE.Material).transparent = true
;(grid.material as THREE.Material).opacity = 0.5
const axes = new THREE.AxesHelper(3)
stage.scene.add(grid, axes)

// A material for x-ray debug overlays: drawn on top, never writing depth.
const overlayLine = (color: number): THREE.LineBasicMaterial =>
  new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, toneMapped: false })

// --- current entry state ---
let world: PhysicsWorld | null = null
let loaded: LoadedLevel | null = null
let levelView: LevelView | null = null
const colliderGroup = new THREE.Group()
const markerGroup = new THREE.Group()
const colliderPairs: { v: VisualItem; line: THREE.LineSegments }[] = [] // re-posed each frame
stage.scene.add(colliderGroup, markerGroup)

const clearGroup = (g: THREE.Group): void => {
  for (const child of [...g.children]) {
    g.remove(child)
    child.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments || o instanceof THREE.Line) {
        o.geometry.dispose()
        ;(o.material as THREE.Material).dispose()
      }
    })
  }
}

// A flat trigger/marker gizmo: a translucent disc + ring + a short pillar, coloured by kind.
const markerGizmo = (position: Vec3, color: number): THREE.Group => {
  const g = new THREE.Group()
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 0.05, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false }),
  )
  const pillar = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1.5, 0)]),
    overlayLine(color),
  )
  g.add(disc, pillar)
  g.position.set(position.x, position.y + 0.03, position.z)
  return g
}

const buildOverlays = (): void => {
  clearGroup(colliderGroup)
  clearGroup(markerGroup)
  colliderPairs.length = 0
  if (loaded === null) return

  // Colliders as x-ray wireframes (visual == collider for greybox, so this outlines them).
  // Paired with their visual so clock-driven pieces (moving/rotating) re-pose each frame.
  for (const v of loaded.visuals) {
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometryForCollider(v.collider)), overlayLine(0x38bdf8))
    edges.position.set(v.position.x, v.position.y, v.position.z)
    edges.quaternion.set(v.rotation.x, v.rotation.y, v.rotation.z, v.rotation.w)
    colliderGroup.add(edges)
    colliderPairs.push({ v, line: edges })
  }

  // Spawn markers + trigger colliders, coloured by kind.
  for (const m of loaded.markers) if (m.kind === 'spawn') markerGroup.add(markerGizmo(m.position, colorForMarker('spawn')))
  // A gizmo per gameplay rule, wherever it sits: the node that owns the collider you would touch.
  for (const n of loaded.nodes)
    for (const c of n.components) {
      const kind = RULE_KINDS[c.type]
      if (kind !== undefined) markerGroup.add(markerGizmo(n.position, colorForMarker(kind)))
    }
}

// --- jump-reachability gizmo (from the character tuning) ---
const tuning: CharacterTuning = { ...DEFAULT_TUNING }
const jumpGroup = new THREE.Group()
stage.scene.add(jumpGroup)

const buildJumpGizmo = (): void => {
  clearGroup(jumpGroup)
  const apex = tuning.jumpHeight
  const airTime = 2 * Math.sqrt((2 * apex) / tuning.gravity) // up + down for a fixed-apex jump
  const reach = tuning.moveSpeed * airTime // max horizontal distance in one jump

  // Ground ring = max horizontal reach from a standing jump.
  const ringPts: THREE.Vector3[] = []
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * Math.PI * 2
    ringPts.push(new THREE.Vector3(Math.cos(a) * reach, 0.03, Math.sin(a) * reach))
  }
  jumpGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPts), overlayLine(0x34d399)))

  // The jump arc itself (peaks at `apex` halfway across `reach`, along +x).
  const arcPts: THREE.Vector3[] = []
  for (let i = 0; i <= 48; i++) {
    const s = i / 48
    arcPts.push(new THREE.Vector3(reach * s, apex * 4 * s * (1 - s), 0))
  }
  jumpGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(arcPts), overlayLine(0xfacc15)))

  // Apex height marker.
  jumpGroup.add(
    new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, apex, 0)]),
      overlayLine(0xfacc15),
    ),
  )
}

// --- play-in-place (a controllable character; no networking) ---
const charMesh = new THREE.Mesh(
  new THREE.CapsuleGeometry(CHAR_RADIUS, CHAR_HALF_HEIGHT * 2, 8, 20),
  new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.6 }),
)
charMesh.castShadow = true
charMesh.visible = false
stage.scene.add(charMesh)

const keys = new Set<string>()
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault()
  keys.add(e.code)
})
window.addEventListener('keyup', (e) => keys.delete(e.code))

// WASD relative to the current orbit camera azimuth.
const worldMove = (): { x: number; z: number } => {
  let rx = 0
  let rz = 0
  if (keys.has('KeyW') || keys.has('ArrowUp')) rz -= 1
  if (keys.has('KeyS') || keys.has('ArrowDown')) rz += 1
  if (keys.has('KeyA') || keys.has('ArrowLeft')) rx -= 1
  if (keys.has('KeyD') || keys.has('ArrowRight')) rx += 1
  if (rx === 0 && rz === 0) return { x: 0, z: 0 }
  const dir = stage.camera.getWorldDirection(new THREE.Vector3())
  const len = Math.hypot(dir.x, dir.z) || 1
  const fx = dir.x / len
  const fz = dir.z / len
  const rightX = -fz
  const rightZ = fx
  let x = fx * -rz + rightX * rx
  let z = fz * -rz + rightZ * rx
  const l = Math.hypot(x, z)
  if (l > 1) {
    x /= l
    z /= l
  }
  return { x, z }
}

let char: CharacterState | null = null
let playLoop: LoopHandle | null = null
let spawnPoint: Vec3 = { x: 0, y: 3, z: 0 }

const startPlay = (): void => {
  if (world === null || loaded === null || playLoop !== null) return
  const spawnMarker = loaded.markers.find((m) => m.kind === 'spawn')?.position
  spawnPoint = spawnMarker
    ? { x: spawnMarker.x, y: spawnMarker.y + CHAR_HALF_HEIGHT + CHAR_RADIUS, z: spawnMarker.z }
    : { x: 0, y: 3, z: 0 }
  char = addCharacter(world, spawnPoint)
  charMesh.visible = true
  // One fixed step of platform time per fixed step — see @mp/core simClock.
  const simClock = createSimClock({ tickMs: TICK_DT * 1000, reference: () => performance.now() })
  playLoop = startFixedLoop({
    tickRateHz: TICK_RATE_HZ,
    onTick: () => {
      if (world === null || loaded === null || char === null) return
      // Two-phase: move clock-driven pieces first, then resolve the character against them
      // (so it rides moving platforms / gets pushed by the bar). Matches the game.
      loaded.update(simClock.tick(), char.base?.colliderHandle) // only the ridden piece is frozen
      world.step(TICK_DT) // (A) platforms move
      const m = worldMove()
      stepCharacter(char, { moveX: m.x, moveZ: m.z, jump: keys.has('Space') }, TICK_DT, tuning, loaded.basePose)
      world.step(TICK_DT) // (B) character resolves against them
      if (char.body.translation().y < loaded.config.fallY) {
        char.body.setPosition(spawnPoint)
        char.vx = char.vy = char.vz = 0
        char.grounded = false
      }
    },
  })
}

const stopPlay = (): void => {
  playLoop?.stop()
  playLoop = null
  char?.body.remove()
  char = null
  charMesh.visible = false
}

// --- load an entry ---
const disposeCurrent = (): void => {
  stopPlay()
  levelView?.dispose()
  levelView = null
  clearGroup(colliderGroup)
  clearGroup(markerGroup)
  world?.free()
  world = null
  loaded = null
}

const load = (entry: Entry): void => {
  const wasPlaying = playLoop !== null
  disposeCurrent()
  world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } }) // character integrates its own gravity
  loaded = instantiateLevel(world, entry.level, DEFAULT_REGISTRY)
  levelView = addLevel(stage.scene, loaded.visuals)
  buildOverlays()
  applyShow()
  titleEl.textContent = `${entry.group}: ${entry.name}`
  if (wasPlaying) startPlay()
}

// --- panel ---
const show = { grid: true, colliders: false, markers: true, jumpReach: false, play: false }
const applyShow = (): void => {
  grid.visible = show.grid
  axes.visible = show.grid
  colliderGroup.visible = show.colliders
  markerGroup.visible = show.markers
  jumpGroup.visible = show.jumpReach
}

const pane = new Pane({ title: 'Content viewer' })

const content = pane.addFolder({ title: 'Content' })
const options: Record<string, string> = {}
for (const e of ENTRIES) options[`${e.group === 'level' ? '▸ ' : '· '}${e.name}`] = e.name
const pick = { entry: ENTRIES[0]!.name }
const byName = new Map(ENTRIES.map((e) => [e.name, e]))
content.addBinding(pick, 'entry', { label: 'show', options }).on('change', (ev) => {
  const entry = byName.get(ev.value)
  if (entry) load(entry)
})

const showFolder = pane.addFolder({ title: 'Overlays' })
showFolder.addBinding(show, 'grid').on('change', applyShow)
showFolder.addBinding(show, 'colliders', { label: 'colliders (x-ray)' }).on('change', applyShow)
showFolder.addBinding(show, 'markers', { label: 'markers/triggers' }).on('change', applyShow)
showFolder.addBinding(show, 'jumpReach', { label: 'jump reach' }).on('change', applyShow)

const playFolder = pane.addFolder({ title: 'Play-in-place' })
playFolder.addBinding(show, 'play', { label: 'play (WASD+Space)' }).on('change', (ev) => {
  if (ev.value) startPlay()
  else stopPlay()
})
const rebuildJump = (): void => buildJumpGizmo()
playFolder.addBinding(tuning, 'moveSpeed', { min: 1, max: 12, step: 0.1, label: 'speed' }).on('change', rebuildJump)
playFolder.addBinding(tuning, 'jumpHeight', { min: 0.5, max: 5, step: 0.1, label: 'jump apex' }).on('change', rebuildJump)
playFolder.addBinding(tuning, 'gravity', { min: 10, max: 100, step: 1, label: 'gravity' }).on('change', rebuildJump)

const renderFolder = pane.addFolder({ title: 'Render', expanded: false })
const renderParams = { exposure: 1.0, bloom: true }
renderFolder.addBinding(renderParams, 'exposure', { min: 0.4, max: 2, step: 0.05 }).on('change', (e) => {
  stage.renderer.toneMappingExposure = e.value
})
renderFolder.addBinding(renderParams, 'bloom').on('change', (e) => {
  postfx.bloom.enabled = e.value
})

// --- render loop ---
stage.start(() => {
  controls.update()
  if (loaded !== null) {
    loaded.update(performance.now())
    levelView?.sync()
    // Keep the collider wireframes on the clock-driven pieces (moving/rotating).
    if (colliderGroup.visible)
      for (const { v, line } of colliderPairs) {
        line.position.set(v.position.x, v.position.y, v.position.z)
        line.quaternion.set(v.rotation.x, v.rotation.y, v.rotation.z, v.rotation.w)
      }
  }
  if (char !== null) {
    const p = char.body.translation()
    charMesh.position.set(p.x, p.y, p.z)
    controls.target.lerp(new THREE.Vector3(p.x, p.y, p.z), 0.1) // gently follow while playing
  }
})

// --- boot ---
await initPhysics()
buildJumpGizmo()
load(ENTRIES[0]!)

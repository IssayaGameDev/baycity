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
import { createLocalController, type LocalController, type LocalWorld } from '@mp/client'
import { instantiateLevel, platform, type Level, type LoadedLevel, type Prefab } from '@mp/content'
import { createSimClock, eulerToQuat, quat, startFixedLoop, vec3, type EntityId, type LoopHandle, type Vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics, type PhysicsWorld } from '@mp/physics'
import {
  addLevel,
  applyGreyboxEnvironment,
  colorForStyle,
  createPostFX,
  createStyleMaterial,
  createThreeStage,
  geometryForCollider,
  OrbitControls,
  STYLE_PALETTE,
  THREE,
  TransformControls,
  type LevelView,
} from '@mp/render-three'
import { levelDoc, prefabDoc, type Doc, type Mode } from './editorDoc'
import { listFiles, loadLevel, loadPrefab, saveFile, type FileKind } from './filesApi'
import { createHierarchy, type Hierarchy } from './hierarchy'
import { createInspector, type Inspector } from './inspector'
import { createPalette, type Palette } from './palette'
import { createSplitter, readPx, writePx } from './splitter'
import { createToolbar, type GizmoMode, type GizmoSpace, type Toolbar } from './toolbar'

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!
const canvas = $<HTMLCanvasElement>('#view')

// --- scene + polished pipeline (same renderer the game/viewer use) ---
const stage = createThreeStage({ canvas, cameraPosition: [12, 10, 16], lookAt: [0, 1, 0] })
applyGreyboxEnvironment(stage.renderer, stage.scene, { shadowRadius: 40, sunIntensity: 2.4 })
const postfx = createPostFX(stage.renderer, stage.scene, stage.camera, { ao: true, bloom: true, bloomStrength: 0.3 })
stage.setRenderStep(postfx.render)

const controls = new OrbitControls(stage.camera, canvas)
controls.enableDamping = true
controls.target.set(0, 1, 0)

const grid = new THREE.GridHelper(80, 80, 0x475569, 0x1f2937)
;(grid.material as THREE.Material).transparent = true
;(grid.material as THREE.Material).opacity = 0.5
const axes = new THREE.AxesHelper(3)
stage.scene.add(grid, axes)

// --- editor state ---
let world: PhysicsWorld | null = null
let loaded: LoadedLevel | null = null // for marker/trigger gizmos (+ physics validity)
let doc: Doc | null = null // the doc being edited — always the top of the stack
/**
 * The editing context. `[0]` is the open file; a deeper entry is a prefab opened *from* an instance,
 * and it is the level's own table object — so edits land on the one shared definition and every
 * instance follows on the way back out. Save always writes `[0]`, never the prefab being inspected.
 */
const docStack: { doc: Doc; label: string }[] = []
const userPrefabs: Record<string, Prefab> = {} // authored prefab library (for the level palette)
// The panels are built further down (and after a top-level `await`), so the editing code above them
// reaches the UI through these. Harmless no-ops until then, which is what makes boot order a non-issue.
let uiChanged: () => void = () => {}
let inspectorRebuild: () => void = () => {}
let inspectorSync: () => void = () => {}

const instanceRoot = new THREE.Group() // one Group per editable item (userData.index → data)
const markerGroup = new THREE.Group()
stage.scene.add(instanceRoot, markerGroup)
let instanceGroups: THREE.Group[] = []
let selected: number | null = null
let placing: string | null = null // a palette entry name awaiting a click to place
const edit: { mode: GizmoMode; snap: boolean; step: number; space: GizmoSpace } = {
  mode: 'translate',
  snap: true,
  step: 0.5,
  // Which frame the handles point along. Three forces `local` for scale and `world` for the free-rotate
  // ring, exactly as Unity does, so this only ever changes what it can.
  space: 'world',
}
let playing = false // play-in-place active (editing is suspended)
let lastSimTickAt = 0

const fileKind = (m: Mode): FileKind => (m === 'level' ? 'levels' : 'prefabs')

const r4 = (n: number): number => Math.round(n * 1e4) / 1e4
const isOne = (v: THREE.Vector3): boolean => Math.abs(v.x - 1) < 1e-4 && Math.abs(v.y - 1) < 1e-4 && Math.abs(v.z - 1) < 1e-4
const isZeroRot = (e: THREE.Euler): boolean => Math.abs(e.x) < 1e-5 && Math.abs(e.y) < 1e-5 && Math.abs(e.z) < 1e-5

const disposeMeshes = (g: THREE.Object3D): void => {
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

const applyTransform = (o: THREE.Object3D, position: Vec3, rotation: Vec3 | undefined, scale: Vec3 | undefined): void => {
  o.position.set(position.x, position.y, position.z)
  const q = rotation !== undefined ? eulerToQuat(rotation) : quat()
  o.quaternion.set(q.x, q.y, q.z, q.w)
  if (scale !== undefined) o.scale.set(scale.x, scale.y, scale.z)
  else o.scale.set(1, 1, 1)
}

// --- marker/trigger gizmos (a translucent disc + pillar, coloured by kind) ---
const markerGizmo = (position: Vec3, color: number): THREE.Group => {
  const g = new THREE.Group()
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 0.05, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false }),
  )
  const pillar = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1.5, 0)]),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, toneMapped: false }),
  )
  g.add(disc, pillar)
  g.position.set(position.x, position.y + 0.03, position.z)
  return g
}

const buildMarkers = (): void => {
  disposeMeshes(markerGroup)
  if (loaded === null) return
  for (const m of loaded.markers) if (m.kind === 'spawn') markerGroup.add(markerGizmo(m.position, colorForStyle('spawn')))
  for (const t of loaded.triggers) markerGroup.add(markerGizmo(t.position, colorForStyle(t.kind)))
}

// --- editable item meshes ---
/**
 * One Group per item, **parented to its own parent's Group**, so Three composes the transform chain and a
 * gizmo on a child reads and writes that child's *local* pose — which is exactly what the document stores.
 *
 * Each item group holds a dedicated mesh holder rather than its meshes directly: rebuilding one item's
 * meshes must not take its child items with it, and `disposeMeshes` cannot tell a mesh it added from a
 * child group it did not.
 */
const meshHolderOf = (g: THREE.Group): THREE.Group => g.userData.meshes as THREE.Group

const buildItemMeshes = (g: THREE.Group, i: number): void => {
  if (doc === null) return
  const holder = meshHolderOf(g)
  for (const spec of doc.meshSpecs(i)) {
    const mesh = new THREE.Mesh(geometryForCollider(spec.collider), createStyleMaterial(spec.style))
    applyTransform(mesh, spec.transform.position, spec.transform.rotation, spec.transform.scale)
    mesh.castShadow = true
    mesh.receiveShadow = true
    holder.add(mesh)
  }
}

const buildItems = (): void => {
  disposeMeshes(instanceRoot)
  instanceGroups = []
  if (doc === null) return
  // Depth-first order, so a parent's group always exists before its children ask for it.
  for (let i = 0; i < doc.count(); i++) {
    const g = new THREE.Group()
    const t = doc.transformOf(i)
    applyTransform(g, t.position, t.rotation, t.scale)
    g.userData.index = i
    const holder = new THREE.Group()
    g.userData.meshes = holder
    g.add(holder)
    buildItemMeshes(g, i)
    const parent = doc.parentOf(i)
    ;(parent === null ? instanceRoot : (instanceGroups[parent] ?? instanceRoot)).add(g)
    instanceGroups[i] = g
  }
}

/**
 * The local transform `child` would need to keep its current world pose while sitting under `parent`
 * (`null` = the level root): `parent⁻¹ · child`, decomposed.
 *
 * `null` when either group is missing. Decomposition cannot represent shear, so a child rotated inside a
 * non-uniformly scaled parent is an approximation — the same limitation Unity has, and the alternative is
 * refusing the drag.
 */
const localInside = (
  child: THREE.Group | undefined,
  parent: THREE.Group | null,
): { position: Vec3; rotation: Vec3; scale: Vec3 } | null => {
  if (child === undefined) return null
  child.updateWorldMatrix(true, false)
  parent?.updateWorldMatrix(true, false)
  const m = new THREE.Matrix4()
  if (parent === null) m.copy(child.matrixWorld)
  else m.copy(parent.matrixWorld).invert().multiply(child.matrixWorld)
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  m.decompose(position, quaternion, scale)
  const e = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ')
  return {
    position: vec3(r4(position.x), r4(position.y), r4(position.z)),
    rotation: vec3(e.x, e.y, e.z),
    scale: vec3(scale.x, scale.y, scale.z),
  }
}

const rebuildSelectedMeshes = (): void => {
  if (selected === null) return
  const g = instanceGroups[selected]
  if (g === undefined) return
  disposeMeshes(meshHolderOf(g)) // only this item's own meshes; its child items are siblings of the holder
  buildItemMeshes(g, selected)
}

// --- end-position widget: a translucent ghost of a moving piece at its far end + a line ---
const ghostMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.22, depthWrite: false, toneMapped: false })
const endLineMat = new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, toneMapped: false })
const endHelper = new THREE.Group()
stage.scene.add(endHelper)
const clearEndHelper = (): void => {
  for (const c of [...endHelper.children]) {
    endHelper.remove(c)
    c.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) o.geometry.dispose() // shared materials kept
    })
  }
}
const updateEndGhost = (): void => {
  clearEndHelper()
  endHelper.visible = false
  if (selected === null || doc === null) return
  const p = doc.props(selected)
  if (p.behavior !== 'move') return
  const g = instanceGroups[selected]
  if (g === undefined) return
  const len = Math.hypot(p.axis.x, p.axis.y, p.axis.z) || 1
  const end = g.position.clone().add(new THREE.Vector3(p.axis.x / len, p.axis.y / len, p.axis.z / len).multiplyScalar(p.distance))
  const ghost = new THREE.Group()
  ghost.position.copy(end)
  ghost.quaternion.copy(g.quaternion)
  ghost.scale.copy(g.scale)
  for (const spec of doc.meshSpecs(selected)) {
    const m = new THREE.Mesh(geometryForCollider(spec.collider), ghostMat)
    applyTransform(m, spec.transform.position, spec.transform.rotation, spec.transform.scale)
    ghost.add(m)
  }
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([g.position.clone(), end]), endLineMat)
  endHelper.add(ghost, line)
  endHelper.visible = true
}

// Re-derive markers/triggers + physics from the current doc (after edits; also a validity check).
const rebuildLoaded = (): void => {
  if (doc === null) return
  world?.free()
  world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
  try {
    loaded = instantiateLevel(world, doc.asLevel())
    buildMarkers()
  } catch (e) {
    loaded = null
    disposeMeshes(markerGroup)
    setStatus(`invalid: ${String(e)}`)
  }
}

let rebuildTimer: number | null = null
const scheduleRebuild = (): void => {
  if (rebuildTimer !== null) clearTimeout(rebuildTimer)
  rebuildTimer = window.setTimeout(() => {
    rebuildTimer = null
    rebuildLoaded()
  }, 150)
}

const breadcrumb = (): string => {
  const path = docStack.map((e) => e.label).join(' › ')
  if (doc === null) return path
  return `${path} — ${doc.count()} ${doc.mode === 'level' ? 'instances' : 'pieces'}`
}

/** Point the viewport at the top of the stack. Everything is rebuilt from data, so returning from a
 * prefab edit is what makes every instance of it move at once. */
const showDoc = (): void => {
  deselect()
  doc = docStack[docStack.length - 1]?.doc ?? null
  buildItems()
  rebuildLoaded()
  statusMsg = '' // a message about the old document would be a lie about this one
  uiChanged()
}

/** Open a file — the stack starts over at its root. */
const setDoc = (next: Doc, name: string): void => {
  docStack.length = 0
  docStack.push({ doc: next, label: `${next.mode}: ${name}` })
  fileState.name = name
  showDoc()
}

/** Step into the shared definition behind a referencing instance. */
const openPrefabOf = (index: number): void => {
  if (doc === null) return
  const id = doc.refOf(index)
  if (id === null) return
  const prefab = doc.prefabAt(id)
  if (prefab === undefined) return
  const n = doc.refCount(id)
  docStack.push({ doc: prefabDoc(prefab), label: `${id} (${n} instance${n === 1 ? '' : 's'})` })
  showDoc()
}

const closePrefab = (): void => {
  if (docStack.length < 2) return
  docStack.pop()
  showDoc()
}

const blankLevel = (id: string): Level => ({
  id,
  config: { fallBehavior: 'respawn-checkpoint', fallY: -10 },
  instances: [{ prefab: platform({ width: 20, depth: 20, thickness: 1, style: 'ground' }), transform: { position: vec3(0, -0.5, 0) } }],
  markers: [{ kind: 'spawn', transform: { position: vec3(0, 0, 0) } }],
})
const blankPrefab = (id: string): Prefab => ({
  id,
  pieces: [{ collider: { kind: 'box', halfExtents: vec3(1.5, 0.15, 1.5) }, transform: { position: vec3(0, 0, 0) } }],
})

// --- selection + transform gizmo ---
const gizmo = new TransformControls(stage.camera, canvas)
const applySnap = (): void => {
  gizmo.setTranslationSnap(edit.snap ? edit.step : null)
  gizmo.setRotationSnap(edit.snap ? THREE.MathUtils.degToRad(15) : null)
  gizmo.setScaleSnap(edit.snap ? 0.1 : null)
}
stage.scene.add(gizmo.getHelper())

/** Switch transform tool (toolbar buttons and the T/R/S keys are the same path). */
const setMode = (mode: GizmoMode): void => {
  edit.mode = mode
  gizmo.setMode(mode)
  uiChanged()
}

const setSpace = (space: GizmoSpace): void => {
  edit.space = space
  gizmo.space = space
  uiChanged()
}

let gizmoDragged = false
gizmo.addEventListener('dragging-changed', (event) => {
  const dragging = event.value as boolean
  controls.enabled = !dragging
  if (dragging) gizmoDragged = true
  else rebuildLoaded()
})
gizmo.addEventListener('objectChange', () => {
  writeBackSelected()
  inspectorSync()
  updateEndGhost()
})

// Copy the selected group's pose back into the doc (position always; rotation/scale only if any).
const writeBackSelected = (): void => {
  if (selected === null || doc === null) return
  const g = instanceGroups[selected]
  if (g === undefined) return
  const t = doc.transformOf(selected)
  t.position = vec3(r4(g.position.x), r4(g.position.y), r4(g.position.z))
  const e = new THREE.Euler().setFromQuaternion(g.quaternion, 'XYZ')
  if (isZeroRot(e)) delete t.rotation
  else t.rotation = vec3(r4(e.x), r4(e.y), r4(e.z))
  if (isOne(g.scale)) delete t.scale
  else t.scale = vec3(r4(g.scale.x), r4(g.scale.y), r4(g.scale.z))
}

const select = (index: number): void => {
  // Editing is suspended during play, and the item meshes are hidden — attaching a gizmo to one would
  // put a handle in mid-air over a level you are walking. The Hierarchy panel can reach here too, so the
  // guard belongs on the selection itself rather than on the viewport's click handler alone.
  if (playing) return
  const g = instanceGroups[index]
  if (g === undefined || doc === null) return
  selected = index
  gizmo.attach(g)
  inspectorRebuild()
  updateEndGhost()
  uiChanged()
}

const deselect = (): void => {
  selected = null
  gizmo.detach()
  inspectorRebuild()
  updateEndGhost()
  uiChanged()
}

const raycaster = new THREE.Raycaster()
const ndc = new THREE.Vector2()
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
let downX = 0
let downY = 0
canvas.addEventListener('pointerdown', (e) => {
  downX = e.clientX
  downY = e.clientY
  gizmoDragged = false
})
canvas.addEventListener('pointerup', (e) => {
  if (playing) return // editing suspended during play (pointer = camera only)
  if (gizmoDragged) return // was dragging the gizmo, not a click
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return // was an orbit drag
  const rect = canvas.getBoundingClientRect()
  ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
  raycaster.setFromCamera(ndc, stage.camera)

  // Placement mode: drop the chosen palette entry on the surface (or ground plane).
  if (placing !== null && doc !== null) {
    const surf = raycaster.intersectObjects(instanceRoot.children, true)[0]
    const point = new THREE.Vector3()
    if (surf !== undefined) point.copy(surf.point)
    else if (raycaster.ray.intersectPlane(groundPlane, point) === null) {
      placing = null
      return
    }
    const snap = edit.snap ? edit.step : 0
    const sx = snap !== 0 ? Math.round(point.x / snap) * snap : r4(point.x)
    const sz = snap !== 0 ? Math.round(point.z / snap) * snap : r4(point.z)
    const idx = doc.place(placing, vec3(sx, r4(point.y), sz))
    placing = null
    buildItems()
    rebuildLoaded()
    select(idx)
    return
  }

  const hit = raycaster.intersectObjects(instanceRoot.children, true)[0]?.object
  if (hit === undefined) {
    deselect()
    return
  }
  let o: THREE.Object3D | null = hit
  while (o !== null && o.userData.index === undefined) o = o.parent
  if (o !== null && typeof o.userData.index === 'number') select(o.userData.index)
})

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
  if (playing) {
    if (e.code === 'Escape') stopPlay()
    return // WASD/Space handled by the play key listener; editing shortcuts off
  }
  if (e.code === 'KeyT' || e.code === 'KeyG') setMode('translate')
  else if (e.code === 'KeyR') setMode('rotate')
  else if (e.code === 'KeyS') setMode('scale')
  else if (e.code === 'Delete' || e.code === 'Backspace') deleteSelected()
  else if (e.code === 'KeyD' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    duplicateSelected()
  } else if (e.code === 'Escape') {
    if (placing !== null) {
      placing = null
      setStatus('placement cancelled')
    } else deselect()
  }
})

const deleteSelected = (): void => {
  if (selected === null || doc === null) return
  doc.remove(selected)
  deselect()
  buildItems()
  rebuildLoaded()
}
const duplicateSelected = (): void => {
  if (selected === null || doc === null) return
  const idx = doc.duplicate(selected)
  buildItems()
  rebuildLoaded()
  select(idx)
}
/** Give an inline one-off a shared identity, so it can be referenced and edited in one place. */
const extractSelected = (): void => {
  if (selected === null || doc === null) return
  const id = doc.extract(selected)
  if (id === null) return
  inspectorRebuild() // the link row flips from "not linked" to the new prefab
  uiChanged() // the level's own entries are placeable too, and the row gains a badge
  setStatus(`extracted to prefab "${id}"`)
}

// ============================ play-in-place (identical to the game) ============================
// Same building blocks as modes/parkour: createLocalController (fixed tick + render interpolation),
// the two-phase step (move platforms, then resolve the character against them), and stepCharacter
// with DEFAULT_TUNING. The viewer skipped the controller/interpolation, which is why it felt off.
const PLAYER_ID = 0 as EntityId
const STAND_OFFSET = CHAR_HALF_HEIGHT + CHAR_RADIUS

const keys = new Set<string>()
window.addEventListener('keydown', (e) => {
  keys.add(e.code)
  if (playing && (e.code === 'Space' || e.code.startsWith('Arrow'))) e.preventDefault()
})
window.addEventListener('keyup', (e) => keys.delete(e.code))

const charMesh = new THREE.Mesh(
  new THREE.CapsuleGeometry(CHAR_RADIUS, CHAR_HALF_HEIGHT * 2, 8, 20),
  new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.6 }),
)
charMesh.castShadow = true
charMesh.visible = false
stage.scene.add(charMesh)

const tuning: CharacterTuning = { ...DEFAULT_TUNING }
let char: CharacterState | null = null
let controller: LocalController | null = null
let playLoop: LoopHandle | null = null
let playView: LevelView | null = null
let ownPos: Vec3 = { x: 0, y: 1, z: 0 }

// The game's third-person camera: mouselook (pointer lock) yaw/pitch orbit at a fixed distance.
let camYaw = 0
let camPitch = 0.35
const camParams = { distance: 7, sensitivity: 0.0025 }
window.addEventListener('mousemove', (e) => {
  if (!playing || document.pointerLockElement !== canvas) return
  camYaw -= e.movementX * camParams.sensitivity
  camPitch = Math.min(1.2, Math.max(-0.2, camPitch + e.movementY * camParams.sensitivity))
})
canvas.addEventListener('click', () => {
  if (playing && document.pointerLockElement !== canvas) void canvas.requestPointerLock()
})
document.addEventListener('pointerlockchange', () => {
  if (playing && document.pointerLockElement !== canvas) stopPlay() // Esc / lost lock exits play
})

// WASD/arrows relative to the camera yaw (identical to the game).
const worldMove = (): { x: number; z: number } => {
  let rx = 0
  let rz = 0
  if (keys.has('KeyW') || keys.has('ArrowUp')) rz -= 1
  if (keys.has('KeyS') || keys.has('ArrowDown')) rz += 1
  if (keys.has('KeyA') || keys.has('ArrowLeft')) rx -= 1
  if (keys.has('KeyD') || keys.has('ArrowRight')) rx += 1
  if (rx === 0 && rz === 0) return { x: 0, z: 0 }
  const fwdX = -Math.sin(camYaw)
  const fwdZ = -Math.cos(camYaw)
  let x = fwdX * -rz + -fwdZ * rx
  let z = fwdZ * -rz + fwdX * rx
  const l = Math.hypot(x, z)
  if (l > 1) {
    x /= l
    z /= l
  }
  return { x, z }
}

const startPlay = (): void => {
  if (doc === null || playing) return
  rebuildLoaded() // fresh world + loaded from the current data
  if (loaded === null || world === null) return
  deselect()
  const sm = loaded.markers.find((m) => m.kind === 'spawn')?.position
  const spawn: Vec3 = sm !== undefined ? { x: sm.x, y: sm.y + STAND_OFFSET, z: sm.z } : { x: 0, y: 3, z: 0 }
  char = addCharacter(world, spawn)
  let respawnPos: Vec3 = { ...spawn }
  let cpIndex = -1
  const checkpoints = loaded.triggers.filter((t) => t.kind === 'checkpoint')
  const hazards = new Set(loaded.triggers.filter((t) => t.kind === 'hazard').map((t) => t.colliderHandle))
  const fallY = loaded.config.fallY

  // One fixed step of platform time per fixed step — see @mp/core simClock (reading the wall
  // clock inside the tick stalls the platforms during a multi-tick wake and jitters carry).
  const simClock = createSimClock({ tickMs: TICK_DT * 1000, reference: () => performance.now() })

  const local: LocalWorld = {
    applyInput: (cmd) => {
      if (world === null || loaded === null || char === null) return
      loaded.update(simClock.tick(), char.base?.colliderHandle) // only the ridden piece is frozen
      world.step(TICK_DT) // (A) platforms move
      stepCharacter(char, cmd, TICK_DT, tuning, loaded.basePose) // rides whatever it stands on
      world.step(TICK_DT) // (B) character resolves against the moved platforms
      lastSimTickAt = performance.now()
    },
    readState: () => new Map<EntityId, Vec3>([[PLAYER_ID, char!.body.translation()]]),
  }
  controller = createLocalController({ world: local, tickRateHz: TICK_RATE_HZ })

  instanceRoot.visible = false
  playView = addLevel(stage.scene, loaded.visuals)
  charMesh.visible = true
  playing = true
  controls.enabled = false // editor orbit off; the player camera takes over
  void canvas.requestPointerLock()
  setStatus('playing — WASD + Space · mouse to look · Esc to stop')
  uiChanged()

  playLoop = startFixedLoop({
    tickRateHz: TICK_RATE_HZ,
    onTick: () => {
      if (char === null || controller === null) return
      const m = worldMove()
      controller.step(m.x, m.z, keys.has('Space'))
      const hits = new Set(char.body.collisions())
      for (let i = 0; i < checkpoints.length; i++) {
        const t = checkpoints[i]!
        if (hits.has(t.colliderHandle) && i > cpIndex) {
          cpIndex = i
          respawnPos = { x: t.position.x, y: t.position.y + STAND_OFFSET, z: t.position.z }
          break
        }
      }
      const p = char.body.translation()
      if ([...hits].some((h) => hazards.has(h)) || p.y < fallY) {
        char.body.setPosition(respawnPos)
        char.vx = 0
        char.vy = 0
        char.vz = 0
        char.grounded = false
      }
    },
  })
}

const stopPlay = (): void => {
  if (!playing) return
  playLoop?.stop()
  playLoop = null
  char?.body.remove()
  char = null
  controller = null
  playView?.dispose()
  playView = null
  charMesh.visible = false
  instanceRoot.visible = true
  playing = false
  if (document.pointerLockElement === canvas) document.exitPointerLock()
  controls.target.set(ownPos.x, ownPos.y + 1, ownPos.z) // resume orbit around where you stopped
  controls.enabled = true
  statusMsg = ''
  uiChanged()
  rebuildLoaded() // restore the edit world + markers
}

// ============================ panels ============================
// The shell is CSS grid (see index.html); each panel is its own module, and every one of them reads
// the editor's state through a getter rather than being handed a snapshot — so `refreshUi()` is the
// single "something changed, redraw the chrome" call, and no panel can hold a stale copy.

const app = $<HTMLDivElement>('#app')
const statusBar = $<HTMLDivElement>('#status')

const fileState: { mode: Mode; name: string } = { mode: 'level', name: 'untitled' }
let fileNames: string[] = []

const openFile = async (name: string): Promise<void> => {
  try {
    if (fileState.mode === 'level') setDoc(levelDoc(await loadLevel(name), userPrefabs), name)
    else setDoc(prefabDoc(await loadPrefab(name)), name)
  } catch (e) {
    setStatus(`load failed: ${String(e)}`)
  }
}

const refreshPrefabLibrary = async (): Promise<void> => {
  for (const k of Object.keys(userPrefabs)) delete userPrefabs[k]
  for (const n of await listFiles('prefabs').catch(() => [])) {
    try {
      userPrefabs[n] = await loadPrefab(n)
    } catch {
      // skip a malformed prefab file
    }
  }
}

const refreshFileList = async (): Promise<void> => {
  fileNames = await listFiles(fileKind(fileState.mode)).catch(() => [] as string[])
  toolbar?.render()
}

const enterMode = async (mode: Mode): Promise<void> => {
  fileState.mode = mode
  await refreshFileList()
  if (fileNames[0] !== undefined) await openFile(fileNames[0])
  else setDoc(mode === 'level' ? levelDoc(blankLevel('untitled'), userPrefabs) : prefabDoc(blankPrefab('untitled')), 'untitled')
}

// --- toolbar ---
const toolbar: Toolbar = createToolbar(
  $<HTMLDivElement>('#toolbar'),
  () => ({
    mode: fileState.mode,
    name: fileState.name,
    files: fileNames,
    gizmo: edit.mode,
    space: edit.space,
    snap: edit.snap,
    step: edit.step,
    playing,
    inPrefab: docStack.length > 1,
    grid: grid.visible,
    markers: markerGroup.visible,
  }),
  {
    setMode: (m) => void enterMode(m),
    open: (name) => void openFile(name),
    setName: (name) => {
      fileState.name = name === '' ? 'untitled' : name
      refreshUi()
    },
    save: () => {
      const root = docStack[0]?.doc
      if (root === undefined) return
      // Saving writes the *file*, not whatever prefab is open on top of it, and the id follows the
      // name. Letting them drift is how content/levels ended up with three files all claiming "level1".
      root.setId(fileState.name)
      void saveFile(fileKind(fileState.mode), fileState.name, root.toJSON())
        .then(async () => {
          setStatus(`saved ${fileState.name}`)
          if (fileState.mode === 'prefab') await refreshPrefabLibrary()
          await refreshFileList()
        })
        .catch((e: unknown) => setStatus(`save failed: ${String(e)}`))
    },
    newBlank: () => {
      const name = fileState.name || 'untitled'
      setDoc(fileState.mode === 'level' ? levelDoc(blankLevel(name), userPrefabs) : prefabDoc(blankPrefab(name)), name)
    },
    back: closePrefab,
    setGizmo: setMode,
    setSpace,
    setSnap: (on) => {
      edit.snap = on
      applySnap()
      refreshUi()
    },
    setStep: (step) => {
      edit.step = step
      applySnap()
      refreshUi()
    },
    setPlaying: (on) => {
      if (on) startPlay()
      else stopPlay()
    },
    setGrid: (on) => {
      grid.visible = on
      axes.visible = on
      refreshUi()
    },
    setMarkers: (on) => {
      markerGroup.visible = on
      refreshUi()
    },
  },
)

// --- hierarchy ---
const hierarchy: Hierarchy = createHierarchy($<HTMLDivElement>('#hierarchy'), {
  doc: () => doc,
  selected: () => selected,
  onSelect: select,
  // A piece belongs to the prefab, not to the instance you clicked it under, so opening it means
  // stepping into the shared definition — with that piece already selected.
  onOpenPiece: (index, pieceIndex) => {
    openPrefabOf(index)
    if (doc !== null && pieceIndex < doc.count()) select(pieceIndex)
  },
  onRename: (index, name) => {
    doc?.setName(index, name)
    inspectorRebuild() // the inspector's own name field mirrors this one
    uiChanged()
  },
  onReparent: (from, parent, at) => {
    if (doc === null || !doc.canReparent(from, parent)) return
    // Preserve the world pose, as dragging in Unity's hierarchy does: the stored numbers are re-expressed
    // in the new parent's frame so the object does not jump. Read off the scene graph, which is where the
    // composed matrices already live — the document only ever holds local transforms.
    const local = localInside(instanceGroups[from], parent === null ? null : (instanceGroups[parent] ?? null))
    const wasSelected = selected === from

    const landed = doc.reparent(from, parent, at)
    if (local !== null) {
      const t = doc.transformOf(landed)
      t.position = local.position
      const rot = new THREE.Euler(local.rotation.x, local.rotation.y, local.rotation.z, 'XYZ')
      if (isZeroRot(rot)) delete t.rotation
      else t.rotation = vec3(r4(local.rotation.x), r4(local.rotation.y), r4(local.rotation.z))
      if (isOne(new THREE.Vector3(local.scale.x, local.scale.y, local.scale.z))) delete t.scale
      else t.scale = vec3(r4(local.scale.x), r4(local.scale.y), r4(local.scale.z))
    }

    // Depth-first indices *are* the identity here (meshes, selection, the gizmo's target) and a reparent
    // renumbers everything after it, so the scene graph and the physics world are rebuilt rather than
    // patched. `reparent` hands back where the item went, which is the one index worth keeping.
    buildItems()
    rebuildLoaded()
    if (wasSelected) select(landed)
    else {
      deselect()
      uiChanged()
    }
  },
})

// --- palette ---
const palette: Palette = createPalette($<HTMLDivElement>('#palette'), {
  names: () => doc?.palette() ?? [],
  armed: () => placing,
  onPick: (name) => {
    placing = placing === name ? null : name // clicking the armed tile disarms it
    refreshUi()
  },
})

// --- inspector ---
const inspector: Inspector = createInspector($<HTMLDivElement>('#insp-head'), $<HTMLDivElement>('#inspector'), {
  doc: () => doc,
  selected: () => selected,
  readTransform: () => {
    if (selected === null) return null
    const g = instanceGroups[selected]
    if (g === undefined) return null
    const e = new THREE.Euler().setFromQuaternion(g.quaternion, 'XYZ')
    return {
      position: vec3(g.position.x, g.position.y, g.position.z),
      rotationDeg: vec3(THREE.MathUtils.radToDeg(e.x), THREE.MathUtils.radToDeg(e.y), THREE.MathUtils.radToDeg(e.z)),
      scale: vec3(g.scale.x, g.scale.y, g.scale.z),
    }
  },
  writeTransform: (t) => {
    if (selected === null) return
    const g = instanceGroups[selected]
    if (g === undefined) return
    g.position.set(t.position.x, t.position.y, t.position.z)
    const q = eulerToQuat(vec3(THREE.MathUtils.degToRad(t.rotationDeg.x), THREE.MathUtils.degToRad(t.rotationDeg.y), THREE.MathUtils.degToRad(t.rotationDeg.z)))
    g.quaternion.set(q.x, q.y, q.z, q.w)
    g.scale.set(t.scale.x, t.scale.y, t.scale.z)
    writeBackSelected()
    scheduleRebuild()
    updateEndGhost()
  },
  onPropsChanged: () => {
    rebuildSelectedMeshes()
    scheduleRebuild()
    updateEndGhost()
    hierarchy.render() // a trigger or style change shows in the row's badge/label
  },
  // A rename only changes a label: redraw the chrome, leave the property grid and the meshes alone.
  // Called through the hook, since `refreshUi` is declared below this block.
  onRenamed: () => uiChanged(),
  duplicate: duplicateSelected,
  remove: deleteSelected,
  extract: extractSelected,
  openPrefab: () => {
    if (selected !== null) openPrefabOf(selected)
  },
  styles: Object.keys(STYLE_PALETTE),
})

// --- status bar ---
let statusMsg = ''
const setStatus = (msg: string): void => {
  statusMsg = msg
  renderStatus()
}
const renderStatus = (): void => {
  const parts: string[] = [breadcrumb()]
  if (selected !== null && doc !== null) parts.push(`selected #${selected} (${doc.label(selected)})`)
  if (placing !== null) parts.push(`click in the viewport to place <b>${placing}</b>`)
  if (statusMsg !== '') parts.push(statusMsg)
  statusBar.innerHTML = parts.filter((p) => p !== '').join(' · ')
}

/** Redraw all the chrome from current state. Cheap: tens of rows, and the toolbar only updates values. */
const refreshUi = (): void => {
  toolbar.render()
  hierarchy.render()
  palette.render()
  renderStatus()
}
uiChanged = refreshUi
inspectorRebuild = () => inspector.rebuild()
inspectorSync = () => inspector.sync()

// --- splitters: the canvas is no longer window-sized, so it has to be told when its cell changes ---
let relayoutQueued = false
const relayout = (): void => {
  if (relayoutQueued) return
  // Coalesce to one per frame: a drag fires pointermove far faster than the composer wants to
  // reallocate its render targets.
  relayoutQueued = true
  requestAnimationFrame(() => {
    relayoutQueued = false
    stage.resize()
    const size = stage.renderer.getSize(new THREE.Vector2())
    postfx.setSize(size.x, size.y)
  })
}

const MIN_PANEL = 140
const MIN_VIEWPORT = 320
createSplitter({
  handle: $<HTMLDivElement>('#split-left'),
  axis: 'x',
  sign: 1,
  read: () => readPx(app, '--left'),
  write: (px) => writePx(app, '--left', px),
  min: MIN_PANEL,
  max: () => window.innerWidth - readPx(app, '--right') - MIN_VIEWPORT,
  onChange: relayout,
})
createSplitter({
  handle: $<HTMLDivElement>('#split-right'),
  axis: 'x',
  sign: -1,
  read: () => readPx(app, '--right'),
  write: (px) => writePx(app, '--right', px),
  min: MIN_PANEL,
  max: () => window.innerWidth - readPx(app, '--left') - MIN_VIEWPORT,
  onChange: relayout,
})
createSplitter({
  handle: $<HTMLDivElement>('#split-bottom'),
  axis: 'y',
  sign: -1,
  read: () => readPx(app, '--bottom'),
  write: (px) => writePx(app, '--bottom', px),
  min: 60,
  max: () => window.innerHeight - 260,
  onChange: relayout,
})

// --- render loop ---
stage.start(() => {
  if (playing && controller !== null && loaded !== null) {
    // Interpolate clock-driven pieces + the character between the last two sim ticks (same
    // timeline as the game), then place the player camera (mouselook orbit) around the character.
    const alpha = Math.min(1, Math.max(0, (performance.now() - lastSimTickAt) / (1000 / TICK_RATE_HZ)))
    loaded.render(alpha)
    playView?.sync()
    ownPos = controller.renderPositions().get(PLAYER_ID) ?? ownPos
    charMesh.position.set(ownPos.x, ownPos.y, ownPos.z)
    const tx = ownPos.x
    const ty = ownPos.y + 1
    const tz = ownPos.z
    const cp = Math.cos(camPitch)
    stage.camera.position.set(tx + Math.sin(camYaw) * cp * camParams.distance, ty + Math.sin(camPitch) * camParams.distance + 0.5, tz + Math.cos(camYaw) * cp * camParams.distance)
    stage.camera.lookAt(tx, ty, tz)
  } else {
    controls.update()
  }
})

// --- boot ---
await initPhysics()
applySnap()
await refreshPrefabLibrary()
await enterMode('level')

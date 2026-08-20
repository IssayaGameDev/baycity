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
import {
  assetsOfKind,
  instantiateNodeLevel,
  moveTrack,
  spinTrack,
  trackDuration,
  COLLIDER,
  SPAWN,
  RENDERER,
  type AssetEntry,
  type ComponentData,
  type Keyframe,
  type LoadedNodeLevel,
  // Aliased: this file is DOM-heavy and `Node` is taken. A scene node is not a DOM node, and the day the two
  // are confused the error is a type error somewhere unrelated.
  type Node as SceneNode,
  type NodeLevel,
  type Pose,
  type Transform,
} from '@mp/content'
import { Checkpoint, DEFAULT_REGISTRY, RULE_KINDS, characterAccess, createComponentRuntime, hasComponent, type ComponentRuntime } from '@mp/components'
import { createSimClock, eulerToQuat, quat, startFixedLoop, vec3, type EntityId, type LoopHandle, type Vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics, type PhysicsWorld } from '@mp/physics'
import {
  addLevel,
  applyGreyboxEnvironment,
  colorForMarker,
  createPostFX,
  createGreyboxMaterial,
  createThreeStage,
  geometryForCollider,
  OrbitControls,
  createAssetRuntime,
  THREE,
  TransformControls,
  type AssetRuntime,
  type LevelView,
} from '@mp/render-three'
import { levelDoc, prefabDoc, type ClipItem, type Doc, type KeyEditor, type Mode } from './editorDoc'
import { createContextMenu, type ContextMenu, type MenuItem } from './menu'
import { listFiles, loadLevel, saveFile } from './filesApi'
import { createHierarchy, type Hierarchy } from './hierarchy'
import { createHistory } from './history'
import { createInspector, type Inspector } from './inspector'
import { createAssetInspector, type AssetInspector } from './assetInspector'
import { loadAssetLibrary, type AssetLibrary } from './assetsApi'
import { canMoveFolder, movedInto, renamedTo } from './assetTree'
import { createPreviews, type Previews } from './previews'
import { createProjectPanel, type Project } from './projectPanel'
import { applySelect, clampTo, modeFor, primaryOf, rootsOf, type SelectMode } from './selection'
import { createShortcuts } from './shortcuts'
import { createSplitter, readPx, writePx } from './splitter'
import { createTimeline, type Timeline } from './timeline'
import { DIRS, keyRows, oneKeyAt, pathPoints, setKeyPose } from './trackEdit'
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
let loaded: LoadedNodeLevel | null = null // for marker/trigger gizmos (+ physics validity)
let doc: Doc | null = null // the doc being edited — always the top of the stack
/**
 * The editing context. `[0]` is the open file; a deeper entry is a prefab opened *from* an instance,
 * and it is the level's own table object — so edits land on the one shared definition and every
 * instance follows on the way back out. Save always writes `[0]`, never the prefab being inspected.
 */
const docStack: { doc: Doc; label: string }[] = []
const userPrefabs: Record<string, SceneNode> = {} // authored prefab library (for the level palette)
// The panels are built further down (and after a top-level `await`), so the editing code above them
// reaches the UI through these. Harmless no-ops until then, which is what makes boot order a non-issue.
let uiChanged: () => void = () => {}
let inspectorRebuild: () => void = () => {}
let inspectorSync: () => void = () => {}

const instanceRoot = new THREE.Group() // one Group per editable item (userData.index → data)
const markerGroup = new THREE.Group()
stage.scene.add(instanceRoot, markerGroup)
let instanceGroups: THREE.Group[] = []
/**
 * Every selected item, primary last (ADR 0031).
 *
 * `selected` below is derived from it and is the **primary** — the last clicked. Keeping both is what let
 * multi-selection arrive without touching the Inspector, the timeline or the track helper: each of those has
 * exactly one subject, and the primary is it. Only the operations that genuinely mean "all of them" —
 * transform, delete, duplicate, copy — read the list.
 */
let selection: number[] = []
let selected: number | null = null
/**
 * What a viewport click will place. `own` is a prefab this level defines in its own table, named; a model or a
 * prefab file is an asset id, and
 * placing one wraps it in a one-piece inline prefab whose collider is authored — visual is not collision,
 * so a detailed prop still collides as a box somebody can resize.
 */
type Placing =
  | { kind: 'own'; name: string }
  | { kind: 'model'; assetId: string }
  | { kind: 'prefabAsset'; assetId: string }
let placing: Placing | null = null
/** Loaded assets. Both arrive at boot, before any document is opened. */
let assets: AssetLibrary | null = null
let runtime: AssetRuntime | null = null
let selectedAsset: string | null = null
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

/** Asset id of the prefab open in prefab mode, or `null` for a level or an unsaved prefab. */
let openPrefabAsset: string | null = null

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
  for (const m of loaded.markers) if (m.kind === 'spawn') markerGroup.add(markerGizmo(m.position, colorForMarker('spawn')))
  // A gizmo per gameplay rule, on the node that owns the collider you would touch. `RULE_KINDS` is the only
  // place the editor names a rule at all: everything else about a component comes from its declaration.
  for (const n of loaded.nodes)
    for (const c of n.components) {
      const kind = RULE_KINDS[c.type]
      if (kind !== undefined) markerGroup.add(markerGizmo(n.position, colorForMarker(kind)))
    }
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
    // The same precedence the game's level view uses, so the editor is never showing a different scene:
    // a model replaces the greybox shape, a material replaces the greybox style, and either falling
    // through leaves the piece as its collider, greyboxed when no material is assigned.
    const model = spec.model !== undefined ? (runtime?.model(spec.model) ?? null) : null
    const material = spec.material !== undefined ? (runtime?.material(spec.material) ?? null) : null
    let object: THREE.Object3D
    if (model !== null) {
      if (material !== null) model.traverse((o) => void (o instanceof THREE.Mesh && (o.material = material)))
      object = model
    } else {
      object = new THREE.Mesh(geometryForCollider(spec.collider), material ?? createGreyboxMaterial())
    }
    applyTransform(object, spec.transform.position, spec.transform.rotation, spec.transform.scale)
    object.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true
        o.receiveShadow = true
      }
    })
    holder.add(object)
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
  // Authored transforms are only where *static* items sit. An animated one belongs at its track's pose for
  // the current playhead — which at 0 is where the game starts it, so the two now agree (ADR 0029).
  applyPreviewPoses()
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

const rebuildItemMeshes = (index: number): void => {
  const g = instanceGroups[index]
  if (g === undefined) return
  disposeMeshes(meshHolderOf(g)) // only this item's own meshes; its child items are siblings of the holder
  buildItemMeshes(g, index)
}

const rebuildSelectedMeshes = (): void => {
  if (selected === null) return
  rebuildItemMeshes(selected)
}

/**
 * Fetch what the document references but the runtime has not loaded yet, then `redraw`.
 *
 * The preload pass runs when a document *opens*, so it only ever covers the references that existed then.
 * Two ordinary edits add one mid-session: assigning a material, and placing a prefab file that brings its
 * own. Until the asset is fetched, `runtime.material(id)` is null and the piece greyboxes — which reads as
 * the editor having ignored the change, and is the shape of the bug that came with ADR 0028: a `style` was a
 * name the renderer resolved by itself and always applied instantly, a material is an asset that has to
 * arrive first.
 *
 * Cheap to call on every edit: `load` skips ids it already holds and shares in-flight fetches. The redraw is
 * conditional on the document still being the one we loaded for — a fetch that lands after the user has
 * opened something else has nothing to draw into, and that document ran its own preload anyway.
 */
const loadNewReferences = (redraw: () => void): void => {
  const r = runtime
  const forDoc = doc
  if (r === null || forDoc === null) return
  void r
    .load(forDoc.assetIds())
    .then(() => {
      if (doc === forDoc) redraw()
    })
    .catch((e: unknown) => setProblem(`assets did not load (${String(e)}) — restart pnpm dev:editor`))
}

/**
 * The track helper: the path a keyframed item follows, drawn in the viewport (ADR 0029).
 *
 * This is where *space* is edited. A line through every positioned key with a handle on each, so the shape
 * of the motion is visible and draggable with the same gizmo as everything else — the timeline strip only
 * ever says *when*. It replaces a widget that could draw one straight line for one `move` behavior, which
 * was all the old vocabulary could express.
 *
 * The polyline is exact rather than sampled: easing changes when the item is between two keys and never
 * where, since every segment is a straight line in space.
 */
const pathLineMat = new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, toneMapped: false })
const keyDotMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, toneMapped: false, depthTest: false })
const keyDotActiveMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, depthTest: false })
const keyDotGeo = new THREE.SphereGeometry(0.11, 12, 8)
const trackHelper = new THREE.Group()
trackHelper.renderOrder = 10
stage.scene.add(trackHelper)

/** Key handles, so a viewport click can say which key it hit. */
let keyHandles: THREE.Mesh[] = []

const clearTrackHelper = (): void => {
  for (const c of [...trackHelper.children]) {
    trackHelper.remove(c)
    if (c instanceof THREE.Line) c.geometry.dispose() // dot geometry and every material are shared
  }
  keyHandles = []
}

const updateTrackHelper = (): void => {
  clearTrackHelper()
  trackHelper.visible = false
  if (selected === null || doc === null || playing) return
  const keys = selectedKeys()
  const g = instanceGroups[selected]
  if (keys === null || keys.length === 0 || g === undefined) return
  const points = pathPoints(keys)
  if (points.length === 0) return // a spin-only track has no path to draw

  // Key positions are *local* poses, so they are placed by the item's parent — which for a nested item is
  // another animated group, and that is exactly right: the path is drawn where the motion happens.
  const parent = g.parent ?? instanceRoot
  parent.updateWorldMatrix(true, false)
  const world = points.map((p) => parent.localToWorld(new THREE.Vector3(p.position.x, p.position.y, p.position.z)))

  if (world.length > 1) trackHelper.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(world), pathLineMat))

  const positioned = keyRows(keys).filter((r) => r.hasPosition)
  world.forEach((at, n) => {
    const row = positioned[n]
    if (row === undefined) return
    const dot = new THREE.Mesh(keyDotGeo, row.index === activeKey ? keyDotActiveMat : keyDotMat)
    dot.position.copy(at)
    dot.userData.keyIndex = row.index
    trackHelper.add(dot)
    keyHandles.push(dot)
  })
  trackHelper.visible = true
}

// Re-derive markers/triggers + physics from the current doc (after edits; also a validity check).
const rebuildLoaded = (): void => {
  if (doc === null) return
  world?.free()
  world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
  try {
    loaded = instantiateNodeLevel(world, doc.asLevel(), DEFAULT_REGISTRY)
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
  // The document's own preload, and the only one there is. `reloadAssets` also loads `doc.assetIds()`, but
  // at boot it runs *before* the first document exists, so that call has always been over an empty list —
  // which left every open drawing against an empty runtime, and every material in the viewport greyboxed.
  // Deselected above, so the re-`buildItems` has no gizmo to re-attach.
  loadNewReferences(buildItems)
}

/** Open a file — the stack starts over at its root. */
const setDoc = (next: Doc, name: string): void => {
  docStack.length = 0
  docStack.push({ doc: next, label: `${next.mode}: ${name}` })
  fileState.name = name
  showDoc()
  // Another file's edits are not this one's, and its snapshots would restore the wrong document entirely.
  resetHistory()
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

/** A component with a stable id — blank documents are authored here, so the ids may as well read plainly. */
const comp = (id: string, type: string, params: Record<string, unknown>): ComponentData => ({ id, type, params })

/**
 * No material on the slab: greybox is what "nobody has surfaced this yet" looks like, and it is truthful for
 * something a new level got for free. Hardcoding a material id here would also be a tool-source reference to
 * a content file somebody is free to delete.
 */
const blankLevel = (id: string): NodeLevel => ({
  id,
  config: { fallBehavior: 'respawn-checkpoint', fallY: -10 },
  // A literal ground slab: there are no makers to call any more (ADR 0027), and a new level still has to have
  // something to stand on.
  nodes: [
    {
      id: 'ground',
      name: 'ground',
      transform: { position: vec3(0, -0.5, 0) },
      components: [
        comp('c0', COLLIDER, { shape: { kind: 'box', halfExtents: vec3(10, 0.5, 10) }, center: vec3(0, 0, 0) }),
        comp('c1', RENDERER, { material: '' }),
      ],
    },
    { id: 'spawn', name: 'spawn', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', SPAWN, {})] },
  ],
})

/** A new prefab: a root that carries only a transform, and one pad under it that carries the geometry. */
const blankPrefab = (id: string): SceneNode => ({
  id: 'root',
  name: id,
  transform: { position: vec3(0, 0, 0) },
  components: [],
  children: [
    {
      id: 'pad',
      name: 'pad',
      transform: { position: vec3(0, 0, 0) },
      components: [
        comp('c0', COLLIDER, { shape: { kind: 'box', halfExtents: vec3(1.5, 0.15, 1.5) }, center: vec3(0, 0, 0) }),
        comp('c1', RENDERER, { material: '' }),
      ],
    },
  ],
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

// ============================== animation editing (ADR 0029) ==============================
/**
 * The playhead, in milliseconds into the selected item's track. It poses **every** animated item, not only
 * the selection: scrubbing is meant to show what the level does at that instant, and a lift that ignored the
 * playhead while the bar beside it moved would be worse than not scrubbing at all.
 */
let previewMs = 0
/** The strip's own playback. Separate from `playing`, which is the real game loop with pointer lock. */
let previewing = false
let previewLastFrame = 0
/**
 * The key the gizmo is editing, or `null` for the item as a whole.
 *
 * Selecting a key also parks the playhead on it (the timeline does that), so the item is *already* drawn at
 * that key's pose — which is why the gizmo needs no proxy object to drag. It edits what it is sitting on.
 */
let activeKey: number | null = null
/**
 * Which keyframe parameter the timeline has open: a component on the selected node, and one of its `keys`
 * parameters (`KeyEditor`).
 *
 * Re-resolved on every selection change. When the new selection has exactly one keyframe parameter the strip
 * follows it, which is the common case and what "select the platform and edit its animation" should feel like;
 * the Inspector's **Edit keys** button is what picks a different one.
 */
let keyTarget: KeyEditor | null = null
/**
 * What each selected item looked like when the current drag began.
 *
 * Two jobs, both needing the *starting* state rather than the running one. An animated item with no key
 * selected has its whole track offset by one delta, so accumulating per pointer event would multiply it. And a
 * multi-selection mirrors the primary's delta onto everything else, which is meaningless without the pose each
 * of them started from (ADR 0031).
 */
interface DragStart {
  pose: Pose
  scale: Vec3
  keys: readonly Keyframe[] | null
}
let dragStart = new Map<number, DragStart>()

/** Pose every item from its track at the playhead. Static items sit at their authored transform. */
const applyPreviewPoses = (): void => {
  if (doc === null) return
  for (let i = 0; i < doc.count(); i++) {
    const g = instanceGroups[i]
    if (g === undefined) continue
    const pose = doc.poseOf(i, previewMs)
    g.position.set(pose.position.x, pose.position.y, pose.position.z)
    const q = eulerToQuat(pose.rotation)
    g.quaternion.set(q.x, q.y, q.z, q.w)
    // Scale is not animated: a track that resized a collider would rebuild physics every tick.
  }
}

const setPreviewTime = (ms: number): void => {
  previewMs = Math.max(0, ms)
  applyPreviewPoses()
  updateTrackHelper()
  inspectorSync()
  timeline.syncHead()
  renderStatus()
}

/**
 * The playhead moving during playback, sixty times a second. Deliberately narrower than `setPreviewTime`:
 * the path handles cannot have moved, and rebuilding their geometry every frame would churn a Line buffer
 * and a dozen meshes per frame for a picture that is identical.
 */
const advancePreviewTime = (ms: number): void => {
  previewMs = Math.max(0, ms)
  applyPreviewPoses()
  timeline.syncHead()
}

const setActiveKey = (index: number | null): void => {
  activeKey = index
  updateTrackHelper()
}

/**
 * The keys of an item's first keyframe parameter, or `null` when it has none.
 *
 * Per *item*, not per selection: a multi-selection drag writes each item back through its own component, and
 * the strip's target only says what the panel has open.
 */
const keysOfItem = (index: number): readonly Keyframe[] | null => {
  if (doc === null) return null
  const editor = doc.keyEditors(index)[0]
  return editor === undefined ? null : doc.keysOf(index, editor)
}

/** The keys the strip has open, or `null` when the selection has no keyframe parameter. */
const selectedKeys = (): readonly Keyframe[] | null =>
  selected === null || doc === null || keyTarget === null ? null : doc.keysOf(selected, keyTarget)

/**
 * How the open component says its keys repeat, for the strip's own preview clock.
 *
 * Read off the component by name rather than through a Track-shaped accessor: a keyframe parameter is what the
 * strip edits, and `loop` is just another parameter of whatever declares it. Anything that does not declare one
 * previews as a plain loop.
 */
const keyLoopMode = (): string => {
  if (selected === null || doc === null || keyTarget === null) return 'loop'
  const c = doc.components(selected).find((x) => x.id === keyTarget?.componentId)
  return typeof c?.params.loop === 'string' ? c.params.loop : 'loop'
}

/**
 * Replace the open keys, then redraw everything they affect: the item's pose at the playhead, the path
 * handles, the physics instance, and the strip.
 */
const setSelectedKeys = (keys: readonly Keyframe[]): void => {
  if (selected === null || doc === null || keyTarget === null) return
  doc.setKeys(selected, keyTarget, keys)
  recordEdit('animation')
  applyPreviewPoses()
  updateTrackHelper()
  scheduleRebuild()
  timeline.render()
  hierarchy.render()
  renderStatus()
}

let gizmoDragged = false
/**
 * A drag is in flight, so the gizmo owns the selection's pose.
 *
 * Separate from `gizmoDragged`, which latches for the click handler. This one gates the *other* way into a
 * transform — the Inspector's numeric fields — because a typed value cannot legitimately arrive from a person
 * mid-drag, and letting one through mid-drag re-poses the item from the document underneath the drag.
 */
let gizmoDragging = false
gizmo.addEventListener('dragging-changed', (event) => {
  const dragging = event.value as boolean
  controls.enabled = !dragging
  gizmoDragging = dragging
  if (dragging) {
    gizmoDragged = true
    // One history entry per drag, recorded when it ends. `coalescing` suppresses the hundred notifications in
    // between, which is also what leaves `baseline` sitting on the pre-drag state for that one record to use.
    coalescing = true
    dragStart = new Map()
    if (doc !== null) {
      for (const i of selection) {
        const g = instanceGroups[i]
        if (g === undefined) continue
        const itsKeys = keysOfItem(i)
        const whole = itsKeys !== null && itsKeys.length > 0 && activeKey === null
        dragStart.set(i, {
          // Read off the group, not from `poseOf`, though at this instant they agree: every value compared
          // against it later is also read off a group, so both sides share one rounding and one euler branch.
          // Mixing the stored euler with a re-derived one leaves a residue in the delta that accumulates.
          pose: groupPose(g),
          scale: vec3(g.scale.x, g.scale.y, g.scale.z),
          // Only when the whole track is being moved: with a key selected the gizmo writes that key outright.
          keys: whole ? itsKeys : null,
        })
      }
    }
  } else {
    coalescing = false
    recordEdit(selection.length > 1 ? `${edit.mode} ${selection.length}` : edit.mode)
    dragStart = new Map()
    rebuildLoaded()
  }
})
gizmo.addEventListener('objectChange', () => {
  writeBackSelected()
  mirrorDragToSelection()
  inspectorSync()
  updateTrackHelper()
})

/**
 * Apply the primary's drag delta to every other selected item (ADR 0031).
 *
 * Translation is a shared world delta, which is the obvious reading of dragging five platforms. Rotation and
 * scale apply the same **local** delta to each item about its own origin — they do *not* orbit the selection
 * about a shared pivot, which is what Unity does and what this deliberately is not: orbiting needs a pivot
 * object and a decision about where the pivot goes, and moving five things by the same amount is the case
 * that actually comes up when laying out a level.
 */
const mirrorDragToSelection = (): void => {
  if (selection.length < 2 || selected === null || doc === null) return
  // Dragging a keyframe is single-item by nature: `activeKey` indexes the *primary's* track, and applying that
  // index to another item's keys would rewrite whichever key happened to sit at that position.
  if (activeKey !== null) return
  const primaryStart = dragStart.get(selected)
  const primaryGroup = instanceGroups[selected]
  if (primaryStart === undefined || primaryGroup === undefined) return

  const now = groupPose(primaryGroup)
  // Rotation as a local delta about each item's own origin, and scale as a ratio — a difference would be
  // meaningless for scale, and a zero start would make the ratio meaningless too.
  const dr = vec3(now.rotation.x - primaryStart.pose.rotation.x, now.rotation.y - primaryStart.pose.rotation.y, now.rotation.z - primaryStart.pose.rotation.z)
  const ds = vec3(
    primaryStart.scale.x === 0 ? 1 : primaryGroup.scale.x / primaryStart.scale.x,
    primaryStart.scale.y === 0 ? 1 : primaryGroup.scale.y / primaryStart.scale.y,
    primaryStart.scale.z === 0 ? 1 : primaryGroup.scale.z / primaryStart.scale.z,
  )

  /**
   * Translation is shared in **world** space, then converted into each item's own parent frame.
   *
   * A local delta would only be right for items that share a parent. Selecting a top-level platform and a crate
   * nested under a moving deck is ordinary, and their local frames differ by the deck's whole transform — so a
   * local delta would send the crate somewhere unrelated to the drag.
   */
  const worldOf = (group: THREE.Object3D, local: Vec3): THREE.Vector3 => {
    const parent = group.parent ?? instanceRoot
    parent.updateWorldMatrix(true, false)
    return parent.localToWorld(new THREE.Vector3(local.x, local.y, local.z))
  }
  const worldDelta = worldOf(primaryGroup, now.position).sub(worldOf(primaryGroup, primaryStart.pose.position))

  for (const i of selection) {
    if (i === selected) continue
    const g = instanceGroups[i]
    const start = dragStart.get(i)
    if (g === undefined || start === undefined) continue

    // Posed from the *start* pose plus the delta, never from the running one: a hundred pointer events during
    // one drag must produce one offset, not a hundred compounding ones.
    const parent = g.parent ?? instanceRoot
    parent.updateWorldMatrix(true, false)
    const target = parent.worldToLocal(worldOf(g, start.pose.position).add(worldDelta))
    g.position.copy(target)
    const q = eulerToQuat(vec3(start.pose.rotation.x + dr.x, start.pose.rotation.y + dr.y, start.pose.rotation.z + dr.z))
    g.quaternion.set(q.x, q.y, q.z, q.w)
    g.scale.set(start.scale.x * ds.x, start.scale.y * ds.y, start.scale.z * ds.z)
    writeBackItem(i)
  }
}

/**
 * Where a gizmo drag lands, which depends on whether the item is animated (ADR 0029).
 *
 * - **No track**: the authored transform, as it always did.
 * - **A key selected**: that key's pose. The item is drawn at the key (the playhead is parked on it), so the
 *   gizmo is dragging the key itself.
 * - **A track, no key selected**: every key offsets by the same delta. This is the only coherent answer —
 *   position keys override the authored transform, so writing the transform would move nothing on screen and
 *   read as the editor ignoring the drag. Dragging an animated platform moves its whole path, which the
 *   visible polyline then shows.
 *
 * A channel the track does not animate falls through to the authored transform, so rotating a
 * translation-only lift tilts the lift rather than inventing a one-key rotation channel that would freeze it.
 */
const writeBackItem = (index: number): void => {
  if (doc === null) return
  const g = instanceGroups[index]
  if (g === undefined) return
  const keys = keysOfItem(index)
  if (keys !== null && keys.length > 0) {
    writeBackIntoTrack(index, keys, g)
    return
  }
  doc.setTransform(index, transformOfGroup(g))
}

/** The primary's own write-back — what a gizmo drag or a typed Inspector value lands on first. */
const writeBackSelected = (): void => {
  if (selected !== null) writeBackItem(selected)
}

/**
 * A group's local pose as a `Transform`, with `rotation`/`scale` left out when they are the identity.
 *
 * Built and handed to `doc.setTransform` rather than mutating what `transformOf` returned: for an overridden
 * piece those are different objects, since reading gives the prefab's value and writing creates the
 * placement's own (ADR 0033).
 */
const transformOfGroup = (g: THREE.Group): Transform => {
  const e = new THREE.Euler().setFromQuaternion(g.quaternion, 'XYZ')
  return {
    position: vec3(r4(g.position.x), r4(g.position.y), r4(g.position.z)),
    ...(isZeroRot(e) ? {} : { rotation: vec3(r4(e.x), r4(e.y), r4(e.z)) }),
    ...(isOne(g.scale) ? {} : { scale: vec3(r4(g.scale.x), r4(g.scale.y), r4(g.scale.z)) }),
  }
}

const groupPose = (g: THREE.Group): Pose => {
  const e = new THREE.Euler().setFromQuaternion(g.quaternion, 'XYZ')
  return { position: vec3(r4(g.position.x), r4(g.position.y), r4(g.position.z)), rotation: vec3(r4(e.x), r4(e.y), r4(e.z)) }
}

const writeBackIntoTrack = (index: number, keys: readonly Keyframe[], g: THREE.Group): void => {
  if (doc === null) return
  const editor = doc.keyEditors(index)[0]
  if (editor === undefined) return
  const pose = groupPose(g)
  const usesPosition = keys.some((k) => k.position !== undefined)
  const usesRotation = keys.some((k) => k.rotation !== undefined)

  // Scale is never animated, so it always belongs to the authored transform. Same for a channel with no
  // keys: there is nothing to write it into. Anything the track *does* animate keeps whatever the transform
  // already said, since the track overrides it.
  const authored = doc.transformOf(index)
  const rot = new THREE.Euler(pose.rotation.x, pose.rotation.y, pose.rotation.z)
  doc.setTransform(index, {
    position: usesPosition ? authored.position : pose.position,
    ...(usesRotation ? (authored.rotation !== undefined ? { rotation: authored.rotation } : {}) : isZeroRot(rot) ? {} : { rotation: pose.rotation }),
    ...(isOne(g.scale) ? {} : { scale: vec3(r4(g.scale.x), r4(g.scale.y), r4(g.scale.z)) }),
  })

  if (activeKey !== null) {
    doc.setKeys(
      index,
      editor,
      setKeyPose(keys, activeKey, {
        ...(usesPosition ? { position: pose.position } : {}),
        ...(usesRotation ? { rotation: pose.rotation } : {}),
      }),
    )
    return
  }

  // No key selected: offset the whole track, against this item's *starting* snapshot — so a hundred pointer
  // events during one drag produce one offset rather than a hundred compounding ones.
  const from = dragStart.get(index)
  if (from === undefined || from.keys === null) return
  const dp = vec3(pose.position.x - from.pose.position.x, pose.position.y - from.pose.position.y, pose.position.z - from.pose.position.z)
  const dr = vec3(pose.rotation.x - from.pose.rotation.x, pose.rotation.y - from.pose.rotation.y, pose.rotation.z - from.pose.rotation.z)
  doc.setKeys(
    index,
    editor,
    from.keys.map((k) => ({
      ...k,
      ...(k.position !== undefined ? { position: vec3(r4(k.position.x + dp.x), r4(k.position.y + dp.y), r4(k.position.z + dp.z)) } : {}),
      ...(k.rotation !== undefined ? { rotation: vec3(r4(k.rotation.x + dr.x), r4(k.rotation.y + dr.y), r4(k.rotation.z + dr.z)) } : {}),
    })),
  )
}

/**
 * Point the editor at a selection. Everything derived from it is refreshed here, so no caller has to remember
 * the list: the gizmo goes on the primary, the Inspector and the timeline follow it, and the track helper
 * redraws.
 */
const applySelection = (next: readonly number[]): void => {
  // Editing is suspended during play, and the item meshes are hidden — attaching a gizmo to one would put a
  // handle in mid-air over a level you are walking. The Hierarchy panel can reach here too, so the guard
  // belongs on the selection itself rather than on the viewport's click handler alone.
  if (playing) return
  // The Inspector shows one thing: a scene item or an asset, never both.
  if (selectedAsset !== null && next.length > 0) {
    selectedAsset = null
    assetInspector.show(null)
  }
  selection = clampTo(next, doc?.count() ?? 0)
  const primary = primaryOf(selection)
  selected = primary
  activeKey = null // a fresh selection edits the object, not whichever key the last one was on
  keyTarget = primary === null || doc === null ? null : (doc.keyEditors(primary)[0] ?? null)

  const g = primary === null ? undefined : instanceGroups[primary]
  if (g === undefined) gizmo.detach()
  else gizmo.attach(g)

  inspectorRebuild()
  updateTrackHelper()
  timeline.render()
  uiChanged()
  // After the panel has been rebuilt, not before: a nested object selected in the viewport is inside a
  // collapsed parent as often as not, and marking a row nobody can see is the same as not marking it.
  if (primary !== null) hierarchy.reveal(primary)
}

/** Select one item outright — the plain click, and what every command that lands on a new item does. */
const select = (index: number): void => {
  if (instanceGroups[index] === undefined || doc === null) return
  applySelection([index])
}

/** A click that carries modifiers: Ctrl toggles one, Shift extends a range over `order`. */
const selectWith = (index: number, mode: SelectMode, order: readonly number[]): void => {
  if (instanceGroups[index] === undefined || doc === null) return
  applySelection(applySelect(selection, index, mode, order))
}

const deselect = (): void => {
  selection = []
  selected = null
  activeKey = null
  gizmo.detach()
  inspectorRebuild()
  updateTrackHelper()
  timeline.render()
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

/** Point the raycaster at a client position. Shared by picking, placement and the right-click menu. */
const castFrom = (clientX: number, clientY: number): void => {
  const rect = canvas.getBoundingClientRect()
  ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
  raycaster.setFromCamera(ndc, stage.camera)
}

/** The document index under a client position, or `null`. */
const indexUnder = (clientX: number, clientY: number): number | null => {
  castFrom(clientX, clientY)
  const hit = raycaster.intersectObjects(instanceRoot.children, true)[0]?.object
  let o: THREE.Object3D | null = hit ?? null
  while (o !== null && o.userData.index === undefined) o = o.parent
  return o !== null && typeof o.userData.index === 'number' ? o.userData.index : null
}

/**
 * The world point under a client position: the surface hit, or the ground plane behind it, snapped like a
 * placement. `null` when the ray leaves the world entirely — pointing at the sky above the horizon.
 */
const surfaceUnder = (clientX: number, clientY: number): Vec3 | null => {
  castFrom(clientX, clientY)
  const surf = raycaster.intersectObjects(instanceRoot.children, true)[0]
  const point = new THREE.Vector3()
  if (surf !== undefined) point.copy(surf.point)
  else if (raycaster.ray.intersectPlane(groundPlane, point) === null) return null
  const snap = edit.snap ? edit.step : 0
  const sx = snap !== 0 ? Math.round(point.x / snap) * snap : r4(point.x)
  const sz = snap !== 0 ? Math.round(point.z / snap) * snap : r4(point.z)
  return vec3(sx, r4(point.y), sz)
}

canvas.addEventListener('pointerup', (e) => {
  // Left button only. Without this a right-click placed the armed prefab and moved the selection on its way
  // to opening a menu, which is the sort of thing that gets blamed on the menu.
  if (e.button !== 0) return
  if (playing) return // editing suspended during play (pointer = camera only)
  if (gizmoDragged) return // was dragging the gizmo, not a click
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return // was an orbit drag
  castFrom(e.clientX, e.clientY)

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
    const at = vec3(sx, r4(point.y), sz)
    const prefabAsset = placing.kind === 'prefabAsset' ? assets?.prefabOf(placing.assetId) : undefined
    const idx =
      placing.kind === 'own'
        ? doc.place(placing.name, at)
        : placing.kind === 'model'
          ? doc.placeModel(placing.assetId, at)
          : prefabAsset !== undefined
            ? doc.placePrefab(prefabAsset, assets?.db.byId[placing.assetId]?.name ?? prefabAsset.name ?? prefabAsset.id, at)
            : -1
    if (idx < 0) {
      setStatus('that prefab did not load')
      placing = null
      return
    }
    placing = null
    recordEdit('place')
    buildItems()
    rebuildLoaded()
    select(idx)
    // A placed prefab file can reference a material this document had never named before.
    loadNewReferences(() => {
      buildItems() // resets the item groups, so the gizmo has to be re-attached
      select(idx)
    })
    return
  }

  // A key handle wins over the geometry behind it: the dots sit on the path, which is usually inside or
  // beside the thing being animated, and a click meant for a handle should never reselect the object.
  const keyHit = keyHandles.length > 0 ? raycaster.intersectObjects(keyHandles, false)[0] : undefined
  if (keyHit !== undefined) {
    const index = keyHit.object.userData.keyIndex as number
    setActiveKey(index)
    const keys = selectedKeys()
    const key = keys === null ? undefined : keyRows(keys)[index]
    if (key !== undefined) setPreviewTime(key.t)
    timeline.render()
    return
  }

  const hit = raycaster.intersectObjects(instanceRoot.children, true)[0]?.object
  if (hit === undefined) {
    // Ctrl-clicking empty space is a miss, not "clear everything": losing a five-item selection to a stray
    // click is the kind of thing that makes people stop using multi-select.
    if (!e.ctrlKey && !e.metaKey) deselect()
    return
  }
  let o: THREE.Object3D | null = hit
  while (o !== null && o.userData.index === undefined) o = o.parent
  if (o !== null && typeof o.userData.index === 'number') {
    // Ctrl toggles in the viewport, as it does in the Hierarchy. Shift is *not* offered here: a range needs an
    // order, and the viewport has none — what looks adjacent on screen is an accident of the camera.
    const mode = modeFor(e)
    selectWith(o.userData.index, mode === 'range' ? 'toggle' : mode, [])
  }
})

/**
 * The selection reduced to what a structural operation should act on: **roots only**, highest index first.
 *
 * Roots, because deleting a parent takes its children with it and duplicating both would produce the child
 * twice. Descending, because removing or inserting only shifts the indices *after* the node touched — so
 * working from the bottom up leaves every index still to be processed valid, with no bookkeeping.
 */
const selectionRoots = (): number[] => {
  const open = doc
  return open === null ? [] : rootsOf(selection, (i) => open.depthOf(i)).sort((a, b) => b - a)
}

const deleteSelected = (): void => {
  if (doc === null || selection.length === 0) return
  const roots = selectionRoots()
  for (const i of roots) doc.remove(i)
  recordEdit(roots.length > 1 ? `delete ${roots.length}` : 'delete')
  deselect()
  buildItems()
  rebuildLoaded()
}

const duplicateSelected = (): void => {
  if (doc === null || selection.length === 0) return
  const made: number[] = []
  for (const i of selectionRoots()) {
    const before = doc.count()
    const at = doc.duplicate(i)
    // A copy is a whole subtree, so it inserts more than one node. Everything already recorded sits after this
    // insertion point (we are working downward), so it shifts by however many nodes went in.
    const inserted = doc.count() - before
    for (let n = 0; n < made.length; n++) made[n]! += inserted
    made.push(at)
  }
  recordEdit(made.length > 1 ? `duplicate ${made.length}` : 'duplicate')
  buildItems()
  rebuildLoaded()
  // Reversed, so the primary ends up on the copy of what was the primary rather than on the lowest one.
  applySelection(made.reverse())
}
/** Give an inline one-off a shared identity, so it can be referenced and edited in one place. */
const extractSelected = (): void => {
  if (selected === null || doc === null) return
  const id = doc.extract(selected)
  if (id === null) return
  recordEdit('extract to prefab')
  inspectorRebuild() // the link row flips from "not linked" to the new prefab
  uiChanged() // the level's own entries are placeable too, and the row gains a badge
  setStatus(`extracted to prefab "${id}"`)
}

/**
 * The editor's shortcuts (ADR 0030).
 *
 * Matched by the **character** each key produces, not by its physical position, so Ctrl+Z is the key marked Z
 * on QWERTY, AZERTY, Dvorak and the rest. `shortcuts.ts` carries the reasoning and the fallback for layouts
 * where the character cannot answer.
 *
 * Declared as data rather than as an if-chain so the table is the single answer to "what does this key do",
 * duplicates fail loudly instead of one silently losing, and a cheat sheet can be generated from it.
 */
const editorShortcuts = createShortcuts([
  { id: 'undo', chords: ['mod+z'], label: 'Undo', run: () => undo(), enabled: () => !playing },
  // Both spellings: Ctrl+Y is the Windows convention and Ctrl+Shift+Z the one every other editor also takes.
  { id: 'redo', chords: ['mod+y', 'mod+shift+z'], label: 'Redo', run: () => redo(), enabled: () => !playing },
  { id: 'copy', chords: ['mod+c'], label: 'Copy', run: () => copySelected(), enabled: () => !playing && selection.length > 0 },
  { id: 'cut', chords: ['mod+x'], label: 'Cut', run: () => cutSelected(), enabled: () => !playing && selection.length > 0 },
  { id: 'paste', chords: ['mod+v'], label: 'Paste', run: () => pasteClipboard(false), enabled: () => !playing && clipboard.length > 0 },
  {
    id: 'paste-child',
    chords: ['mod+shift+v'],
    label: 'Paste as child',
    run: () => pasteClipboard(true),
    enabled: () => !playing && clipboard.length > 0 && selected !== null,
  },
  { id: 'duplicate', chords: ['mod+d'], label: 'Duplicate', run: () => duplicateSelected(), enabled: () => !playing && selection.length > 0 },
  {
    id: 'delete',
    chords: ['delete', 'backspace'],
    label: 'Delete',
    run: () => deleteSelected(),
    enabled: () => !playing && selection.length > 0,
  },
  {
    id: 'select-all',
    chords: ['mod+a'],
    label: 'Select all',
    run: () => applySelection(doc === null ? [] : Array.from({ length: doc.count() }, (_, i) => i)),
    enabled: () => !playing && doc !== null && doc.count() > 0,
  },
  // The menu offers Focus with `F` beside it, so the key has to exist or the menu is lying.
  { id: 'focus', chords: ['f'], label: 'Focus the selection', run: () => focusSelection(), enabled: () => !playing && selection.length > 0 },
  { id: 'translate', chords: ['t', 'g'], label: 'Translate tool', run: () => setMode('translate'), enabled: () => !playing },
  { id: 'rotate', chords: ['r'], label: 'Rotate tool', run: () => setMode('rotate'), enabled: () => !playing },
  { id: 'scale', chords: ['s'], label: 'Scale tool', run: () => setMode('scale'), enabled: () => !playing },
  {
    id: 'cancel',
    chords: ['escape'],
    label: 'Cancel / deselect',
    run: () => {
      if (playing) {
        stopPlay()
        return
      }
      if (placing !== null) {
        placing = null
        setStatus('placement cancelled')
        refreshUi()
      } else deselect()
    },
    // The only binding that stays live during play, because it is the way out of it.
    enabled: () => true,
  },
])

window.addEventListener('keydown', (e) => {
  editorShortcuts.handle(e)
})



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

/** The live components while playing. Detached on stop, so a component's teardown runs like the game's. */
let playComponents: ComponentRuntime | null = null

const startPlay = (): void => {
  if (doc === null || playing) return
  // Two clocks running at once would be two answers to "where is this platform". Play wins: it is the real
  // one, and the track helper hides itself while playing anyway.
  setPreviewing(false)
  rebuildLoaded() // fresh world + loaded from the current data
  if (loaded === null || world === null) return
  deselect()
  const sm = loaded.markers.find((m) => m.kind === 'spawn')?.position
  const spawn: Vec3 = sm !== undefined ? { x: sm.x, y: sm.y + STAND_OFFSET, z: sm.z } : { x: 0, y: 3, z: 0 }
  char = addCharacter(world, spawn)
  let respawnPos: Vec3 = { ...spawn }
  let cpIndex = -1
  let killed = false
  const fallY = loaded.config.fallY

  /**
   * Play-in-place runs **the same components the game runs** — the rules are theirs now, so this probe cannot
   * drift from the mode by forgetting to mirror a branch. It differs only in what dying means: no ragdoll, no
   * persistence, just a teleport back.
   */
  const checkpoints = loaded.nodes.filter((n) => hasComponent(n.components, Checkpoint))
  playComponents = createComponentRuntime(loaded, DEFAULT_REGISTRY, {
    character: characterAccess(char),
    effects: {
      kill: () => void (killed = true),
      progress: (node) => {
        const i = checkpoints.indexOf(node)
        if (i < 0 || i <= cpIndex) return
        cpIndex = i
        respawnPos = { x: node.position.x, y: node.position.y + STAND_OFFSET, z: node.position.z }
      },
    },
  })
  let playTick = 0
  playComponents.attach(playTick, 0, TICK_DT)

  // One fixed step of platform time per fixed step — see @mp/core simClock (reading the wall
  // clock inside the tick stalls the platforms during a multi-tick wake and jitters carry).
  const simClock = createSimClock({ tickMs: TICK_DT * 1000, reference: () => performance.now() })

  const local: LocalWorld = {
    applyInput: (cmd) => {
      if (world === null || loaded === null || char === null) return
      const nowMs = simClock.tick()
      loaded.update(nowMs, char.base?.colliderHandle) // only the ridden piece is frozen
      playComponents?.fixedUpdate(++playTick, nowMs, TICK_DT)
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
      killed = false
      playComponents?.contact(char.body.collisions())
      const p = char.body.translation()
      if (killed || p.y < fallY) {
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
  playComponents?.detach()
  playComponents = null
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

/** Prefab assets, by name — what the file picker offers in prefab mode. */
const prefabEntries = (): AssetEntry[] => (assets === null ? [] : assetsOfKind(assets.db, 'prefab'))

const openFile = async (name: string): Promise<void> => {
  try {
    if (fileState.mode === 'level') {
      openPrefabAsset = null
      setDoc(levelDoc(await loadLevel(name), userPrefabs), name)
      return
    }
    // A prefab is an asset now, so it is opened by id and saved back to its own path.
    const entry = prefabEntries().find((e) => e.name === name)
    const prefab = entry === undefined ? undefined : assets?.prefabOf(entry.id)
    if (entry === undefined || prefab === undefined) {
      setStatus(`no prefab asset named ${name}`)
      return
    }
    openPrefabAsset = entry.id
    setDoc(prefabDoc(prefab), name)
  } catch (e) {
    setStatus(`load failed: ${String(e)}`)
  }
}

/**
 * The palette's library of prefab files, keyed by name. Two prefabs with the same name in different folders
 * collide here and the later one wins; placing from the Project explorer is by asset id and has no such
 * ambiguity, which is the path to prefer.
 */
const refreshPrefabLibrary = (): void => {
  for (const k of Object.keys(userPrefabs)) delete userPrefabs[k]
  for (const entry of prefabEntries()) {
    const prefab = assets?.prefabOf(entry.id)
    if (prefab !== undefined) userPrefabs[entry.name] = prefab
  }
}

const refreshFileList = async (): Promise<void> => {
  fileNames = fileState.mode === 'level' ? await listFiles('levels').catch(() => [] as string[]) : prefabEntries().map((e) => e.name)
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
      const write = async (): Promise<void> => {
        if (fileState.mode === 'level') {
          await saveFile('levels', fileState.name, root.toJSON())
          return
        }
        const prefab = root.toJSON() as SceneNode
        // Overwrite the asset it came from, or create one when this prefab has never been saved.
        if (openPrefabAsset !== null) await assets?.savePrefab(openPrefabAsset, prefab)
        else {
          const created = await assets?.createPrefab(`prefabs/${fileState.name}.prefab.json`, prefab)
          openPrefabAsset = created?.id ?? null
        }
      }
      void write()
        .then(async () => {
          setStatus(`saved ${fileState.name}`)
          previews.invalidate()
          await reloadAssets()
          refreshPrefabLibrary()
          await refreshFileList()
          refreshUi()
        })
        .catch((e: unknown) => setStatus(`save failed: ${String(e)}`))
    },
    newBlank: () => {
      const name = fileState.name || 'untitled'
      openPrefabAsset = null // a new prefab has no asset yet; the first Save creates one
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

/**
 * The editor's one context menu (`menu.ts`).
 *
 * **Placeholder wiring.** Right-clicking the Hierarchy opens it with a single item that does nothing, so the
 * look and the behaviour — where it opens near an edge, what dismisses it, how a disabled item reads — can be
 * judged before any of the real entries exist. The list of those is in the session notes; nothing here is it.
 */
const contextMenu: ContextMenu = createContextMenu()

// --- hierarchy ---
const hierarchy: Hierarchy = createHierarchy($<HTMLDivElement>('#hierarchy'), {
  doc: () => doc,
  selection: () => selection,
  onSelect: selectWith,
  onRename: (index, name) => {
    doc?.setName(index, name)
    recordEdit('rename')
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
    recordEdit(parent === doc.parentOf(landed) ? 'reorder' : 'reparent')
    if (local !== null) {
      const rot = new THREE.Euler(local.rotation.x, local.rotation.y, local.rotation.z, 'XYZ')
      const scale = new THREE.Vector3(local.scale.x, local.scale.y, local.scale.z)
      doc.setTransform(landed, {
        position: local.position,
        ...(isZeroRot(rot) ? {} : { rotation: vec3(r4(local.rotation.x), r4(local.rotation.y), r4(local.rotation.z)) }),
        ...(isOne(scale) ? {} : { scale: vec3(r4(local.scale.x), r4(local.scale.y), r4(local.scale.z)) }),
      })
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

/**
 * Drop this placement's overrides, or push them into the prefab.
 *
 * Named rather than inline in the Inspector's host, because the Hierarchy's menu offers the same two and a
 * second copy would be a second set of edge cases.
 */
const revertOverride = (field?: string): void => {
  if (selected === null || doc === null) return
  doc.revert(selected, field)
  recordEdit(field === undefined ? 'revert overrides' : `revert ${field}`)
  buildItems()
  rebuildLoaded()
  applySelection(selection)
  setStatus('reverted to the prefab')
}

/** Push this placement's overrides into the shared prefab. Named for the same reason as `revertOverride`. */
const applyOverrides = (): void => {
  if (selected === null || doc === null) return
  doc.applyToPrefab(selected)
  recordEdit('apply to prefab')
  buildItems()
  rebuildLoaded()
  applySelection(selection)
  setStatus('applied to the prefab — every instance follows')
}

/**
 * The Hierarchy's right-click menus.
 *
 * Almost every entry is a command that already existed and could only be reached from the keyboard or by a
 * gesture nobody discovers: rename was double-click only, Extract and Open lived in the Inspector's header,
 * and delete on an inherited node did nothing at all with no explanation. The menu is where they become
 * findable, which is why every disabled entry carries a reason rather than being left out.
 */
const menuFor = (index: number): MenuItem[] => {
  if (doc === null) return []
  const inherited = doc.kindOf(index) === 'inherited'
  const ref = doc.refOf(index)
  const shared = ref === null ? 0 : doc.refCount(ref)
  const own = !inherited
  const why = 'part of a prefab — its place belongs to the shared definition'
  return [
    { label: 'Rename', hint: 'double-click', run: () => hierarchy.beginRename(index) },
    {
      label: 'Add component',
      // The submenu the Inspector's Add Component button opens, reachable without going there first.
      items: doc.registry
        .all()
        .map((d) => d.type)
        .filter((type) => doc?.canAdd(index, type) === true)
        .map((type) => ({
          label: type,
          run: () => {
            doc?.addComponent(index, type)
            recordEdit('add component')
            scheduleRebuild()
            inspectorRebuild()
            uiChanged()
          },
        })),
    },
    { label: 'Create empty child', divider: true, enabled: own, why, run: () => createEmpty(index) },
    { label: 'Duplicate', hint: 'Ctrl+D', enabled: own, why, run: () => duplicateSelected() },
    { label: 'Delete', hint: 'Del', enabled: own, why, run: () => deleteSelected() },
    { label: 'Copy', hint: 'Ctrl+C', divider: true, enabled: own, why, run: () => copySelected() },
    { label: 'Cut', hint: 'Ctrl+X', enabled: own, why, run: () => cutSelected() },
    { label: 'Paste as child', hint: 'Ctrl+Shift+V', enabled: own && clipboard.length > 0, why: own ? 'nothing copied' : why, run: () => pasteClipboard(true) },
    {
      label: shared > 1 ? `Open prefab (${shared} placements)` : 'Open prefab',
      divider: true,
      enabled: ref !== null || inherited,
      why: 'not linked to a prefab',
      run: () => openPrefabOf(index),
    },
    {
      label: 'Extract to prefab',
      enabled: own && ref === null && doc.mode === 'level',
      why: ref !== null ? 'already a prefab' : doc.mode === 'prefab' ? 'already inside a prefab' : why,
      run: () => extractSelected(),
    },
    { label: 'Revert to prefab', divider: true, enabled: inherited && doc.overridesOf(index).length > 0, why: 'nothing overridden here', run: () => revertOverride() },
    { label: 'Apply to prefab', enabled: inherited && doc.overridesOf(index).length > 0, why: 'nothing overridden here', run: () => applyOverrides() },
  ]
}

/** The blank-space menu: what you can make when you are not pointing at anything. */
const blankMenu = (): MenuItem[] => [
  { label: 'Create empty object', run: () => createEmpty(null) },
  { label: 'Paste', hint: 'Ctrl+V', enabled: clipboard.length > 0, why: 'nothing copied', divider: true, run: () => pasteClipboard(false) },
  { label: 'Expand all', divider: true, run: () => hierarchy.setAllOpen(true) },
  { label: 'Collapse all', run: () => hierarchy.setAllOpen(false) },
]

/**
 * Create an empty node and select it.
 *
 * Placed at `at` when given (the point that was right-clicked), otherwise on the parent it groups, otherwise
 * at the camera's focus — which is where a new object is expected to appear rather than at the world origin.
 */
const createEmpty = (parent: number | null, at?: Vec3): void => {
  if (doc === null) return
  const where = at ?? (parent === null ? vec3(r4(controls.target.x), r4(controls.target.y), r4(controls.target.z)) : vec3(0, 0, 0))
  const landed = doc.placeEmpty(where, parent)
  if (landed < 0) {
    setStatus('nowhere to put that')
    return
  }
  recordEdit('create empty')
  buildItems()
  scheduleRebuild()
  select(landed)
  uiChanged()
}

/**
 * Frame the selection: put the orbit target on it and pull the camera back far enough to see all of it.
 *
 * Along the camera's *current* direction, so framing something never also spins the view — the one thing
 * that makes a focus command disorienting rather than useful. A bounding sphere rather than the box's
 * diagonal, so a long thin platform is framed by its length and not by a corner-to-corner measurement that
 * would push the camera into the next county.
 */
const focusSelection = (): void => {
  const box = new THREE.Box3()
  for (const i of selection) {
    const g = instanceGroups[i]
    if (g !== undefined) box.expandByObject(g)
  }
  if (box.isEmpty()) return
  const centre = box.getCenter(new THREE.Vector3())
  const radius = Math.max(0.5, box.getBoundingSphere(new THREE.Sphere()).radius)
  const back = stage.camera.position.clone().sub(controls.target)
  // Degenerate only if the camera is already at its own target, which the controls do not allow.
  if (back.lengthSq() < 1e-6) back.set(0, 1, 1)
  const distance = (radius / Math.tan((stage.camera.fov * Math.PI) / 360)) * 1.4
  controls.target.copy(centre)
  stage.camera.position.copy(centre).add(back.normalize().multiplyScalar(distance))
  controls.update()
}

/**
 * Paste at a world point rather than beside the selection.
 *
 * The **first** item lands on the point and the rest keep their offsets from it, so pasting a group of five
 * puts the group where you clicked instead of collapsing it onto one spot.
 */
const pasteAt = (point: Vec3): void => {
  if (doc === null || clipboard.length === 0) return
  const landed: number[] = []
  for (const item of clipboard) {
    const at = doc.paste(item, null)
    if (at >= 0) landed.push(at)
  }
  const first = landed[0]
  if (first === undefined) {
    setStatus(doc.mode === 'level' ? 'the clipboard holds prefab nodes, not placements' : 'the clipboard holds placements, not nodes')
    return
  }
  const from = doc.transformOf(first).position
  const d = vec3(point.x - from.x, point.y - from.y, point.z - from.z)
  for (const i of landed) {
    const t = doc.transformOf(i)
    doc.setTransform(i, { ...t, position: vec3(r4(t.position.x + d.x), r4(t.position.y + d.y), r4(t.position.z + d.z)) })
  }
  recordEdit(landed.length > 1 ? `paste ${landed.length} here` : 'paste here')
  buildItems()
  rebuildLoaded()
  applySelection(landed)
  loadNewReferences(() => {
    buildItems()
    applySelection(landed)
  })
}

/**
 * The viewport's right-click menu.
 *
 * On an object it is the Hierarchy's own list with Focus on top, because the same object should offer the same
 * things wherever it is right-clicked. On empty space it is what can be *made* at the point under the pointer.
 */
const viewportMenu = (index: number | null, point: Vec3 | null): MenuItem[] => {
  if (index !== null) return [{ label: 'Focus', hint: 'F', run: () => focusSelection() }, ...menuFor(index).map((m, n) => (n === 0 ? { ...m, divider: true } : m))]
  return [
    { label: 'Paste here', enabled: clipboard.length > 0 && point !== null, why: clipboard.length === 0 ? 'nothing copied' : 'no surface under the pointer', run: () => point !== null && pasteAt(point) },
    { label: 'Create empty here', enabled: point !== null, why: 'no surface under the pointer', run: () => createEmpty(null, point ?? undefined) },
    { label: 'Focus on the selection', divider: true, enabled: selection.length > 0, why: 'nothing selected', run: () => focusSelection() },
  ]
}

/**
 * Right-click in the viewport, opened on the **release** rather than the press.
 *
 * OrbitControls pans on right-drag, and `contextmenu` fires on the press — so at that moment there is no way
 * to know whether a pan is starting. Waiting for the release and checking that the pointer barely moved is
 * what lets both gestures share the button.
 */
let rightDownX = 0
let rightDownY = 0
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 2) return
  rightDownX = e.clientX
  rightDownY = e.clientY
})
// OrbitControls already suppresses the native menu on this element; done here too so the behaviour does not
// depend on its internals.
canvas.addEventListener('contextmenu', (e) => e.preventDefault())
canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 2 || playing || doc === null) return
  if (Math.hypot(e.clientX - rightDownX, e.clientY - rightDownY) > 4) return // was a pan
  const index = indexUnder(e.clientX, e.clientY)
  // Right-clicking an object selects it first, so the menu and the gizmo agree about the subject.
  if (index !== null && !selection.includes(index)) select(index)
  contextMenu.open(
    { x: e.clientX, y: e.clientY },
    viewportMenu(index, surfaceUnder(e.clientX, e.clientY)),
    index === null ? undefined : doc.label(index),
  )
})

$<HTMLDivElement>('#hierarchy').addEventListener('contextmenu', (e) => {
  e.preventDefault()
  if (playing || doc === null) return
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-index]')
  const index = row?.dataset.index === undefined ? null : Number(row.dataset.index)
  // Right-clicking a row selects it first: a menu that acts on a *different* object than the one under the
  // pointer is the classic way to delete the wrong thing.
  if (index !== null && !selection.includes(index)) select(index)
  contextMenu.open({ x: e.clientX, y: e.clientY }, index === null ? blankMenu() : menuFor(index), index === null ? undefined : doc.label(index))
})

// --- asset previews (thumbnails, cached) ---
const previews: Previews = createPreviews({
  db: () => assets?.db ?? null,
  runtime: () => runtime,
  materialOf: (id) => assets?.materialOf(id),
  urlOf: (path) => assets?.urlOf(path) ?? path,
  // A palette name is a kit maker, a prefab file, or one of this level's own entries — the same three
  // places `place` looks, so a tile previews exactly what clicking it would put in the scene.
  // A prefab tile's key is either a kit maker's name or a prefab asset's id; the two cannot collide, since
  // an id is 16 hex characters.
  prefabFor: (key) => doc?.prefabForPalette(key) ?? assets?.prefabOf(key),
  ensureLoaded: async (id) => {
    await runtime?.load([id])
  },
})

// --- project explorer (folder tree + assets + the kit) ---
/** Run a file operation, then rebuild the database — every one of them changes what is on disk. */
const afterFileOp = (label: string, run: () => Promise<void>): void => {
  void (async () => {
    try {
      await run()
    } catch (e) {
      setStatus(`${label} failed: ${String(e)}`)
      return
    }
    previews.invalidate()
    await reloadAssets()
    setStatus(label)
    refreshUi()
  })()
}

/** Arm a placeable asset for the next viewport click, or disarm the one already waiting. */
const armAsset = (assetId: string): void => {
  const entry = assets?.db.byId[assetId]
  if (entry === undefined) return
  const kind = entry.kind === 'prefab' ? ('prefabAsset' as const) : ('model' as const)
  placing = placing !== null && placing.kind !== 'own' && placing.assetId === assetId ? null : { kind, assetId }
  refreshUi()
}

const renameAsset = (path: string, name: string): void =>
  afterFileOp(`renamed to ${name}`, async () => assets?.move(path, renamedTo(path, name)) ?? Promise.resolve())

const deleteAsset = (path: string): void => afterFileOp(`deleted ${path}`, async () => assets?.remove(path) ?? Promise.resolve())

const project: Project = createProjectPanel($<HTMLDivElement>('#palette'), {
  ownPrefabs: () => doc?.palette() ?? [],
  db: () => assets?.db ?? null,
  folders: () => assets?.folders ?? [],
  urlOf: (path) => assets?.urlOf(path) ?? path,
  armed: () => (placing === null ? null : placing.kind === 'own' ? placing.name : placing.assetId),
  selectedAsset: () => selectedAsset,
  onPickOwn: (name) => {
    // Clicking the armed tile disarms it, so there is a way out of placement without placing.
    placing = placing?.kind === 'own' && placing.name === name ? null : { kind: 'own', name }
    refreshUi()
  },
  onPickAsset: armAsset,
  onSelectAsset: (assetId) => {
    // Selecting an asset and selecting something in the scene are the same slot in the Inspector, so one
    // clears the other rather than both claiming it.
    selectedAsset = assetId
    deselect()
    assetInspector.show(assetId)
    refreshUi()
  },
  requestPreview: (kind, key, done) => previews.request(kind, key, done),
  onCreateMaterial: (folder) => {
    void (async () => {
      if (assets === null) return
      const created = await assets
        .createMaterial(`material-${Date.now()}`, { shader: 'standard', params: {} }, folder)
        .catch((e: unknown) => {
          setStatus(`new material failed: ${String(e)}`)
          return undefined
        })
      await reloadAssets()
      if (created !== undefined) {
        selectedAsset = created.id
        assetInspector.show(created.id)
      }
      refreshUi()
    })()
  },
  /**
   * A file or folder's menu.
   *
   * Rename still asks with a `prompt`, because an inline text field in a tile grid is its own piece of work and
   * a name is genuinely a question. What is gone is the version where **clearing that prompt deleted the
   * file** — deletion is now its own entry, and a folder's says how many things go with it.
   */
  onContext: (at, path, isFolder) => {
    const current = path.slice(path.lastIndexOf('/') + 1)
    const inFolder = isFolder ? (assets?.db.entries.filter((e) => e.path.startsWith(`${path}/`)).length ?? 0) : 0
    const entry = isFolder ? undefined : assets?.db.entries.find((e) => e.path === path)
    const placeable = entry?.kind === 'prefab' || entry?.kind === 'model'
    contextMenu.open(
      at,
      [
        {
          label: placeable ? 'Place in the level' : 'Open in the Inspector',
          enabled: entry !== undefined && (placeable || entry.kind === 'material'),
          why: isFolder ? 'a folder is not an asset' : 'nothing to open for this kind',
          run: () => {
            if (entry === undefined) return
            if (placeable) armAsset(entry.id)
            else {
              selectedAsset = entry.id
              assetInspector.show(entry.id)
              refreshUi()
            }
          },
        },
        {
          label: 'Copy path',
          divider: true,
          // The only way to see what a `.meta` sidecar is about when a reference has gone stale.
          run: () => void navigator.clipboard?.writeText(path).then(() => setStatus(`copied ${path}`)),
        },
        {
          label: 'Rename…',
          run: () => {
            const name = prompt('Rename', current)
            if (name === null || name.trim() === '' || name.trim() === current) return
            renameAsset(path, name.trim())
          },
        },
        {
          label: isFolder ? (inFolder > 0 ? `Delete folder and ${inFolder} asset${inFolder === 1 ? '' : 's'}` : 'Delete empty folder') : 'Delete',
          divider: true,
          run: () => {
            // A confirm only where it is warranted: a folder takes everything under it, and an id that
            // disappears greyboxes silently rather than failing (ADR 0028).
            if (inFolder > 0 && !confirm(`Delete ${current} and the ${inFolder} asset${inFolder === 1 ? '' : 's'} in it?`)) return
            deleteAsset(path)
          },
        },
      ],
      current,
    )
  },
  onMkdir: (parent, name) => afterFileOp(`created ${name}`, async () => assets?.mkdir(parent, name) ?? Promise.resolve()),
  onRename: renameAsset,
  onDelete: deleteAsset,
  onMove: (from, toFolder) => {
    // Refuse a folder into its own subtree here as well as on the server: a rejected drop should not need a
    // round trip to say so.
    if (!from.includes('.') && !canMoveFolder(from, toFolder)) {
      setStatus('a folder cannot move inside itself')
      return
    }
    afterFileOp(`moved into ${toFolder === '' ? 'assets' : toFolder}`, async () => assets?.move(from, movedInto(from, toFolder)) ?? Promise.resolve())
  },
})


// ============================== undo/redo and the clipboard (ADR 0030) ==============================
/**
 * A snapshot of the whole open file, plus where the selection was.
 *
 * The **root** document, always — `docStack[0]` — not whichever prefab is open on top of it. Editing a prefab
 * from a level mutates that level's own table entry, so a root snapshot already covers it, and one history per
 * file is the thing a person expects Ctrl+Z to walk.
 */
interface EditSnapshot {
  data: NodeLevel | SceneNode
  mode: Mode
  /** Sibling paths of the selection (`"0/2"`), primary last — these survive renumbering where indices do not. */
  selectedPaths: string[]
}

const snapshotNow = (): EditSnapshot => {
  const root = docStack[0]
  const rootDoc = root?.doc ?? null
  return {
    data: structuredClone(rootDoc?.toJSON() ?? blankLevel('untitled')),
    mode: rootDoc?.mode ?? 'level',
    // Only meaningful when the selection is in the root document; inside a prefab it names a piece of
    // something else, and restoring drops back to the root anyway.
    selectedPaths: docStack.length === 1 && rootDoc !== null && rootDoc === doc ? selection.map((i) => rootDoc.pathOf(i)) : [],
  }
}

const history = createHistory<EditSnapshot>({ clone: (v) => ({ ...v, data: structuredClone(v.data) }) })

/**
 * What the document looked like before the edit currently being reported.
 *
 * Held as a clone rather than snapshotting at each mutation site, because most mutations reach this file as a
 * *notification* — the Inspector and the Hierarchy call `doc.setName`/`setProps` themselves and then tell us —
 * so by then the old state is already gone. Keeping one clone ahead costs a clone per edit and removes the
 * need for every call site to remember to snapshot first.
 */
let baseline: EditSnapshot | null = null
/** True while a gizmo drag is in flight: one history entry per drag, not one per pointer event. */
let coalescing = false

/**
 * Record that an edit just happened. `baseline` is the state before it.
 *
 * Silently drops an edit that changed nothing, which is not a nicety: a click on a gizmo handle, or picking the
 * material a piece already had, both notify exactly like a real edit. Without this, Ctrl+Z would need pressing
 * two or three times to undo one visible change, which is the way undo stops being trusted. The comparison is
 * a stringify of a document measured in kilobytes, against a rebuild of the whole scene — it is not the
 * expensive part of an edit.
 */
const recordEdit = (label: string): void => {
  if (coalescing || baseline === null) return
  const now = snapshotNow()
  if (JSON.stringify(now.data) === JSON.stringify(baseline.data)) return
  history.push(baseline, label)
  baseline = now
  renderStatus()
}

/** Start a fresh history: a different file's edits are not this one's. */
const resetHistory = (): void => {
  history.clear()
  baseline = snapshotNow()
}

/** The index whose sibling path matches, or `null` — how a selection survives a restore. */
const indexOfPath = (path: string | null): number | null => {
  if (path === null || doc === null) return null
  for (let i = 0; i < doc.count(); i++) if (doc.pathOf(i) === path) return i
  return null
}

const restore = (snapshot: EditSnapshot): void => {
  const data = structuredClone(snapshot.data)
  const next = snapshot.mode === 'level' ? levelDoc(data as NodeLevel, userPrefabs) : prefabDoc(data as SceneNode)
  // Straight into the stack rather than through `setDoc`, which would reset the history we are walking.
  docStack.length = 0
  docStack.push({ doc: next, label: `${next.mode}: ${fileState.name}` })
  showDoc()
  const restored = snapshot.selectedPaths.map(indexOfPath).filter((i): i is number => i !== null)
  if (restored.length > 0) applySelection(restored)
  baseline = snapshotNow()
}

const undo = (): void => {
  const entry = history.undo(snapshotNow())
  if (entry === null) {
    setStatus('nothing to undo')
    return
  }
  restore(entry.data)
  setStatus(`undid: ${entry.label}`)
}

const redo = (): void => {
  const entry = history.redo(snapshotNow())
  if (entry === null) {
    setStatus('nothing to redo')
    return
  }
  restore(entry.data)
  setStatus(`redid: ${entry.label}`)
}

/**
 * The clipboard: one item, in memory.
 *
 * Not the system clipboard. Reading it needs a permission prompt or a paste event, and a scene object is not
 * text anybody would paste elsewhere — so a copy here would be a permission dialog in exchange for nothing.
 * The cost is that copying between two browser tabs of the editor does not work.
 */
let clipboard: ClipItem[] = []

const copySelected = (): void => {
  if (doc === null || selection.length === 0) return
  // Ascending, so pasting a multi-item copy puts things back in the order they were in.
  const open = doc
  const roots = selectionRoots().reverse()
  const items = roots.map((i) => open.copy(i)).filter((item): item is ClipItem => item !== null)
  if (items.length === 0) return
  clipboard = items
  setStatus(items.length > 1 ? `copied ${items.length} items` : `copied ${doc.label(roots[0]!)}`)
  refreshUi()
}

const pasteClipboard = (asChild: boolean): void => {
  if (doc === null || clipboard.length === 0) return
  // A sibling of the selection by default, which is what every editor does; into it on the Shift variant,
  // since nesting is a placement decision and worth its own gesture (ADR 0025).
  const parent = selected === null ? null : asChild ? selected : doc.parentOf(selected)
  const landed: number[] = []
  for (const item of clipboard) {
    const at = doc.paste(item, parent)
    if (at >= 0) landed.push(at)
  }
  if (landed.length === 0) {
    setStatus(doc.mode === 'level' ? 'the clipboard holds prefab pieces, not instances' : 'the clipboard holds instances, not pieces')
    return
  }
  recordEdit(landed.length > 1 ? `paste ${landed.length}` : 'paste')
  buildItems()
  rebuildLoaded()
  applySelection(landed)
  // A pasted item can name a material this document had never referenced.
  loadNewReferences(() => {
    buildItems()
    applySelection(landed)
  })
}

const cutSelected = (): void => {
  if (doc === null || selection.length === 0) return
  copySelected()
  deleteSelected()
}

// --- animation panel (Animation tab, beside Project in the bottom row) ---
/**
 * `setPreviewing` lives here rather than beside the other animation state because it is the one piece that
 * has to touch the panel: starting playback resets the frame clock so the first frame advances by ~0 rather
 * than by however long the tab sat idle.
 */
function setPreviewing(on: boolean): void {
  previewing = on
  previewLastFrame = 0
  timeline.render()
}

/**
 * A preset replaces the keys outright — it is a starting point, not an increment.
 *
 * It leaves `loop` and `phase` alone, because those belong to the component and a preset has no opinion about
 * them. Before, a preset rewrote the whole component and quietly reset both.
 */
const applyPreset = (keys: readonly Keyframe[]): void => {
  if (keyTarget === null) addKeyComponent()
  setSelectedKeys(keys)
  setActiveKey(null)
  setPreviewTime(0)
}

/**
 * Give the selection the first component that declares a keyframe parameter, and open it.
 *
 * Found through the registry rather than naming `Track`, so a second animatable component would be reachable
 * from the same button without touching this.
 */
const addKeyComponent = (): void => {
  if (selected === null || doc === null) return
  const def = doc.registry.all().find((d) => Object.values(d.params).some((spec) => spec.kind === 'keys'))
  if (def === undefined || !doc.canAdd(selected, def.type)) return
  doc.addComponent(selected, def.type)
  keyTarget = doc.keyEditors(selected).find((e) => e.type === def.type) ?? null
  recordEdit('add component')
  inspectorRebuild()
  scheduleRebuild()
}

const timeline: Timeline = createTimeline($<HTMLDivElement>('#timeline'), {
  menu: contextMenu,
  keys: selectedKeys,
  setKeys: setSelectedKeys,
  hasSelection: () => selected !== null,
  // Whose keys, and which component's — the strip used to name only the object, which is what let it read as
  // a panel about the selection rather than an editor for one component on it.
  label: () =>
    selected === null || doc === null ? '' : keyTarget === null ? doc.label(selected) : `${doc.label(selected)} · ${keyTarget.type}.${keyTarget.param}`,
  time: () => previewMs,
  setTime: setPreviewTime,
  previewing: () => previewing,
  setPreviewing,
  activeKey: () => activeKey,
  setActiveKey: (index) => {
    setActiveKey(index)
    timeline.render()
  },
  poseNow: () => (selected === null || doc === null ? null : doc.poseOf(selected, previewMs)),
  // The same grid the transform gizmo snaps to, in time: a 0.25 grid means quarter-second keys, which keeps
  // authored times round without a second setting to forget about.
  snapMs: () => (edit.snap ? edit.step * 1000 : 0),
  addKeyComponent: () => {
    addKeyComponent()
    // One key holding the current pose, so the strip has something to show and the gizmo something to move.
    if (keyTarget !== null && selected !== null && doc !== null) {
      setSelectedKeys(oneKeyAt(doc.poseOf(selected, 0)))
      setActiveKey(0)
    }
    setPreviewTime(0)
  },
  applyMovePreset: (dir, distance, periodMs) => {
    if (selected === null || doc === null) return
    applyPreset(moveTrack(doc.poseOf(selected, 0).position, DIRS[dir] ?? vec3(0, 1, 0), distance, periodMs))
  },
  applySpinPreset: (dir, periodMs) => {
    if (selected === null || doc === null) return
    applyPreset(spinTrack(doc.poseOf(selected, 0).rotation, DIRS[dir] ?? vec3(0, 1, 0), periodMs))
  },
})

/**
 * The bottom row's tabs. Project and Animation both want the full width — a file grid needs columns and a
 * timeline needs a long axis — so they share one panel rather than each getting a narrow one.
 */
const bottomTabs = [...document.querySelectorAll<HTMLButtonElement>('.tabs .tab')]
const showBottomTab = (name: string): void => {
  for (const tab of bottomTabs) {
    const on = tab.dataset.tab === name
    tab.classList.toggle('on', on)
    const body = document.getElementById(tab.dataset.tab ?? '')
    if (body !== null) body.hidden = !on
  }
  // Percentage layout means the strip only needs a re-render when it becomes visible, not on every resize.
  if (name === 'timeline') timeline.render()
}
for (const tab of bottomTabs) tab.addEventListener('click', () => showBottomTab(tab.dataset.tab ?? 'palette'))
showBottomTab('palette')

// --- asset inspector (materials) ---
const assetInspector: AssetInspector = createAssetInspector($<HTMLDivElement>('#asset-inspector'), {
  db: () => assets?.db ?? null,
  urlOf: (path) => assets?.urlOf(path) ?? path,
  materialOf: (id) => assets?.materialOf(id),
  onMaterialChanged: (id, material) => {
    void (async () => {
      if (assets === null) return
      await assets.saveMaterial(id, material).catch((e: unknown) => setStatus(`save failed: ${String(e)}`))
      // Recompile and redraw: a material edit has to show on every piece using it, immediately. Its
      // thumbnail is stale too, and so is any prefab preview that used it.
      previews.invalidate()
      await reloadAssets()
      assetInspector.show(id)
      buildItems()
      refreshUi()
    })()
  },
})

// --- inspector ---
const inspector: Inspector = createInspector($<HTMLDivElement>('#insp-head'), $<HTMLDivElement>('#inspector'), {
  menu: contextMenu,
  doc: () => doc,
  selected: () => selected,
  selectionCount: () => selection.length,
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
    // The gizmo is the authority while it is dragging: see `gizmoDragging`.
    if (selected === null || gizmoDragging) return
    const g = instanceGroups[selected]
    if (g === undefined) return
    // A typed edit is a one-shot drag: `writeBackSelected` offsets an animated item's whole track against the
    // pose it started from, and without a snapshot here there is nothing to offset against — the number would
    // be accepted and change nothing, which is worse than refusing it.
    const keys = selectedKeys()
    // Snapshot before the group moves — the same basis the drag path uses, for the same reason.
    if (keys !== null && keys.length > 0 && activeKey === null)
      dragStart.set(selected, { pose: groupPose(g), scale: vec3(g.scale.x, g.scale.y, g.scale.z), keys })
    g.position.set(t.position.x, t.position.y, t.position.z)
    const q = eulerToQuat(vec3(THREE.MathUtils.degToRad(t.rotationDeg.x), THREE.MathUtils.degToRad(t.rotationDeg.y), THREE.MathUtils.degToRad(t.rotationDeg.z)))
    g.quaternion.set(q.x, q.y, q.z, q.w)
    g.scale.set(t.scale.x, t.scale.y, t.scale.z)
    writeBackSelected()
    recordEdit('transform')
    dragStart.delete(selected)
    applyPreviewPoses() // the track moved, so the item's drawn pose at the playhead moved with it
    scheduleRebuild()
    updateTrackHelper()
  },
  onPropsChanged: () => {
    const item = selected
    recordEdit('properties')
    rebuildSelectedMeshes()
    scheduleRebuild()
    updateTrackHelper()
    hierarchy.render() // a trigger or name change shows in the row's badge/label
    // Draw with what is loaded now, then again once a newly named material has arrived.
    if (item !== null) loadNewReferences(() => rebuildItemMeshes(item))
  },
  // A rename only changes a label: redraw the chrome, leave the property grid and the meshes alone.
  // Called through the hook, since `refreshUi` is declared below this block.
  onRenamed: () => {
    recordEdit('rename')
    uiChanged()
  },
  duplicate: duplicateSelected,
  remove: deleteSelected,
  extract: extractSelected,
  openPrefab: () => {
    if (selected !== null) openPrefabOf(selected)
  },
  revertOverride,
  applyOverrides,
  editKeys: (componentId, param) => {
    if (selected === null || doc === null) return
    keyTarget = doc.keyEditors(selected).find((e) => e.componentId === componentId && e.param === param) ?? null
    setActiveKey(null)
    setPreviewTime(0)
    showBottomTab('timeline')
    timeline.render()
  },
  materials: () => {
    const options: Record<string, string> = { '(none)': '' }
    const db = assets?.db
    if (db !== undefined) for (const m of assetsOfKind(db, 'material')) options[m.name] = m.id
    return options
  },
  models: () => {
    const options: Record<string, string> = { '(none)': '' }
    const db = assets?.db
    if (db !== undefined) for (const m of assetsOfKind(db, 'model')) options[m.name] = m.id
    return options
  },
})

// --- status bar ---
/** Transient: what just happened. Cleared whenever the document changes, since it would then be a lie. */
let statusMsg = ''
/**
 * Persistent: something is broken and stays broken until it is fixed. Kept apart from `statusMsg`
 * because it was not: a failed asset load set a message, and the level load immediately after it wiped
 * it — leaving an empty Project panel and no reason anywhere on screen.
 */
let problemMsg = ''
const setStatus = (msg: string): void => {
  statusMsg = msg
  renderStatus()
}
const setProblem = (msg: string): void => {
  problemMsg = msg
  renderStatus()
}
const renderStatus = (): void => {
  const parts: string[] = [breadcrumb()]
  if (selected !== null && doc !== null) {
    parts.push(selection.length > 1 ? `${selection.length} selected · editing ${doc.label(selected)}` : `selected #${selected} (${doc.label(selected)})`)
  }
  // What the gizmo is about to move is not otherwise visible, and it is the difference between dragging one
  // key and dragging a whole path.
  if (selectedKeys()?.length ?? 0) {
    parts.push(`t=${(previewMs / 1000).toFixed(2)}s${activeKey !== null ? ` · key ${activeKey + 1}` : ' · whole track'}`)
  }
  if (placing !== null) {
    const what = placing.kind === 'own' ? placing.name : (assets?.db.byId[placing.assetId]?.name ?? 'asset')
    parts.push(`click in the viewport to place <b>${what}</b>`)
  }
  // Undo depth in the status bar because nothing else says whether Ctrl+Z will do anything, and the answer
  // changes with every edit. The clipboard likewise: a paste that silently does nothing reads as broken.
  const depth = history.depth()
  if (depth.undo > 0 || depth.redo > 0) parts.push(`undo ${depth.undo}${depth.redo > 0 ? ` · redo ${depth.redo}` : ''}`)
  if (clipboard.length > 0) parts.push(`clipboard: ${clipboard.length} object${clipboard.length > 1 ? 's' : ''}`)
  if (statusMsg !== '') parts.push(statusMsg)
  if (problemMsg !== '') parts.push(`<span class="problem">${problemMsg}</span>`)
  statusBar.innerHTML = parts.filter((p) => p !== '').join(' · ')
}

/** Redraw all the chrome from current state. Cheap: tens of rows, and the toolbar only updates values. */
const refreshUi = (): void => {
  toolbar.render()
  hierarchy.render()
  project.render()
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
    // The strip's own playback: real time, wrapped by the track, and only while the panel asks for it. It is
    // deliberately not the game clock — this previews one authored track, it does not run the level.
    if (previewing) {
      const now = performance.now()
      const dt = previewLastFrame === 0 ? 0 : now - previewLastFrame
      previewLastFrame = now
      const keys = selectedKeys()
      if (keys === null || keys.length === 0) setPreviewing(false)
      else {
        const span = trackDuration(keys)
        const wrapAt = keyLoopMode() === 'pingPong' ? span * 2 : span
        // `once` holds its last pose rather than restarting, same as the loader does with it.
        const next = span <= 0 ? 0 : keyLoopMode() === 'once' ? Math.min(span, previewMs + dt) : (previewMs + dt) % wrapAt
        advancePreviewTime(next)
      }
    }
    controls.update()
  }
})

/**
 * (Re)read the asset database and rebuild the runtime, then fetch everything the open document needs.
 *
 * Loading is a separate pass from drawing on purpose: `buildItems` is synchronous, so a piece is never
 * briefly a grey box that becomes a model a moment later. The cost is that every asset edit reloads the
 * runtime, which at this scale is cheaper than tracking which cache entries a change invalidated.
 */
const reloadAssets = async (): Promise<void> => {
  try {
    assets = await loadAssetLibrary()
    setProblem('')
  } catch (e) {
    // The usual cause is a dev server started before these routes existed, which answers /api/assets with
    // the index page — so say what to do rather than only what failed.
    setProblem(`assets did not load (${String(e)}) — restart pnpm dev:editor`)
    return
  }
  runtime?.dispose()
  const library = assets
  runtime = createAssetRuntime({
    db: library.db,
    urlOf: library.urlOf,
    materialOf: library.materialOf,
  })
  await runtime.load(doc?.assetIds() ?? [])
}

// --- boot ---
await initPhysics()
applySnap()
await reloadAssets()
refreshPrefabLibrary()
await enterMode('level')

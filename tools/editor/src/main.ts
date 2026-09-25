import {
  assetsOfKind,
  instantiateLevel,
  COLLIDER,
  SPAWN,
  RENDERER,
  type PrefabSource,
  hydratePrefabs,
  type ComponentData,
  type LoadedLevel,
  // Aliased: this file is DOM-heavy and `Node` is taken. A scene node is not a DOM node, and the day the two
  // are confused the error is a type error somewhere unrelated.
  type Level,
  validateLevel, type NodeRef, refKey,
  BUILTIN_LABELS, BUILTIN_MODELS,
  isSegment, parseQualified, qualify } from '@mp/content'

import { DEFAULT_REGISTRY, createRegistry, isSharedComponent, SHARED_COMPONENT_TYPES, sharedComponents, type Registry } from '@mp/components'
import { type ModeDescriptor, readSettings } from '@mp/mode'
import { eulerToQuat, vec3, type Vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics, type PhysicsWorld } from '@mp/physics'
import {
  applyGreyboxEnvironment,
  createPostFX,
  createThreeStage,
  OrbitControls,
  createAssetRuntime,
  THREE,
  type AssetRuntime,
} from '@mp/render-three'
import { componentTypesInRaw, levelDoc, type Doc, type Mode } from './editorDoc'
import { createContextMenu, type ContextMenu } from './menu'
import { askName } from './confirm'
import {
  acquireLock,
  heartbeatLocks,
  listFiles,
  loadGame,
  loadLevelRaw,
  lockKey,
  me as fetchMe,
  releaseLock,
  releaseLockBeacon,
  saveFile,
  saveGame,
  serverStatus,
  uploadAsset,
  type FileEntry,
  type GameData,
  type Me,
} from './filesApi'
import { createHierarchy, type Hierarchy } from './hierarchy'
import { createInspector, type Inspector } from './inspector'
import { createAssetInspector, type AssetInspector } from './assetInspector'
import { loadAssetLibrary, type AssetLibrary } from './assetsApi'
import { canMoveFolder, movedInto } from './assetTree'
import { createPreviews, type Previews } from './previews'
import { bootLevel, lastLevel, rememberLevel } from './lastOpen'
import { createProjectPanel, type Project } from './projectPanel'
import { createHistoryStore } from './historyStore'
import { createItemMeshes } from './itemMeshes'
import { createLiveSession, peerCss } from './liveSession'
import { createCameraView } from './cameraView'
import { createFollow } from './follow'
import { createPeople, type PeopleState } from './people'
import { createFileActions } from './fileActions'
import { createMotionPreview } from './motionPreview'
import { createMenus } from './menus'
import { createNodeActions } from './nodeActions'
import { createGizmoTool } from './gizmoTool'
import { createHiddenView, keysUnder } from './hiddenView'
import { createPickTool } from './pickTool'
import { createPointTool } from './pointTool'
import { createSelectionEdges } from './selectionEdges'
import { createPrefabActions } from './prefabActions'
import { createPlay } from './play'
import { applySelect, clampTo, primaryOf, rootsOf, type SelectMode } from './selection'
import { createShortcuts } from './shortcuts'
import { roundAngle } from './snap'
import { createSplitter, readPx, writePx } from './splitter'
import { MODES, MODE_LIST, modeOf, soleMode } from './modes'
import { createNotices, type Notify } from './notices'
import { createToolbar, type Toolbar, type ToolbarState } from './toolbar'

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!
const canvas = $<HTMLCanvasElement>('#view')

/**
 * What the editor says (ADR 0155): toasts over the viewport, the log behind the top bar's bell, and the banner
 * for what stays broken. Made first, because every host below speaks through it; the bell's count is redrawn
 * through `chromeChanged`, which is a no-op until the top bar exists.
 */
let chromeChanged: () => void = () => {}
const notices = createNotices($<HTMLDivElement>('#toasts'), $<HTMLDivElement>('#banner'), () => chromeChanged())
const notify: Notify = notices

// --- scene + polished pipeline (same renderer the game/viewer use) ---
const stage = createThreeStage({ canvas, cameraPosition: [12, 10, 16], lookAt: [0, 1, 0] })
// Same sky and same sun the game runs, so what is authored here is lit the way it ships (ADR 0046).
// Same defaults as the game, on purpose: this pinned `shadowRadius: 40` and `bloomStrength: 0.3` against the
// game's 30 and 0.1, so the editor did not show what you would play. Post-FX now follows the open document.
const env = applyGreyboxEnvironment(stage.renderer, stage.scene, { sunIntensity: 2.4 })
/** My selection's outline colour (ADR 0145): collaborators get strong hues, so white can never be one of theirs. */
const MY_OUTLINE = 0xffffff
const postfx = createPostFX(stage.renderer, stage.scene, stage.camera, {
  // Every selection in the room, mine and theirs, outlined in one pass; none while playing, where the viewport
  // is the game's. A node's group carries its subtree, so a parent's outline takes its children in, as Unity's.
  outlines: () =>
    play.active()
      ? []
      : [{ roots: selection.flatMap((i) => meshes.groupAt(i) ?? []), color: MY_OUTLINE }, ...room.holdOutlines()],
})

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
// The panels are built further down (and after a top-level `await`), so the editing code above them
// reaches the UI through these. Harmless no-ops until then, which is what makes boot order a non-issue.
let uiChanged: () => void = () => {}
let inspectorRebuild: () => void = () => {}
let inspectorSync: () => void = () => {}
/**
 * What undo and redo would do, for the top bar (ADR 0155). The bar draws itself as it is built, which is before
 * the history exists — reading `edits` there was a `ReferenceError` that stopped the editor loading — so it
 * reads nothing to undo until the history store replaces this.
 */
let historyView = (): ToolbarState['history'] => ({ undo: null, redo: null, depth: { undo: 0, redo: 0 } })
/**
 * An Inspector field is being dragged (ADR 0152). A remote edit waits for it as it waits for the gizmo:
 * repainting rebuilds the panel, and would take the field from under the pointer.
 */
let fieldDragging = false

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
 * What the viewport is not drawing (ADR 0132) — Unity's eye column.
 *
 * A view of the level and not a change to it: it never reaches the game, it is not in the level file, and
 * the server keeps it beside its locks and relays it to everyone in the room. Not to be confused with the
 * `active` checkbox (ADR 0099), which switches a node off *in the level* and is content.
 */
const hiddenView = createHiddenView()
/**
 * The Environment row is picked rather than a node (ADR 0048). Its own flag rather than a sentinel index in
 * `selection`, because every structural operation reads that list — delete, duplicate, reparent — and a fake
 * index in it would eventually be handed to one of them.
 */
let envSelected = false
/**
 * The Game row is picked rather than a node (ADR 0052). Its own flag, beside `envSelected`, for the same
 * reason: a sentinel index in `selection` would eventually reach a structural operation that reads that list.
 */
let gameSelected = false
/**
 * What a viewport click will place. `own` is a prefab this level defines in its own table, named; a model or a
 * prefab file is an asset id, and
 * placing one wraps it in a one-piece inline prefab whose collider is authored — visual is not collision,
 * so a detailed prop still collides as a box somebody can resize.
 */
type Placing = { kind: 'model' | 'prefabAsset'; assetId: string }
let placing: Placing | null = null
/**
 * The game being authored for (ADR 0052).
 *
 * Everything the editor cannot answer for itself comes from here: which components exist, what the level's own
 * settings mean, which rules get a gizmo, and what play-in-place does when you touch something. All of that
 * used to be parkour, hardcoded.
 *
 * `undefined` means the open level names no game, or names one this build does not have. The editor stays
 * usable — you can look at geometry, move it and save it — with the game-shaped parts switched off, because a
 * level must not become unopenable through a sibling app being absent.
 */
let activeMode: ModeDescriptor | undefined = soleMode()

/**
 * Each game's shared-component list as it is on disk **right now** (ADR 0077), read over `/api/games` at boot
 * and kept current by `adopt`. The game's own `registry` already folds this file in at build time, but the
 * editor's bundle does not reload when the editor writes it (see `vite.config.ts`), so the live list is merged
 * here rather than trusted from the code.
 */
const gameData: Record<string, GameData> = {}

/** A game's registry: its code, plus whatever the live data file adds that the code did not already have. */
const registryFor = (mode: ModeDescriptor): Registry => {
  const have = new Set(mode.registry.all().map((d) => d.type))
  const extra = (gameData[mode.name]?.components ?? []).filter((type) => !have.has(type) && isSharedComponent(type))
  return extra.length === 0 ? mode.registry : createRegistry([...mode.registry.all(), ...sharedComponents(extra)])
}

/** The component set the open document is validated and edited against. */
const registry = (): Registry => (activeMode === undefined ? DEFAULT_REGISTRY : registryFor(activeMode))

/** Shared components the active game does not have — what a placement or an Add Component may adopt. */
const adoptable = (): string[] => {
  if (activeMode === undefined) return []
  const reg = registryFor(activeMode)
  return SHARED_COMPONENT_TYPES.filter((type) => !reg.has(type))
}

/**
 * Add shared components to the active game (ADR 0077): the data file on disk, the live list here, and the open
 * document rebuilt against the grown registry. The game's dev server sees the file change and reloads.
 */
const adopt = async (types: readonly string[]): Promise<void> => {
  const mode = activeMode
  if (mode === undefined) return
  const have = gameData[mode.name] ?? { components: [], settings: {} }
  const fresh = types.filter((type) => isSharedComponent(type) && !have.components.includes(type))
  if (fresh.length === 0) return
  // The whole file goes back, settings included: writing only the list would drop them (ADR 0087).
  const next: GameData = { ...have, components: [...have.components, ...fresh].sort() }
  await saveGame(mode.name, next)
  gameData[mode.name] = next
  notify.ok(`added ${fresh.join(', ')} to ${mode.label}`)
  if (doc !== null) reopenWithRegistry()
}

/** Loaded assets. Both arrive at boot, before any document is opened. */
let assets: AssetLibrary | null = null

// ============================== locks (ADR 0083) ==============================
/** Who the server says you are. `null` until boot has asked. */
let me: Me | null = null
/** Every lock this tab holds: the open file, and any asset it has written. Released together when the file changes. */
const heldLocks = new Set<string>()
/** Who holds the open file when it is not you. Save is off; the server would refuse it anyway. */
let readOnlyBy: string | null = null
/** Assets you selected that someone else holds, by id → their name. Edits to them are refused. */
const lockedAssets = new Map<string, string>()
/** The last push failure the server reported, or `''`. Kodjo's to fix; shown so nobody thinks their work is on GitHub. */
let pushProblem = ''

/**
 * Take a lock, remembering it. Resolves the holder's name when someone else has it — the caller decides what
 * read-only means for that thing. A lock already held is a no-op (the server refreshes it).
 */
const takeLock = async (path: string): Promise<string | null> => {
  if (heldLocks.has(path)) return null
  try {
    const owner = await acquireLock(path)
    if (owner === null) heldLocks.add(path)
    return owner
  } catch (e) {
    setProblem(`lock failed: ${String(e)}`)
    return null // the server refuses the write if it must; a hiccup here should not block the open
  }
}

/** Release everything this tab holds. Runs when the file changes: the server commits the session then. */
const dropAllLocks = async (): Promise<void> => {
  const paths = [...heldLocks]
  heldLocks.clear()
  lockedAssets.clear()
  readOnlyBy = null
  room.leaveAll()
  follow.reset()
  edits.discardHeld()
  await Promise.all(paths.map((p) => releaseLock(p).catch(() => undefined)))
}

// ============================== live levels (ADR 0089, ADR 0091) ==============================
/** The prefab this tab is editing in its own room, and the level to go back to. `null` in a level. */
let prefabOpen: { assetId: string; name: string; from: string } | null = null

/**
 * The live room is its own module (`liveSession.ts`, ADR 0121): the document stream, the peer list, the
 * holds and their boxes, the presence poses, and the deferred repaint. What is left here is its host.
 */
const room = createLiveSession({
  stage,
  doc: () => doc,
  rootLevel: () => rootLevel(),
  isLevel: () => fileState.mode === 'level',
  reinstallRoot: (level) => {
    const root = docStack[0]
    if (root === undefined || prefabOpen !== null) return false
    try {
      validateLevel(level, registry())
    } catch (e) {
      setProblem(`the server's copy does not load: ${String(e)}`)
      return false
    }
    docStack.length = 1
    docStack[0] = { doc: edits.withOps(levelDoc(level, registry())), label: root.label }
    showDoc()
    return true
  },
  selection: () => selection,
  selectionRefs: () => selectionRefs(),
  applySelection: (indices) => applySelection(indices),
  deselect: () => deselect(),
  groupAt: (i) => meshes.groupAt(i),
  groupPose: (g) => tool.groupPose(g),
  gizmoDragging: () => tool.dragging() || points.dragging() || fieldDragging,
  playing: () => play.active(),
  applyPreviewPoses: () => motion.applyPoses(),
  onHidden: (keys) => {
    hiddenView.set(keys)
    // Nothing about the level changed, so there is no op, no history entry and nothing to send back: only
    // what is drawn, what can be clicked, and the eyes down the Hierarchy.
    meshes.buildAll()
    hierarchy.render()
    uiChanged()
  },
  rebuildViewport: () => {
    meshes.buildAll()
    rebuildLoaded()
  },
  rebuildSubtree: (i) => meshes.rebuildSubtree(i),
  scheduleRebuild: () => scheduleRebuild(),
  installEnvironment: (config) => view.installEnvironment(config),
  loadNewReferencesThen: (redraw) => loadNewReferences(redraw),
  invalidatePreviews: () => previews.invalidate(),
  hierarchyRender: () => hierarchy.render(),
  refreshUi: () => refreshUi(),
  inspectorRebuild: () => inspectorRebuild(),
  inspectorSync: () => inspectorSync(),
  notify,
  setProblem: (message) => setProblem(message),
  presenceChanged: () => {
    // A reconnect is a new connection: whoever this tab follows only knew the old one.
    const conn = room.connId()
    if (conn !== null && conn !== presenceConn) follow.announce()
    presenceConn = conn
    follow.prune(new Set(room.peers().map((p) => p.connId)))
    renderStatus()
  },
  onCamera: (from, pose) => follow.onCamera(from, pose),
  onFollow: (from, leader) => follow.onFollow(from, leader, room.connId()),
  dropHistoryWhere: (predicate) => edits.dropWhere(predicate),
})
/** The connection the room last reported, so a reconnect is noticed. */
let presenceConn: string | null = null

/** Is the open document a live room? Prefabs are too (ADR 0091); a material is a file with a lock. */
const live = (): boolean => room.live()

/** The key the open file is locked by. Levels and prefabs are live rooms; this is for the rest. */
const docLockKey = (): string => lockKey.level(fileState.name)

/**
 * A level's own name, without its game (ADR 0108).
 *
 * `fileState.name` is the qualified `<game>/<name>` — what the route, the lock key and the live document key
 * all use. Two places want the bare half: the name in the top bar, and the game's `?level=`, which a page
 * qualifies with its own game. A prefab's name is already bare and passes straight through.
 */
const shortName = (qualified: string): string => parseQualified(qualified)?.name ?? qualified

/** Lock an editable asset (a material, a clip) before writing it. `true` when it may be written. */
const lockAsset = async (assetId: string): Promise<boolean> => {
  const entry = assets?.db.byId[assetId]
  if (entry === undefined) return false
  const owner = await takeLock(lockKey.asset(entry.path))
  if (owner === null) {
    lockedAssets.delete(assetId)
    return true
  }
  lockedAssets.set(assetId, owner)
  notify.warn(`${entry.name} is read-only: locked by ${owner}`)
  return false
}

/**
 * Prefab definitions, as the `PrefabSource` `hydratePrefabs` takes (ADR 0091). `loadAssetLibrary` already
 * fetched every prefab file at boot, so resolving a level's references costs nothing and needs no await.
 */
const editorPrefabs: PrefabSource = { root: (assetId) => assets?.prefabOf(assetId) }
/** Prefab references the open level could not resolve — named in the Hierarchy and the status line. */
let missingPrefabs: string[] = []
/** What hydration added to the open level's table, so a save writes the references and not the definitions. */
let hydratedPrefabs: string[] = []
let runtime: AssetRuntime | null = null
let selectedAsset: string | null = null
/**
 * The transform gizmo (`gizmoTool.ts`, ADR 0121): the handles, what they snap to, and how a drag reaches
 * the document. It owns `edit`, the pose each item held when the drag began, and the two drag flags.
 */
const tool = createGizmoTool({
  stage,
  canvas,
  controls,
  scene: stage.scene,
  instanceRoot: () => instanceRoot,
  doc: () => doc,
  selection: () => selection,
  selected: () => selected,
  groupAt: (i) => meshes.groupAt(i),
  rebuildSubtree: (i) => meshes.rebuildSubtree(i),
  rebuildLoaded: () => rebuildLoaded(),
  playing: () => play.active(),
  previewMs: () => motion.timeMs(),
  motionOffsetAt: (index, timeMs) => motion.offsetAt(index, timeMs),
  clearFaceHover: () => pick.clearFaceHover(),
  editingPoint: () => points.editing(),
  edits: () => edits,
  room,
  inspectorSync: () => inspectorSync(),
  uiChanged: () => uiChanged(),
  notify,
})
const edit = tool.edit
const STEP_LIMITS = tool.stepLimits
/**
 * A sequence's move points in the viewport (`pointTool.ts`, ADR 0144): the see-through copy of an open move
 * step's target, dragged to set its point, and the selected object's route.
 */
const points = createPointTool({
  camera: stage.camera,
  canvas,
  controls,
  scene: stage.scene,
  doc: () => doc,
  selection: () => selection,
  groupAt: (i) => meshes.groupAt(i),
  holderOf: (g) => meshes.holderOf(g),
  openPoint: () => inspector.openPoint(),
  activeCamera: () => view.activeCamera(),
  playing: () => play.active(),
  motionPlaying: () => motion.playing(),
  space: () => edit.space,
  snapping: () => edit.snap,
  snapStep: () => edit.steps.translate,
  edits: () => edits,
  setDragged: (value) => tool.setDragged(value),
  reattachGizmo: () => tool.reattach(),
  inspectorRebuild: () => inspectorRebuild(),
  afterDrag: () => {
    rebuildLoaded()
    room.drainDeferred()
  },
})
/** My selection's edges, on top of its outline (`selectionEdges.ts`, ADR 0146). */
const edges = createSelectionEdges({
  scene: stage.scene,
  selection: () => selection,
  groupAt: (i) => meshes.groupAt(i),
  playing: () => play.active(),
})

/** Asset id of the prefab open in prefab mode, or `null` for a level or an unsaved prefab. */

const r4 = (n: number): number => Math.round(n * 1e4) / 1e4
const isOne = (v: THREE.Vector3): boolean => Math.abs(v.x - 1) < 1e-4 && Math.abs(v.y - 1) < 1e-4 && Math.abs(v.z - 1) < 1e-4
const isZeroRot = (e: THREE.Euler): boolean => Math.abs(e.x) < 1e-5 && Math.abs(e.y) < 1e-5 && Math.abs(e.z) < 1e-5

/**
 * The viewport's item meshes and marker gizmos (`itemMeshes.ts`, ADR 0121). It owns the groups, the two
 * scene roots, the shadow budget and the surface-cell toggle; what is left here is its host.
 */
const meshes = createItemMeshes({
  doc: () => doc,
  loaded: () => loaded,
  runtime: () => runtime,
  mode: () => activeMode,
  gameSettings: () => gameData[activeMode?.name ?? '']?.settings ?? {},
  selected: () => selected,
  hidden: (i) => doc !== null && hiddenView.hiddenAt(doc, i),
  // Each of these reads the groups that were just replaced, and none of them is that module's business.
  afterBuild: () => {
    motion.applyPoses()
    tool.reattach()
    room.rebuildHolds()
    view.refreshBoundsBox()
    points.refresh()
  },
})
const instanceRoot = meshes.root
const markerGroup = meshes.markers
stage.scene.add(instanceRoot, markerGroup)
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
 * Cheap to call on every edit: `load` skips ids it already holds and shares in-flight fetches. The redraw runs
 * only when something new arrived — every caller has drawn already, so with nothing new it was the whole
 * viewport and physics world built a second time for nothing, which was half of what made an undo take a
 * second. And only while the document is still the one we loaded for: a fetch that lands after the user has
 * opened something else has nothing to draw into, and that document ran its own preload anyway.
 */
const loadNewReferences = (redraw: () => void): void => {
  const r = runtime
  const forDoc = doc
  if (r === null || forDoc === null) return
  void r
    .load(forDoc.assetIds())
    .then((fresh) => {
      if (fresh && doc === forDoc) redraw()
    })
    .catch((e: unknown) => setProblem(`assets did not load (${String(e)}) — restart pnpm dev:editor`))
}

// Re-derive markers/triggers + physics from the current doc (after edits; also a validity check).
const rebuildLoaded = (): void => {
  if (doc === null) return
  world?.free()
  world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
  try {
    loaded = instantiateLevel(world, doc.asLevel(), registry())
    meshes.buildMarkers()
  } catch (e) {
    loaded = null
    meshes.clearMarkers()
    notify.error(`invalid: ${String(e)}`)
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

/** Point the viewport at the top of the stack. Everything is rebuilt from data, so returning from a
 * prefab edit is what makes every instance of it move at once. */
const showDoc = (): void => {
  deselect()
  envSelected = false
  gameSelected = false
  doc = docStack[docStack.length - 1]?.doc ?? null
  // The level owns its sun (ADR 0048), so opening one relights the viewport and rebakes the sky. A prefab has
  // none, which `sun()` reports as `undefined`, and that falls back to the renderer's defaults.
  view.installEnvironment(doc?.environment())
  meshes.buildAll()
  rebuildLoaded()
  uiChanged()
  // The document's own preload, and the only one there is. `reloadAssets` also loads `doc.assetIds()`, but
  // at boot it runs *before* the first document exists, so that call has always been over an empty list —
  // which left every open drawing against an empty runtime, and every material in the viewport greyboxed.
  // Deselected above, so the re-`meshes.buildAll` has no gizmo to re-attach.
  loadNewReferences(meshes.buildAll)
}

/** Open a file — the stack starts over at its root. */
/**
 * Rebuild the open level's document against the active game's registry (ADR 0052).
 *
 * A `Doc` captures its registry at construction — the Inspector's fields, the Add Component menu and
 * `effectiveNode`'s singleton rules all read it — so reassigning a level to another game means a new document
 * over the same level object. Rare and deliberate, which is why recreating it beats making the registry live.
 *
 * Refuses while a prefab is open: a prefab belongs to no game, so there is nothing to reassign.
 */
const reopenWithRegistry = (): void => {
  const root = docStack[0]
  if (root === undefined || prefabOpen !== null) return
  docStack[0] = { doc: edits.withOps(levelDoc(root.doc.asLevel(), registry())), label: root.label }
  showDoc()
}

const setDoc = (next: Doc, name: string): void => {
  docStack.length = 0
  docStack.push({ doc: next, label: `${next.mode}: ${name}` })
  fileState.name = name
  showDoc()
  // Another file's edits are not this one's, and its snapshots would restore the wrong document entirely.
  edits.reset()
}

/**
 * The prefab gestures (`prefabActions.ts`, ADR 0121): open one in its own room, come back out, unlink a
 * placement, save a selection as a new prefab, and the two override directions. Its host is here.
 */
const prefabs = createPrefabActions({
  doc: () => doc,
  docStack: () => docStack,
  selection: () => selection,
  selected: () => selected,
  applySelection: (indices) => applySelection(indices),
  deselect: () => deselect(),
  assets: () => assets,
  registry: () => registry(),
  prefabOpen: () => prefabOpen,
  setPrefabOpen: (value) => {
    prefabOpen = value
  },
  fileName: () => fileState.name,
  setMode: (mode) => {
    fileState.mode = mode
  },
  setDoc: (next, name) => setDoc(next, name),
  showDoc: () => showDoc(),
  openFile: (qualified) => openFile(qualified),
  room,
  edits: () => edits,
  refuseHeld: (index) => refuseHeld(index),
  projectFolder: () => project.folder(),
  reloadAssets: () => reloadAssets(),
  setProblem: (message) => setProblem(message),
  rebuildMeshes: () => meshes.buildAll(),
  rebuildLoaded: () => rebuildLoaded(),
  scheduleRebuild: () => scheduleRebuild(),
  loadNewReferencesThen: (redraw) => loadNewReferences(redraw),
  invalidatePreviews: () => previews.invalidate(),
  inspectorRebuild: () => inspectorRebuild(),
  notify,
  refreshUi: () => refreshUi(),
  uiChanged: () => uiChanged(),
})

/** A component with a stable id — blank documents are authored here, so the ids may as well read plainly. */
const comp = (id: string, type: string, params: Record<string, unknown>): ComponentData => ({ id, type, params })

/**
 * No material on the slab: greybox is what "nobody has surfaced this yet" looks like, and it is truthful for
 * something a new level got for free. Hardcoding a material id here would also be a tool-source reference to
 * a content file somebody is free to delete.
 */
const blankLevel = (id: string): Level => ({
  id,
  // Whichever game is active, so a new level is authored *for* something. Its settings are that game's
  // defaults, filled in by `modeParams` on read rather than written out here (ADR 0052).
  config: activeMode === undefined ? {} : { mode: { name: activeMode.name } },
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

// --- selection + transform gizmo ---
/**
 * How the level is looked at (`cameraView.ts`, ADR 0121): the projection, the navigation gizmo, the
 * background that projection needs, and the network-bounds box. What is left here is its host.
 */
const view = createCameraView({
  stage,
  canvas,
  overlays: $<HTMLDivElement>('#overlays'),
  controls,
  instanceRoot,
  groups: () => meshes.all(),
  doc: () => doc,
  inPrefab: () => prefabOpen !== null,
  playing: () => play.active(),
  useCamera: (camera) => {
    postfx.setCamera(camera)
    controls.object = camera
    tool.control.camera = camera
    points.control.camera = camera
  },
  applyEnvironment: (from) => {
    env.applyEnvironment(from)
    postfx.apply(from?.postfx)
  },
  skyParams: () => env.skyParams,
  renderPostFX: () => postfx.render(),
  notify,
  uiChanged: () => uiChanged(),
  userMoved: () => follow.stop(),
})
stage.scene.add(view.boundsBox)

/**
 * Following a collaborator's view (`follow.ts`, ADR 0155): your camera copies theirs until you move it, and
 * while anyone follows you, yours is sent.
 */
const follow = createFollow({
  pose: () => view.pose(),
  setPose: (pose) => view.setPose(pose),
  send: (data) => room.presence(data),
  playing: () => play.active(),
  changed: () => renderStatus(),
})
/**
 * Your own hand on the camera ends a follow, Kodjo's call: an orbit or pan dragged past a few pixels, or the
 * wheel. A click to select is not one — it presses the controls too, and moves nothing.
 */
let orbitFrom: { x: number; y: number } | null = null
let lastPress = { x: 0, y: 0 }
// Captured, so it is known before the controls' own press handler says `start`.
document.addEventListener('pointerdown', (e) => (lastPress = { x: e.clientX, y: e.clientY }), true)
controls.addEventListener('start', () => (orbitFrom = lastPress))
controls.addEventListener('end', () => (orbitFrom = null))
window.addEventListener('pointermove', (e) => {
  if (orbitFrom === null || follow.leader() === null) return
  if (Math.hypot(e.clientX - orbitFrom.x, e.clientY - orbitFrom.y) > 4) follow.stop()
})
canvas.addEventListener('wheel', () => follow.stop(), { passive: true })

/**
 * The preview clock (`motionPreview.ts`, ADR 0142, ADR 0121). It owns the clock, whether it is running and
 * the frame it last advanced on; `motion.applyPoses()` is what puts every item at its sequences' pose, which
 * is where anything a sequence moves belongs after any rebuild while the clock runs.
 */
const motion = createMotionPreview({
  doc: () => doc,
  groupAt: (i) => meshes.groupAt(i),
  inspectorSync: () => inspectorSync(),
  renderStatus: () => renderStatus(),
  toolbarRender: () => toolbar.render(),
})

/**
 * Point the editor at a selection. Everything derived from it is refreshed here, so no caller has to remember
 * the list: the gizmo goes on the primary and the Inspector follows it.
 */
const applySelection = (next: readonly number[]): void => {
  // Editing is suspended during play, and the item meshes are hidden — attaching a gizmo to one would put a
  // handle in mid-air over a level you are walking. The Hierarchy panel can reach here too, so the guard
  // belongs on the selection itself rather than on the viewport's click handler alone.
  if (play.active()) return
  // The Inspector shows one thing: a scene item or an asset, never both.
  if (selectedAsset !== null && next.length > 0) {
    selectedAsset = null
    assetInspector.show(null)
  }
  // A node someone else holds is theirs: never in the selection, so the gizmo never lands on it (ADR 0089).
  selection = clampTo(next, doc?.count() ?? 0).filter((i) => room.heldBy(i) === null)
  const primary = primaryOf(selection)
  selected = primary
  // Disarmed too: armed Record left running across a selection change would write keys onto the next object
  // you dragged, which is a surprise nobody asked for.

  tool.reattach()

  inspectorRebuild()
  uiChanged()
  // After the panel has been rebuilt, not before: a nested object selected in the viewport is inside a
  // collapsed parent as often as not, and marking a row nobody can see is the same as not marking it.
  if (primary !== null) hierarchy.reveal(primary)
  room.syncHolds()
}

/** Select one item outright — the plain click, and what every command that lands on a new item does. */
const select = (index: number): void => {
  if (meshes.groupAt(index) === undefined || doc === null) return
  if (refuseHeld(index)) return
  applySelection([index])
}

/** A click that carries modifiers: Ctrl toggles one, Shift extends a range over `order`. */
const selectWith = (index: number, mode: SelectMode, order: readonly number[]): void => {
  if (meshes.groupAt(index) === undefined || doc === null) return
  if (refuseHeld(index)) return
  applySelection(applySelect(selection, index, mode, order))
}

/** A click on a node someone else holds: say who, do nothing. */
const refuseHeld = (index: number): boolean => {
  const holder = room.heldBy(index)
  if (holder === null) return false
  notify.warn(`${holder} has that selected`)
  return true
}

const deselect = (): void => {
  selection = []
  selected = null
  tool.control.detach()
  inspectorRebuild()
  uiChanged()
  room.syncHolds()
}

/**
 * The pointer in the viewport (`pickTool.ts`, ADR 0121): what is under it, what it places, and pulling a
 * box by its face. It owns the raycaster, the ground plane, where a press landed, and the pull in progress.
 */
const pick = createPickTool({
  canvas,
  controls,
  scene: stage.scene,
  instanceRoot,
  doc: () => doc,
  assets: () => assets,
  selected: () => selected,
  selection: () => selection,
  select: (index) => select(index),
  selectWith: (index, mode, order) => selectWith(index, mode, order),
  deselect: () => deselect(),
  groupAt: (i) => meshes.groupAt(i),
  holderOf: (g) => meshes.holderOf(g),
  activeCamera: () => view.activeCamera(),
  playing: () => play.active(),
  tool: () => edit.mode,
  snapping: () => edit.snap,
  snapStep: () => edit.steps.translate,
  faceStep: () => edit.steps.face,
  dragged: () => tool.dragged(),
  setDragged: (value) => tool.setDragged(value),
  placing: () => placing,
  disarm: () => {
    placing = null
  },
  edits: () => edits,
  writeBackItem: (index) => tool.writeBackItem(index),
  rebuildMeshes: () => meshes.buildAll(),
  rebuildSubtree: (i) => meshes.rebuildSubtree(i),
  rebuildLoaded: () => rebuildLoaded(),
  loadNewReferencesThen: (redraw) => loadNewReferences(redraw),
  applyPreviewPoses: () => motion.applyPoses(),
  inspectorSync: () => inspectorSync(),
  notify,
  readout: (text, at) => showReadout(text, at),
})

/**
 * What you do to the nodes you have (`nodeActions.ts`, ADR 0121): delete, duplicate, create, frame, paste
 * at a point. Each operates on the roots of the selection, which is the arithmetic that groups them.
 */
const nodes = createNodeActions({
  stage,
  controls,
  doc: () => doc,
  selection: () => selection,
  applySelection: (indices) => applySelection(indices),
  select: (index) => select(index),
  deselect: () => deselect(),
  groupAt: (i) => meshes.groupAt(i),
  view,
  edits: () => edits,
  rebuildMeshes: () => meshes.buildAll(),
  rebuildLoaded: () => rebuildLoaded(),
  scheduleRebuild: () => scheduleRebuild(),
  loadNewReferencesThen: (redraw) => loadNewReferences(redraw),
  inspectorSync: () => inspectorSync(),
  notify,
  refreshUi: () => refreshUi(),
  uiChanged: () => uiChanged(),
  cameraMoved: () => follow.stop(),
})

/** Give an inline one-off a shared identity, so it can be referenced and edited in one place. */
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
  { id: 'undo', chords: ['mod+z'], label: 'Undo', run: () => edits.undo(), enabled: () => !play.active() },
  // Both spellings: Ctrl+Y is the Windows convention and Ctrl+Shift+Z the one every other editor also takes.
  { id: 'redo', chords: ['mod+y', 'mod+shift+z'], label: 'Redo', run: () => edits.redo(), enabled: () => !play.active() },
  { id: 'copy', chords: ['mod+c'], label: 'Copy', run: () => edits.copySelected(), enabled: () => !play.active() && selection.length > 0 },
  { id: 'cut', chords: ['mod+x'], label: 'Cut', run: () => edits.cutSelected(), enabled: () => !play.active() && selection.length > 0 },
  { id: 'paste', chords: ['mod+v'], label: 'Paste', run: () => edits.pasteClipboard(false), enabled: () => !play.active() && edits.clipboardSize() > 0 },
  {
    id: 'paste-child',
    chords: ['mod+shift+v'],
    label: 'Paste as child',
    run: () => edits.pasteClipboard(true),
    enabled: () => !play.active() && edits.clipboardSize() > 0 && selected !== null,
  },
  { id: 'duplicate', chords: ['mod+d'], label: 'Duplicate', run: () => nodes.duplicateSelected(), enabled: () => !play.active() && selection.length > 0 },
  {
    id: 'delete',
    chords: ['delete', 'backspace'],
    label: 'Delete',
    run: () => nodes.deleteSelected(),
    enabled: () => !play.active() && selection.length > 0,
  },
  {
    id: 'select-all',
    chords: ['mod+a'],
    label: 'Select all',
    run: () => applySelection(doc === null ? [] : Array.from({ length: doc.count() }, (_, i) => i)),
    enabled: () => !play.active() && doc !== null && doc.count() > 0,
  },
  // The menu offers Focus with `F` beside it, so the key has to exist or the menu is lying.
  { id: 'focus', chords: ['f'], label: 'Focus the selection', run: () => nodes.focusSelection(), enabled: () => !play.active() && selection.length > 0 },
  { id: 'translate', chords: ['t', 'g'], label: 'Translate tool', run: () => tool.setMode('translate'), enabled: () => !play.active() },
  { id: 'rotate', chords: ['r'], label: 'Rotate tool', run: () => tool.setMode('rotate'), enabled: () => !play.active() },
  { id: 'scale', chords: ['s'], label: 'Scale tool', run: () => tool.setMode('scale'), enabled: () => !play.active() },
  {
    id: 'cancel',
    chords: ['escape'],
    label: 'Cancel / deselect',
    run: () => {
      if (play.active()) {
        play.stop()
        return
      }
      if (placing !== null) {
        placing = null
        notify.ok('placement cancelled')
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



// ============================ play-in-place and in the real game ============================
/**
 * Play is its own module (`play.ts`): it owns the character, the controller, the loop, the play view and
 * lights, the component runtime and the game frame, and asks for the rest through `PlayHost`. What is left
 * here is that host — the getter bag every panel is wired with.
 */
const play = createPlay({
  stage,
  canvas,
  controls,
  instanceRoot,
  doc: () => doc,
  loaded: () => loaded,
  world: () => world,
  mode: () => activeMode,
  registry: () => registry(),
  // Not a level, no game, or the server knows no page for it (ADR 0086).
  gamePageUrl: () =>
    fileState.mode !== 'level' || activeMode === undefined ? null : (me?.games[activeMode.name] ?? null),
  fileName: () => fileState.name,
  levelName: () => shortName(fileState.name),
  live: () => live(),
  flush: () => room.flush(),
  dirty: () => edits.dirty(),
  saveNow: () => edits.saveNow(),
  setPreviewing: (on) => setPreviewing(on),
  rebuildLoaded: () => rebuildLoaded(),
  deselect: () => deselect(),
  hint: (text) => {
    playHint = text
    renderStatus()
  },
  uiChanged: () => uiChanged(),
  drainDeferred: () => room.drainDeferred(),
  setProjection: (ortho) => view.setProjection(ortho),
})

// ============================ panels ============================
// The shell is CSS grid (see index.html); each panel is its own module, and every one of them reads
// the editor's state through a getter rather than being handed a snapshot — so `refreshUi()` is the
// single "something changed, redraw the chrome" call, and no panel can hold a stale copy.

const app = $<HTMLDivElement>('#app')

const fileState: { mode: Mode; name: string } = { mode: 'level', name: 'untitled' }

const openFile = async (name: string): Promise<void> => {
  // The previous file's locks go first — releasing them is what commits that session (ADR 0083).
  await dropAllLocks()
  try {
    {
      /**
       * A level is a live session, not a file with a lock (ADR 0089): join it and the server answers with its
       * copy — newer than the file whenever someone has it open.
       *
       * **Its folder is its game** (ADR 0108), and that decides the registry it is validated against — so
       * opening a level that uses a component its game does not declare is a clear load error rather than a
       * silently broken Inspector (ADR 0052). The name is qualified, so the game is known before the file is
       * even read; it used to be read out of `config.mode.name`, which could disagree with reality.
       */
      const greeting = await room.joinRoom(name)
      const raw: unknown = greeting ?? (await loadLevelRaw(name))
      const ref = parseQualified(name)
      activeMode = (ref === null ? undefined : MODES[ref.game]) ?? soleMode()
      /**
       * A level that uses a shared component its game has not opted into yet — a trampoline dropped into a
       * game with no `Bumper` — adopts it into the game and opens, rather than refusing to open the very file
       * you would need to open to fix it (ADR 0077). Anything else unknown is still a load error.
       */
      if (activeMode !== undefined) {
        const reg = registryFor(activeMode)
        await adopt(componentTypesInRaw(raw).filter((type) => !reg.has(type) && isSharedComponent(type)))
      }
      const level = validateLevel(raw, registry())
      /**
       * A placement names a prefab **asset**, so the definitions are resolved before the document is built
       * (ADR 0091). A level that still carries its own table keeps it — hydration fills only what is not
       * already there, and the save strips only what it filled.
       */
      const resolved = hydratePrefabs(level, editorPrefabs)
      hydratedPrefabs = resolved.filled
      missingPrefabs = resolved.missing
      setDoc(edits.withOps(levelDoc(level, registry())), name)
      // The tree follows the document, so what is open is always visible in it (ADR 0108).
      if (ref !== null) project?.showGame(ref.game)
      // Only now, past every throw above: a level that would not load must not be the one we come back to.
      rememberLevel(name)
      if (missingPrefabs.length > 0) notify.warn(`no prefab file for ${missingPrefabs.join(', ')} — those objects are empty`)
    }
  } catch (e) {
    notify.error(`load failed: ${String(e)}`)
  }
  if (readOnlyBy !== null) notify.warn(`${name} is open read-only: ${readOnlyBy} has it`)
}

/** Every level on disk with the game it declares, so the list can be narrowed to one game (ADR 0052). */
let levelEntries: FileEntry[] = []

/**
 * Every level on disk, for the Project panel's tree (ADR 0108).
 *
 * No filtering here any more: the panel groups them by the game whose folder they are in and draws them all,
 * so narrowing a flat list to one game is exactly the step the tree removed.
 */
const refreshFileList = async (): Promise<void> => {
  levelEntries = await listFiles('levels').catch(() => [] as FileEntry[])
  toolbar?.render()
  project?.render()
}

/**
 * Make a level file and open it live (ADR 0089): a blank one, or a copy of `from` — the server's current copy,
 * newer than the file while it is open. Names are files, so one that exists is refused.
 */
const createLevel = async (from: string | null): Promise<void> => {
  /**
   * A level is made **in a game's folder** (ADR 0108), so there has to be a game: without one there is
   * nowhere for the file to go. Duplicating keeps the original's game; a blank one goes to the active game.
   */
  const game = (from === null ? activeMode?.name : parseQualified(from)?.game) ?? activeMode?.name
  if (game === undefined) {
    notify.warn('pick a game first — a level lives in its game\u2019s folder')
    return
  }
  const short = from === null ? 'untitled' : `${parseQualified(from)?.name ?? from}-copy`
  const title = from === null ? 'New level' : `Duplicate ${from}`
  const name = await askName(title, short, `File name in content/${game}/levels/. Letters, digits, - and _.`)
  if (name === null) return
  if (!isSegment(name)) {
    notify.warn(`"${name}" is not a file name: letters, digits, - and _ only`)
    return
  }
  const qual = qualify({ game, name })
  const existing = await listFiles('levels').catch(() => [] as FileEntry[])
  if (existing.some((e) => e.name === qual)) {
    notify.warn(`${game} already has a level called ${name}`)
    return
  }
  let data: unknown
  if (from === null) {
    const blank = blankLevel(name)
    // The tag inside the file is kept in step with the folder: the folder is authoritative, but a level
    // fetched over HTTP has no folder to read, so the game client still checks the tag (ADR 0108).
    blank.config = { ...blank.config, mode: { name: game } }
    data = blank
  } else {
    const copy = (await loadLevelRaw(from)) as { id?: unknown }
    copy.id = name
    data = copy
  }
  try {
    await saveFile('levels', qual, data)
  } catch (e) {
    notify.error(`could not create ${qual}: ${String(e)}`)
    return
  }
  await refreshFileList()
  await openFile(qual)
}

/**
 * Open something at boot: the level this browser was last on, else the active game's first, else any game's,
 * else a blank document (`bootLevel`, `src/lastOpen.ts`).
 *
 * `soleMode()` is no longer the only way to have a game here — with the picker gone (ADR 0108) there is no
 * active one until a level opens — so the first level of the first game that has one is the fallback, and the
 * tree shows where whatever opened came from.
 */
const openFirstLevel = async (): Promise<void> => {
  await refreshFileList()
  const first = bootLevel(lastLevel(), levelEntries, activeMode?.name)
  if (first !== undefined) await openFile(first)
  else setDoc(edits.withOps(levelDoc(blankLevel('untitled'), registry())), 'untitled')
}

// --- toolbar ---
const toolbar: Toolbar = createToolbar(
  $<HTMLDivElement>('#toolbar'),
  $<HTMLDivElement>('#overlays'),
  () => ({
    name: shortName(fileState.name),
    prefab: prefabOpen === null ? null : { level: shortName(prefabOpen.from), name: prefabOpen.name },
    gizmo: edit.mode,
    space: edit.space,
    snap: edit.snap,
    step: edit.steps[edit.mode],
    stepUnit: STEP_LIMITS[edit.mode].unit,
    stepLimits: STEP_LIMITS[edit.mode],
    playing: play.active(),
    previewing: motion.playing(),
    grid: grid.visible,
    markers: markerGroup.visible,
    surfaceCells: meshes.cells(),
    // `null` while nothing is hidden, so the button stays out of the way until it means something.
    showingAll: hiddenView.any() || hiddenView.showingAll() ? hiddenView.showingAll() : null,
    lockedBy: readOnlyBy,
    history: historyView(),
    unseen: notices.unseen(),
  }),
  {
    back: prefabs.closePrefab,
    undo: () => edits.undo(),
    redo: () => edits.redo(),
    toggleLog: (anchor) => notices.toggleLog(anchor),
    setGizmo: (mode) => tool.setMode(mode),
    setSpace: (space) => tool.setSpace(space),
    setSnap: (on) => {
      edit.snap = on
      tool.applySnap()
      refreshUi()
    },
    setStep: (step) => {
      // The active tool's own increment (ADR 0114); the other two keep theirs.
      edit.steps[edit.mode] = step
      tool.applySnap()
      refreshUi()
    },
    setPlaying: (on) => {
      if (on) play.start()
      else play.stop()
    },
    setPreviewing,
    setGrid: (on) => {
      grid.visible = on
      axes.visible = on
      refreshUi()
    },
    setMarkers: (on) => {
      markerGroup.visible = on
      refreshUi()
    },
    /**
     * The cells live inside each item's mesh holder (ADR 0120), so this is a rebuild rather than a `visible`
     * flag: an invisible mesh is still raycast by three, and the alternative is tracking every one of them.
     */
    setSurfaceCells: (on) => {
      meshes.setCells(on)
      meshes.buildAll()
      refreshUi()
    },
    setShowingAll: (on) => {
      // Nobody else is told: revealing is a way to look at the level, not a change to what is hidden.
      hiddenView.setShowingAll(on)
      meshes.buildAll()
      hierarchy.render()
      refreshUi()
    },
  },
)

/** The labels of what a connection holds in the open document, for its card. */
const heldLabels = (connId: string): string[] => {
  const open = doc
  if (open === null) return []
  return room
    .holdsOf(connId)
    .map((h) => open.indexOfRef(h.ref))
    .filter((i): i is number => i !== null)
    .map((i) => open.label(i))
}

/**
 * Focus on a collaborator (ADR 0155): frame what they hold and open the Hierarchy down to it, the first of it
 * scrolled into view. Framing moves the camera, so a follow ends.
 */
const focusPeer = (connId: string): void => {
  const open = doc
  if (open === null) return
  const indices = room
    .holdsOf(connId)
    .map((h) => open.indexOfRef(h.ref))
    .filter((i): i is number => i !== null)
  if (indices.length === 0) {
    notify.warn('they have nothing selected')
    return
  }
  nodes.frame(indices)
  for (const i of [...indices].reverse()) hierarchy.reveal(i)
}

/** Who is in the room, at the top bar's right end (`people.ts`, ADR 0155). */
const peopleState = (): PeopleState => {
  const mine = room.connId()
  return {
    me: me === null ? null : { name: me.user.name, colour: mine === null ? null : peerCss(mine), connection: room.connection() },
    others: room
      .peers()
      .filter((p) => p.connId !== mine)
      .map((p) => ({ connId: p.connId, name: p.name, colour: peerCss(p.connId) })),
    following: follow.leader(),
    selected: heldLabels,
  }
}
const people = createPeople(toolbar.people, peopleState, {
  focus: focusPeer,
  follow: (connId) => (connId === null ? follow.stop() : follow.start(connId)),
})

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
  envSelected: () => envSelected,
  onSelectEnv: () => {
    // Mutually exclusive with a node selection: the Inspector shows one or the other, and leaving a node
    // marked while editing the sun would say the gizmo still applies to it.
    // Set before deselecting: `deselect` rebuilds the Inspector, and by then it has to know to show the sun.
    envSelected = true
    gameSelected = false
    deselect()
    hierarchy.render()
  },
  gameSelected: () => gameSelected,
  /**
   * What the row reads. Three states worth telling apart: no game, a game that is installed, and a game the
   * level names that this build does not have — the last one being the case a person needs to *see*, because
   * it explains why the rules and the rule gizmos are missing.
   */
  gameLabel: () => {
    const ref = doc?.modeRef()
    if (ref === undefined) return 'No game'
    return MODES[ref.name]?.label ?? `${ref.name} (not installed)`
  },
  onSelectGame: () => {
    gameSelected = true
    envSelected = false
    deselect()
    hierarchy.render()
  },
  onSelect: (index, mode, order) => {
    envSelected = false
    gameSelected = false
    selectWith(index, mode, order)
  },
  heldBy: (index) => room.heldBy(index),
  heldColour: (index) => {
    const h = room.holderAt(index)
    return h === null ? null : peerCss(h.connId)
  },
  isHidden: (index) => doc !== null && hiddenView.hiddenAt(doc, index),
  /**
   * Hiding is sent to the room and comes back as the whole set (ADR 0132) — the echo is the ack, so
   * nothing is applied locally first and two editors cannot end up disagreeing about what is on screen.
   */
  onToggleHidden: (index, onlyThis) => {
    const open = doc
    if (open === null) return
    const keys = keysUnder(open, index, onlyThis)
    const ref = open.refAt(index)
    room.setHidden(keys, ref === null || !hiddenView.keys().has(refKey(ref)))
  },
  onRename: (index, name) => {
    doc?.setName(index, name)
    edits.recordEdit('rename')
    inspectorRebuild() // the inspector's own name field mirrors this one
    uiChanged()
  },
  onReparent: (rows, parent, at) => {
    const open = doc
    if (open === null) return
    if (parent !== null && refuseHeld(parent)) return
    /**
     * **The whole drag, in one edit** (ADR 0134).
     *
     * Roots only: with a parent and its child both selected, moving the child too would take it out of the
     * parent it is travelling inside. `rootsOf` is the same filter copy and duplicate use.
     */
    const moving = rootsOf([...rows], (i) => open.depthOf(i))
      .filter((i) => open.canReparent(i, parent))
      .sort((a, b) => a - b)
    if (moving.length === 0) {
      notify.warn('nothing there can go in that')
      return
    }
    /**
     * Every pose is read **before anything moves**, and from the authored poses (ADR 0126).
     *
     * The world pose is re-expressed in the new parent's frame so nothing jumps, and it is read off the
     * scene graph — which the first move invalidates for everyone after it. The groups otherwise hold
     * authored plus whatever the sequences contribute, and reading those wrote the animation's position into
     * the file for good.
     */
    const parentGroup = parent === null ? null : (meshes.groupAt(parent) ?? null)
    const planned = motion.withAuthoredPoses(() =>
      moving.map((i) => ({ ref: open.refAt(i), local: localInside(meshes.groupAt(i), parentGroup) })),
    )
    // Refs, not indices: each move renumbers the tree depth-first, so every index after the first is stale.
    const parentRef = parent === null ? null : open.refAt(parent)

    const landedRefs: (NodeRef | null)[] = []
    let slot = at
    for (const step of planned) {
      if (step.ref === null) continue
      const here = open.indexOfRef(step.ref)
      const into = parentRef === null ? null : open.indexOfRef(parentRef)
      if (here === null || (parentRef !== null && into === null)) continue
      const local = step.local
      const reframed =
        local === null
          ? undefined
          : {
              position: local.position,
              ...(isZeroRot(new THREE.Euler(local.rotation.x, local.rotation.y, local.rotation.z, 'XYZ'))
                ? {}
                : { rotation: vec3(roundAngle(local.rotation.x), roundAngle(local.rotation.y), roundAngle(local.rotation.z)) }),
              ...(isOne(new THREE.Vector3(local.scale.x, local.scale.y, local.scale.z))
                ? {}
                : { scale: vec3(r4(local.scale.x), r4(local.scale.y), r4(local.scale.z)) }),
            }
      const landed = open.reparent(here, into, slot, reframed)
      landedRefs.push(open.refAt(landed))
      slot++
    }
    // One entry for the drag however many it carried (ADR 0113), so it is one Ctrl+Z and one message.
    edits.recordEdit(moving.length > 1 ? `reparent ${moving.length} objects` : 'reparent')

    // Depth-first indices *are* the identity here (meshes, selection, the gizmo's target) and a reparent
    // renumbers everything after it, so the scene graph and the physics world are rebuilt rather than
    // patched.
    meshes.buildAll()
    rebuildLoaded()
    const again = landedRefs.filter((r): r is NodeRef => r !== null).map((r) => open.indexOfRef(r)).filter((i): i is number => i !== null)
    if (again.length > 0) applySelection(again)
    else {
      deselect()
      uiChanged()
    }
    const skipped = rows.length - moving.length
    if (skipped > 0) notify.warn(`moved ${moving.length}, skipped ${skipped} that cannot go in that`)
  },
})

/**
 * What the right-click menus offer (`menus.ts`, ADR 0121). Declarative: a label, whether it is available,
 * why not when it is not, and one call into the subsystem that owns the work.
 */
const menus = createMenus({
  doc: () => doc,
  selection: () => selection,
  hierarchy: {
    beginRename: (index) => hierarchy.beginRename(index),
    setAllOpen: (open) => hierarchy.setAllOpen(open),
  },
  edits: () => edits,
  nodes,
  prefabs,
  adoptable: () => adoptable(),
  adopt: (types) => adopt(types),
  scheduleRebuild: () => scheduleRebuild(),
  inspectorRebuild: () => inspectorRebuild(),
  uiChanged: () => uiChanged(),
})

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
  if (e.button !== 2 || play.active() || doc === null) return
  if (Math.hypot(e.clientX - rightDownX, e.clientY - rightDownY) > 4) return // was a pan
  const index = pick.indexUnder(e.clientX, e.clientY)
  // Right-clicking an object selects it first, so the menu and the gizmo agree about the subject.
  if (index !== null && !selection.includes(index)) select(index)
  contextMenu.open(
    { x: e.clientX, y: e.clientY },
    menus.viewportMenu(index, pick.surfaceUnder(e.clientX, e.clientY)),
    index === null ? undefined : doc.label(index),
  )
})

$<HTMLDivElement>('#hierarchy').addEventListener('contextmenu', (e) => {
  e.preventDefault()
  if (play.active() || doc === null) return
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-index]')
  const index = row?.dataset.index === undefined ? null : Number(row.dataset.index)
  // Right-clicking a row selects it first: a menu that acts on a *different* object than the one under the
  // pointer is the classic way to delete the wrong thing.
  if (index !== null && !selection.includes(index)) select(index)
  contextMenu.open({ x: e.clientX, y: e.clientY }, index === null ? menus.blankMenu() : menus.menuFor(index), index === null ? undefined : doc.label(index))
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
  prefabFor: (assetId) => assets?.prefabOf(assetId),
  ensureLoaded: async (id) => {
    await runtime?.load([id])
  },
})

// --- project explorer (folder tree + assets + the kit) ---
/**
 * Operations on the project tree's files (`fileActions.ts`, ADR 0121): arming an asset, renaming,
 * deleting, and the two deletes that are more than a file removal. What is left here is its host.
 */
const fileOps = createFileActions({
  doc: () => doc,
  assets: () => assets,
  registry: () => registry(),
  prefabSource: editorPrefabs,
  fileName: () => fileState.name,
  levelEntries: () => levelEntries,
  hasGame: () => activeMode !== undefined,
  inPrefab: () => docStack.length > 1,
  adoptable: () => adoptable(),
  adopt: (types) => adopt(types),
  arm: (kind, assetId) => {
    placing = placing?.assetId === assetId ? null : { kind, assetId }
  },
  recordEdit: (label) => edits.recordEdit(label),
  room: { live: () => live(), flush: () => room.flush(), leave: () => room.leave() },
  openFile: (qualified) => openFile(qualified),
  openFirstLevel: () => openFirstLevel(),
  refreshFileList: () => refreshFileList(),
  reloadAssets: () => reloadAssets(),
  invalidatePreviews: () => previews.invalidate(),
  notify,
  refreshUi: () => refreshUi(),
})

const project: Project = createProjectPanel($<HTMLDivElement>('#palette'), {
  db: () => assets?.db ?? null,
  games: () => MODE_LIST.map((m) => ({ name: m.name, label: m.label })),
  levels: () => levelEntries,
  openLevel: () => fileState.name,
  onOpenLevel: (qualified) =>
    void edits.guardUnsaved().then(async (go) => {
      if (go) await openFile(qualified)
    }),
  /**
   * Author for this game without opening anything: it is what a new level is made in, and what composes the
   * registry while nothing is open. It replaced the toolbar's game picker (ADR 0108) and is deliberately
   * *not* an open: clicking a game in the tree to see its levels must not throw away the document you have.
   */
  onPickGame: (game) => {
    if (activeMode?.name === game) return
    activeMode = MODES[game]
    refreshUi()
  },
  onNewLevel: (game) => {
    activeMode = MODES[game] ?? activeMode
    void createLevel(null)
  },
  folders: () => assets?.folders ?? [],
  urlOf: (path) => assets?.urlOf(path) ?? path,
  armed: () => placing?.assetId ?? null,
  selectedAsset: () => selectedAsset,
  onPickAsset: fileOps.armAsset,
  unplaceableWhy: (id) => fileOps.unplaceableWhy(id),
  onUpload: (files, folder) => {
    const cap = me?.maxUploadBytes ?? Infinity
    const tooBig = files.filter((f) => f.size > cap).map((f) => f.name)
    if (tooBig.length > 0) notify.warn(`too big (cap ${Math.round(cap / 1024 / 1024)} MB): ${tooBig.join(', ')}`)
    const fits = files.filter((f) => f.size <= cap)
    if (fits.length === 0) return
    fileOps.afterFileOp(`uploaded ${fits.map((f) => f.name).join(', ')}`, async () => {
      for (const f of fits) await uploadAsset(folder === '' ? f.name : `${folder}/${f.name}`, f)
    })
  },
  onSelectAsset: (assetId) => {
    // Selecting an asset and selecting something in the scene are the same slot in the Inspector, so one
    // clears the other rather than both claiming it.
    selectedAsset = assetId
    deselect()
    assetInspector.show(assetId)
    refreshUi()
    // A material is edited the moment it is selected, so it is locked then — "lock on open" (ADR 0083).
    const kind = assets?.db.byId[assetId]?.kind
    if (kind === 'material') void lockAsset(assetId).then(() => renderStatus())
  },
  requestPreview: (kind, key, done) => previews.request(kind, key, done),
  onCreateAsset: (kind, folder) => {
    void (async () => {
      if (assets === null) return
      const name = `${kind}-${Date.now()}`
      // An empty clip is a legitimate starting point: no keys means no motion, so a fresh one holds the
      // transform of anything that plays it (ADR 0050).
      const make =
        assets.createMaterial(name, { shader: 'standard', params: {} }, folder)
      const created = await make.catch((e: unknown) => {
        notify.error(`new ${kind} failed: ${String(e)}`)
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
    const foreign = entry === undefined ? null : fileOps.unplaceableWhy(entry.id)
    const prefabHere = entry?.kind === 'prefab' ? entry.id : null
    contextMenu.open(
      at,
      [
        {
          label: placeable ? 'Place in the level' : 'Open in the Inspector',
          enabled: entry !== undefined && foreign === null && (placeable || entry.kind === 'material'),
          why: isFolder ? 'a folder is not an asset' : foreign ?? 'nothing to open for this kind',
          run: () => {
            if (entry === undefined) return
            if (placeable) fileOps.armAsset(entry.id)
            else {
              selectedAsset = entry.id
              assetInspector.show(entry.id)
              refreshUi()
            }
          },
        },
        {
          // A prefab placed in no level is reachable only from here, now that the toolbar has no prefab mode.
          label: 'Open prefab',
          enabled: prefabHere !== null && prefabOpen === null,
          why: prefabHere === null ? 'not a prefab' : 'leave the prefab you are in first',
          run: () => void (prefabHere !== null && prefabs.enterPrefab(prefabHere)),
        },
        {
          label: 'Copy path',
          divider: true,
          // The only way to see what a `.meta` sidecar is about when a reference has gone stale.
          run: () => void navigator.clipboard?.writeText(path).then(() => notify.ok(`copied ${path}`)),
        },
        {
          label: 'Rename…',
          run: () => {
            const name = prompt('Rename', current)
            if (name === null || name.trim() === '' || name.trim() === current) return
            fileOps.renameAsset(path, name.trim())
          },
        },
        {
          label: isFolder ? (inFolder > 0 ? `Delete folder and ${inFolder} asset${inFolder === 1 ? '' : 's'}` : 'Delete empty folder') : 'Delete',
          divider: true,
          run: () => {
            // A confirm only where it is warranted: a folder takes everything under it, and an id that
            // disappears greyboxes silently rather than failing (ADR 0028).
            if (inFolder > 0 && !confirm(`Delete ${current} and the ${inFolder} asset${inFolder === 1 ? '' : 's'} in it?`)) return
            fileOps.deleteAsset(path)
          },
        },
      ],
      current,
    )
  },
  onLevelContext: (at, qualified) => {
    const ref = parseQualified(qualified)
    const short = ref?.name ?? qualified
    const isOpen = fileState.name === qualified
    contextMenu.open(
      at,
      [
        {
          label: 'Open',
          enabled: !isOpen && prefabOpen === null,
          why: isOpen ? 'already open' : 'leave the prefab you are in first',
          run: () => void edits.guardUnsaved().then(async (go) => {
            if (go) await openFile(qualified)
          }),
        },
        {
          label: 'Duplicate\u2026',
          divider: true,
          // Takes the copy from the server's current copy rather than the file, so a level open live is
          // duplicated as it is now.
          run: () => void createLevel(qualified),
        },
        { label: 'Rename\u2026', run: () => fileOps.renameLevel(qualified) },
        {
          label: 'Copy name',
          // What `?level=` takes, and what a teammate needs in order to open the same one.
          run: () => void navigator.clipboard?.writeText(short).then(() => notify.ok(`copied ${short}`)),
        },
        { label: 'Delete\u2026', divider: true, run: () => fileOps.deleteLevelFile(qualified) },
      ],
      short,
    )
  },
  onMkdir: (parent, name) => fileOps.afterFileOp(`created ${name}`, async () => assets?.mkdir(parent, name) ?? Promise.resolve()),
  onRename: fileOps.renameAsset,
  onDelete: fileOps.deleteAsset,
  onMove: (from, toFolder) => {
    // Refuse a folder into its own subtree here as well as on the server: a rejected drop should not need a
    // round trip to say so.
    if (!from.includes('.') && !canMoveFolder(from, toFolder)) {
      notify.warn('a folder cannot move inside itself')
      return
    }
    fileOps.afterFileOp(`moved into ${toFolder === '' ? 'assets' : toFolder}`, async () => assets?.move(from, movedInto(from, toFolder)) ?? Promise.resolve())
  },
})


// ============================== undo/redo by inverse ops (ADR 0089) ==============================
/**
 * The document reports every edit as ops with their inverses (`Doc.onOps`); `recordEdit` folds what arrived
 * since the last call into one history entry. Undo applies the entry's inverses to the level — an ordinary
 * edit as far as everything else is concerned — and never touches what anyone else did. Snapshots of the whole
 * document (ADR 0030) went with the per-file lock: a snapshot cannot belong to one person.
 */
/** The selection, by identity that survives renumbering — what an undo puts back. */
const selectionRefs = (): NodeRef[] => {
  const open = doc
  if (open === null) return []
  return selection.map((i) => open.refAt(i)).filter((r): r is NodeRef => r !== null)
}

/** The level every op applies to: the open file's. A prefab opened on top is one of its table entries. */
const rootLevel = (): Level | null => docStack[0]?.doc.asLevel() ?? null

/**
 * Undo, redo, the clipboard and edits.dirty() tracking (`historyStore.ts`, ADR 0121). It owns the history, the
 * pending batches, the coalescing flag, the held-back drag batches, `edits.dirty()` and the clipboard.
 */
const edits = createHistoryStore({
  doc: () => doc,
  rootDoc: () => docStack[0]?.doc,
  rootLevel: () => rootLevel(),
  selection: () => selection,
  selected: () => selected,
  selectionRefs: () => selectionRefs(),
  selectionRoots: () => nodes.selectionRoots(),
  applySelection: (indices) => applySelection(indices),
  deleteSelected: () => nodes.deleteSelected(),
  live: () => live(),
  submit: (batch) => room.submit(batch),
  fileName: () => fileState.name,
  readOnlyBy: () => readOnlyBy,
  // The name may have changed since the file was opened (Save-as), or this may be a new file: the lock
  // follows what is about to be written.
  claimFileLock: async () => {
    const key = docLockKey()
    return heldLocks.has(key) ? null : takeLock(key)
  },
  // What the open pass resolved, plus whatever the document has resolved since — placing a prefab, pasting
  // one, Save as prefab. A definition that reaches disk is a frozen copy the level reads instead of the
  // asset, for good (ADR 0124).
  hydratedPrefabs: () => [...new Set([...hydratedPrefabs, ...(doc?.resolvedPrefabs() ?? [])])],
  afterSave: async () => {
    previews.invalidate()
    await reloadAssets()
    await refreshFileList()
  },
  rebuildViewport: () => {
    meshes.buildAll()
    rebuildLoaded()
  },
  repaint: (ops) => room.repaint(ops),
  loadNewReferencesThen: (redraw) => loadNewReferences(redraw),
  notify,
  renderStatus: () => renderStatus(),
  refreshUi: () => refreshUi(),
})
historyView = () => ({ ...edits.labels(), depth: edits.depth() })

// --- motion.playing() motion in the viewport (ADR 0103) ---
/**
 * Run or stop the preview clock.
 *
 * Starting resets the frame clock so the first frame advances by ~0 rather than by however long the viewport
 * sat idle, and stopping snaps everything back to its authored transform — a preview that left objects
 * wherever the clock stopped would look exactly like content someone had moved.
 */
function setPreviewing(on: boolean): void {
  motion.setPlaying(on)
}

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
      const owner = lockedAssets.get(id)
      if (owner !== undefined) {
        notify.warn(`not saved: ${assets.db.byId[id]?.name ?? 'material'} is locked by ${owner}`)
        assetInspector.show(id)
        return
      }
      await assets.saveMaterial(id, material).catch((e: unknown) => notify.error(`save failed: ${String(e)}`))
      // Recompile and redraw: a material edit has to show on every piece using it, immediately. Its
      // thumbnail is stale too, and so is any prefab preview that used it.
      previews.invalidate()
      await reloadAssets()
      assetInspector.show(id)
      meshes.buildAll()
      refreshUi()
    })()
  },
})

// --- inspector ---
const inspector: Inspector = createInspector($<HTMLDivElement>('#insp-head'), $<HTMLDivElement>('#inspector'), {
  menu: contextMenu,
  pointsChanged: () => points.refresh(),
  doc: () => doc,
  adoptable,
  adopt: (type) => adopt([type]),
  selected: () => selected,
  envSelected: () => envSelected,
  gameSelected: () => gameSelected,
  games: () => MODE_LIST.map((m) => ({ name: m.name, label: m.label })),
  /**
   * The game's settings (ADR 0087): what it declares, over what its data file holds. Written whole, with the
   * component list, on every change — the file is small and the alternative is two writers to one file.
   */
  settings: () => {
    const mode = activeMode
    if (mode === undefined || mode.settings === undefined) return null
    return { decls: mode.settings, values: readSettings(mode.settings, gameData[mode.name]?.settings) }
  },
  onSettingChanged: (key, value) => {
    const mode = activeMode
    if (mode === undefined) return
    const have = gameData[mode.name] ?? { components: [], settings: {} }
    const next: GameData = { ...have, settings: { ...have.settings, [key]: value } }
    gameData[mode.name] = next
    // A setting the game lays its surface cells out from — the key pitch (ADR 0120) — so the preview follows
    // the field instead of the last reload. Cheap: only nodes the game claims build any.
    if (mode.surfaceGrid !== undefined) meshes.buildAll()
    void saveGame(mode.name, next).then(
      () => notify.ok(`${mode.label}: ${key} = ${Array.isArray(value) ? `${value.length} points` : value}`),
      (e: unknown) => notify.error(`settings save failed: ${String(e)}`),
    )
  },
  onModeChanged: () => {
    // The registry changed with the game, so everything derived from it is stale: the document's own registry,
    // the Add Component menu, the rule gizmos and the physics instance.
    activeMode = doc === null ? activeMode : (modeOf(doc.asLevel()) ?? soleMode())
    reopenWithRegistry()
    void refreshFileList()
  },
  boundsBoxShown: () => view.showBounds(),
  showBoundsBox: (on) => view.setShowBounds(on),
  onNetBoundsChanged: () => {
    view.refreshBoundsBox()
    edits.recordEdit('network bounds')
    uiChanged()
  },
  boundsReach: () => view.boundsReach(),
  /**
   * The header's active checkbox (ADR 0099, moved to the Inspector by ADR 0102). A structural change: what
   * the level contains just changed, so the physics world, the markers and the drawn items are all rebuilt,
   * exactly as a delete would.
   */
  onSetEnabled: (on) => {
    if (doc === null || selected === null) return
    doc.setNodeEnabled(selected, on)
    edits.recordEdit(on ? 'enabled' : 'disabled')
    rebuildLoaded()
    meshes.buildAll()
    hierarchy.render()
    inspectorRebuild()
  },
  onEnvironmentChanged: () => {
    // Elevation and azimuth move the sky as well as the light, so this rebakes rather than just relighting.
    view.installEnvironment(doc?.environment())
    edits.recordEdit('environment')
    uiChanged()
  },
  selectionCount: () => selection.length,
  selectionIndices: () => selection,
  readTransform: () => {
    if (selected === null) return null
    const g = meshes.groupAt(selected)
    if (g === undefined) return null
    const e = new THREE.Euler().setFromQuaternion(g.quaternion, 'XYZ')
    return {
      position: vec3(g.position.x, g.position.y, g.position.z),
      rotationDeg: vec3(THREE.MathUtils.radToDeg(e.x), THREE.MathUtils.radToDeg(e.y), THREE.MathUtils.radToDeg(e.z)),
      scale: vec3(g.scale.x, g.scale.y, g.scale.z),
    }
  },
  /**
   * Every selected node's transform, in selection order so the primary is last (ADR 0112).
   *
   * Read off the scene groups, like `readTransform`, so the numbers the panel compares for "do these agree"
   * are the same numbers it would have shown for one node.
   */
  selectionTransforms: () =>
    selection.flatMap((i) => {
      const g = meshes.groupAt(i)
      if (g === undefined) return []
      const e = new THREE.Euler().setFromQuaternion(g.quaternion, 'XYZ')
      return [
        {
          position: vec3(g.position.x, g.position.y, g.position.z),
          rotationDeg: vec3(THREE.MathUtils.radToDeg(e.x), THREE.MathUtils.radToDeg(e.y), THREE.MathUtils.radToDeg(e.z)),
          scale: vec3(g.scale.x, g.scale.y, g.scale.z),
        },
      ]
    }),
  /**
   * One axis of one field, on every selected node, as one undo entry (ADR 0112).
   *
   * Only the axis asked for: the others keep each node's own value, which is what makes blanking a mixed
   * axis honest — an empty box leaves that axis alone rather than flattening it to the primary's number.
   *
   * `coalescing` holds the per-node ops back so `recordEdit` folds them into a single history entry and one
   * message to the room, the same way a gizmo drag across a selection does.
   */
  writeAxis: (field, axis, value) => {
    if (doc === null || tool.dragging() || selection.length === 0) return
    edits.beginDrag()
    try {
      for (const i of selection) {
        const g = meshes.groupAt(i)
        if (g === undefined) continue
        if (field === 'position') g.position[axis] = value
        else if (field === 'scale') g.scale[axis] = value
        else {
          const e = new THREE.Euler().setFromQuaternion(g.quaternion, 'XYZ')
          e[axis] = THREE.MathUtils.degToRad(value)
          g.quaternion.setFromEuler(e)
        }
        tool.writeBackItem(i)
        if (field === 'scale') meshes.rebuildSubtree(i)
      }
    } finally {
      // Cleared here too, so a throw inside the loop cannot leave recording switched off.
      edits.abortDrag()
    }
    edits.endDrag(selection.length > 1 ? `${field} ${selection.length}` : field)
    rebuildLoaded()
    motion.applyPoses()
    inspector.sync()
  },
  writeTransform: (t) => {
    // The gizmo is the authority while it is dragging: see `tool.dragging()`.
    if (selected === null || tool.dragging()) return
    const g = meshes.groupAt(selected)
    if (g === undefined) return
    // No snapshot needed: an offset track's write-back is a subtraction, not a delta against the pose the
    // drag started from (ADR 0050), so a typed value lands the same way a dragged one does.
    g.position.set(t.position.x, t.position.y, t.position.z)
    const q = eulerToQuat(vec3(THREE.MathUtils.degToRad(t.rotationDeg.x), THREE.MathUtils.degToRad(t.rotationDeg.y), THREE.MathUtils.degToRad(t.rotationDeg.z)))
    g.quaternion.set(q.x, q.y, q.z, q.w)
    g.scale.set(t.scale.x, t.scale.y, t.scale.z)
    tool.writeBackSelected()
    meshes.rebuildSubtree(selected) // the scale may have changed, and the meshes are built from it
    edits.recordEdit('transform')
    motion.applyPoses() // the rest pose moved, so the item's drawn pose at the playhead moved with it
    scheduleRebuild()
  },
  /** One history entry and one message to the room per drag, as the gizmo's (`edits.beginDrag`). */
  beginDrag: () => {
    fieldDragging = true
    edits.beginDrag()
  },
  endDrag: (label) => {
    fieldDragging = false
    edits.endDrag(label)
    rebuildLoaded()
    room.drainDeferred()
  },
  onPropsChanged: () => {
    const item = selected
    edits.recordEdit('properties')
    meshes.rebuildSelected()
    scheduleRebuild()
    hierarchy.render() // a trigger or name change shows in the row's badge/label
    // Draw with what is loaded now, then again once a newly named material has arrived.
    if (item !== null) loadNewReferences(() => meshes.rebuildItem(item))
  },
  // A rename only changes a label: redraw the chrome, leave the property grid and the meshes alone.
  // Called through the hook, since `refreshUi` is declared below this block.
  onRenamed: () => {
    edits.recordEdit('rename')
    uiChanged()
  },
  prefabName: (id) => assets?.db.byId[id]?.name ?? null,
  unlinkPrefab: () => void (selected !== null && prefabs.unlinkPlacement(selected)),
  openPrefab: () => {
    if (selected !== null) prefabs.openPrefabOf(selected)
  },
  revertOverride: (field) => prefabs.revertOverride(field),
  applyOverrides: () => void prefabs.applyOverrides(),
  revertPlacement: (index) => prefabs.revertPlacement(index),
  applyPlacementOverrides: (index) => prefabs.applyPlacementOverrides(index),
  assetOptions: (of) => {
    const options: Record<string, string> = { '(none)': '' }
    // The built-in shapes (ADR 0090) sit in the model slot beside the uploaded files.
    if (of === 'model') for (const id of BUILTIN_MODELS) options[BUILTIN_LABELS[id]] = id
    const db = assets?.db
    if (db !== undefined) for (const a of assetsOfKind(db, of)) options[a.name] = a.id
    return options
  },
})

// --- what the editor shows of its own state (ADR 0155) ---
/**
 * Persistent: something is broken and stays broken until it is fixed — a line of the banner over the viewport.
 * Kept apart from the notices because it once was not: a failed asset load said so, and the level load right
 * after it wiped the message, leaving an empty Project panel and no reason anywhere on screen.
 */
const setProblem = (msg: string): void => notices.setProblem('main', msg)

/** A play session's hint while it runs (`play.ts`); it wins over placing's. */
let playHint: string | null = null
const hintPill = $<HTMLDivElement>('#vhint')
const hierarchyCount = $<HTMLSpanElement>('#hier-count')
const stageEl = $<HTMLDivElement>('#stage')

/** The figure by the pointer during a gesture — the size while pulling a face — or none. */
const readoutTag = $<HTMLDivElement>('#readout')
const showReadout = (text: string | null, at?: { x: number; y: number }): void => {
  readoutTag.hidden = text === null
  if (text === null) return
  readoutTag.textContent = text
  if (at === undefined) return
  const frame = readoutTag.parentElement!.getBoundingClientRect()
  readoutTag.style.left = `${Math.round(at.x - frame.left + 16)}px`
  readoutTag.style.top = `${Math.round(at.y - frame.top + 16)}px`
}

/**
 * Redraw what shows the editor's state, now that the status bar is gone: the top bar (undo and redo, the lock,
 * the bell), the hint over the viewport — playing, or placing — and the Hierarchy's count. Cheap: the top bar
 * only updates values.
 */
const renderStatus = (): void => {
  toolbar.render()
  people.render()
  // Following someone: a frame round the viewport in their colour, and the pill says whose view it is.
  const leader = follow.leader()
  const leaderName = leader === null ? null : (room.peers().find((p) => p.connId === leader)?.name ?? null)
  stageEl.classList.toggle('following', leader !== null)
  if (leader !== null) stageEl.style.setProperty('--follow', peerCss(leader))
  const followHint = leaderName === null ? null : `Following ${leaderName} · move the camera to stop`
  const placingWhat = placing === null ? null : (assets?.db.byId[placing.assetId]?.name ?? 'asset')
  const hint = playHint ?? followHint ?? (placingWhat === null ? null : `Click in the viewport to place ${placingWhat} · Esc to cancel`)
  hintPill.hidden = hint === null
  hintPill.textContent = hint ?? ''
  hierarchyCount.textContent = doc === null ? '' : String(doc.count())
}
chromeChanged = renderStatus

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
    // `stage.resize` only knows the perspective camera; this one is the editor's.
    if (view.isometric()) view.syncOrthoFrustum(view.orthoHalfHeight())
    const size = stage.renderer.getSize(new THREE.Vector2())
    postfx.setSize(size.x, size.y)
  })
}

/**
 * The canvas also changes size when the banner above the viewport comes and goes (ADR 0155), which no splitter
 * reports: the stage resizes itself, and the post-FX targets and the orthographic frustum follow through this.
 */
new ResizeObserver(() => relayout()).observe(canvas)

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
stage.start((dt) => {
  // A session takes the frame, or it does not and the edit clock does — the same either/or as before.
  if (!play.frame(dt)) {
    /**
     * The preview clock: real time, and only while asked for (ADR 0142).
     *
     * Deliberately not the game clock — it poses the level's sequences and nothing else, with no physics, no
     * character and no rules. It runs freely rather than wrapping: every sequence has its own cycle, so there
     * is no single length to wrap to, and level time in the game does not wrap either.
     */
    motion.frame()
    toolbar.setClock(motion.playing() ? motion.timeMs() / 1000 : null)
    view.update(dt)
    follow.frame(dt)
    controls.update()
  } else follow.frame(dt) // a session's frame: the follow ends, since play owns the camera
  points.frame()
  edges.frame()
})

/**
 * (Re)read the asset database and rebuild the runtime, then fetch everything the open document needs.
 *
 * Loading is a separate pass from drawing on purpose: `meshes.buildAll` is synchronous, so a piece is never
 * briefly a grey box that becomes a model a moment later. The cost is that every asset edit reloads the
 * runtime, which at this scale is cheaper than tracking which cache entries a change invalidated.
 */
const reloadAssets = async (): Promise<void> => {
  try {
    assets = await loadAssetLibrary()
    // Each game's shared-component list, live from disk (ADR 0077). Missing file = no extras.
    for (const mode of MODE_LIST) gameData[mode.name] = await loadGame(mode.name)
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
tool.applySnap()
// Who you are, and the lock rules. A dev server answers `local`; the hosted one, whoever Access let in.
me = await fetchMe().catch((e: unknown) => {
  setProblem(`who am I? ${String(e)} — restart pnpm dev:editor`)
  return null
})
await reloadAssets()
await openFirstLevel()

/**
 * Keep every held lock alive, and re-take the file's if the server dropped it (a laptop asleep past the stale
 * window). Also the moment a push failure is learned about.
 */
window.setInterval(() => {
  void (async () => {
    if (heldLocks.size > 0) {
      const lost = await heartbeatLocks([...heldLocks]).catch(() => [] as string[])
      for (const p of lost) heldLocks.delete(p)
      const key = docLockKey()
      if (lost.includes(key) && readOnlyBy === null) {
        readOnlyBy = await takeLock(key)
        if (readOnlyBy !== null) notify.warn(`${fileState.name} is now read-only: ${readOnlyBy} took it while this tab was away`)
        refreshUi()
      }
    }
    if (live()) room.ping() // the server drops a connection it has not heard from, holds included
    const status = await serverStatus().catch(() => null)
    const next = status?.pushError ?? ''
    if (next !== pushProblem) {
      pushProblem = next
      notices.setProblem('push', next === '' ? '' : `not on GitHub yet: ${next}`)
    }
  })()
}, me?.heartbeatMs ?? 30_000)

// A closing tab lets go of its locks at once rather than waiting out the stale window.
window.addEventListener('pagehide', () => {
  for (const p of heldLocks) releaseLockBeacon(p)
  room.beaconLeave()
})

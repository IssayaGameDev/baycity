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
  isSegment, parseQualified, qualify,
  applyAssetOps, diffAssetOps, gameDocId, gameOfDocId, isDataAsset, isLiveAssetPath, libraryOf, LiveAssetError, mayUse, textFontRefusal,
  type AssetDatabase, type AssetKind, type AssetOp, type DataAsset, type MaterialAsset, type Transform } from '@mp/content'

import { DEFAULT_REGISTRY, createRegistry, dataMenuPath, ENGINE_COMPONENTS, isSharedComponent, newDataAsset, PLAYER_COMPONENTS, SHARED_COMPONENT_TYPES, sharedComponents, type DataTypeDef, type Registry } from '@mp/components'
import { type CurvePoint, type ModeDescriptor, readSettings } from '@mp/mode'
import { eulerToQuat, vec3, type Vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics, type PhysicsWorld } from '@mp/physics'
import {
  applyGreyboxEnvironment,
  createPostFX,
  createThreeStage,
  OrbitControls,
  createAssetRuntime,
  shaderDef,
  THREE,
  type AssetRuntime,
} from '@mp/render-three'
import { componentTypesInRaw, levelDoc, type Doc, type Mode } from './editorDoc'
import { createContextMenu, type ContextMenu } from './menu'
import { askName } from './confirm'
import {
  listFiles,
  loadGame,
  loadLevelRaw,
  parseGameData,
  me as fetchMe,
  saveFile,
  serverStatus,
  uploadAsset,
  type FileEntry,
  type GameData,
  type Me,
} from './filesApi'
import { createHierarchy, type Hierarchy } from './hierarchy'
import { createInspector, type Inspector } from './inspector'
import { createAssetInspector, type AssetInspector } from './assetInspector'
import { fetchUsers, loadAssetLibrary, type AssetLibrary } from './assetsApi'
import { libraryChanges, watchAssets } from './assetWatch'
import { createAssetSync, parseAssetEvent, type Origin } from './assetSync'
import { canMoveFolder, movedInto } from './assetTree'
import { createPreviews, prefabObject, type Previews } from './previews'
import { createDragPlace } from './dragPlace'
import { bootLevel, lastLevel, rememberLevel } from './lastOpen'
import { createProjectPanel, type Project } from './projectPanel'
import { createHistoryStore, type Turn } from './historyStore'
import { createEditorActions, EDITOR_ACTIONS, installEditorActions, type Screenshot } from './actions'
import { createItemMeshes } from './itemMeshes'
import { createLiveSession, peerCss } from './liveSession'
import type { FieldSpot } from './collab'
import { createCameraView } from './cameraView'
import { createAssistantDock } from './assistant/assistantDock'
import type { EditorContext } from './assistant/assistantApi'
import { createFollow } from './follow'
import { createPeople, type PeopleState } from './people'
import { createFieldPresence, type Ring } from './fieldPresence'
import { createGamesWindow, type GamesWindow } from './gamesWindow'
import { componentUse, removalRefusal } from './componentUse'
import { assetRefusal } from './assetRefusal'
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
import { MODES, MODE_LIST, soleMode } from './modes'
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
let inspectorRefresh: () => void = () => {}
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
 * the server keeps it in its state folder and relays it to everyone in the room. Not to be confused with the
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
 * The Level row is picked rather than a node (ADR 0162). Its own flag, beside `envSelected`, for the same
 * reason: a sentinel index in `selection` would eventually reach a structural operation that reads that list.
 */
let levelSelected = false
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
 * Each game's data file — its shared-component list (ADR 0077) and its settings (ADR 0087) — as it is **right
 * now**: read over `/api/games` at boot, then kept current as it is edited live, by anyone (`gameSync`, ADR 0162).
 * The game's own `registry` already folds the list in at build time, but the editor's bundle does not reload when
 * it changes (see `vite.config.ts`), so the live list replaces the code's rather than being trusted from it.
 */
const gameData: Record<string, GameData> = {}
/** Where each game's copy in `gameData` came from, for the live edits that follow it. */
const gameOrigins: Record<string, Origin | undefined> = {}

/**
 * A game's registry: its code's own and built-in components, and the shared ones its live data file lists now —
 * added since the build, or taken out (ADR 0175). Every shared type in a game's code came from that list.
 */
const registryFor = (mode: ModeDescriptor): Registry => {
  const live = gameData[mode.name]?.components
  if (live === undefined) return mode.registry
  const code = mode.registry.all()
  const kept = code.filter((d) => !isSharedComponent(d.type) || live.includes(d.type))
  const have = new Set(kept.map((d) => d.type))
  const extra = live.filter((type) => !have.has(type) && isSharedComponent(type))
  return extra.length === 0 && kept.length === code.length ? mode.registry : createRegistry([...kept, ...sharedComponents(extra)])
}

/**
 * A data type as the game whose library holds the asset declares it (ADR 0181), or `undefined`: a path in Shared, a
 * game this build has no code for, a type that game does not declare.
 */
const dataTypeAt = (path: string, type: string): DataTypeDef | undefined => {
  const game = libraryOf(path)
  return game === null || game === undefined ? undefined : MODES[game]?.dataTypes?.find((d) => d.type === type)
}

/** Whether asset `id` fits a field taking `of`: any of its kind, and for a data field only its type (ADR 0181). */
const ofDataType = (id: string, of: string, dataType: string | undefined): boolean => of !== 'data' || dataType === undefined || assets?.dataOf(id)?.type === dataType

/** The component set the open document is validated and edited against. */
const registry = (): Registry => (activeMode === undefined ? DEFAULT_REGISTRY : registryFor(activeMode))

/** Shared components the active game does not have — what a placement or an Add Component may adopt. */
const adoptable = (): string[] => {
  if (activeMode === undefined) return []
  const reg = registryFor(activeMode)
  return SHARED_COMPONENT_TYPES.filter((type) => !reg.has(type))
}

/**
 * Add shared components to the active game (ADR 0077): an edit to its live data file (ADR 0162), shown at once —
 * the registry grows and the open document is rebuilt against it (`gameShown`) — and written behind. The game's
 * dev server sees the file change and reloads.
 */
const adopt = async (types: readonly string[]): Promise<void> => {
  const mode = activeMode
  if (mode === undefined) return
  const have = gameData[mode.name] ?? { components: [], settings: {} }
  const fresh = types.filter((type) => isSharedComponent(type) && !have.components.includes(type))
  if (fresh.length === 0) return
  gameSync.edit(gameDocId(mode.name), [{ kind: 'set', path: ['components'], value: [...have.components, ...fresh].sort() }])
  notify.ok(`added ${fresh.join(', ')} to ${mode.label}`)
}

/**
 * Take a shared component out of a game (ADR 0175): an edit to its live data file, refused while any of its
 * levels or its own prefabs still use it, with where. The level list is fetched again first — the server counts
 * what is open in a room, and a friend may have placed one since the window opened.
 */
const removeShared = async (game: string, type: string): Promise<void> => {
  const mode = MODES[game]
  if (mode === undefined || gameData[game]?.components.includes(type) !== true) return
  await refreshFileList()
  const db = assets?.db
  const prefabs = (db === undefined ? [] : assetsOfKind(db, 'prefab')).map((a) => ({ name: a.name, path: a.path, root: assets?.prefabOf(a.id) }))
  const label = registryFor(mode).get(type)?.label ?? type
  const why = removalRefusal(label, componentUse(type, game, levelEntries, prefabs))
  if (why !== null) {
    notify.warn(why)
    return
  }
  // Read again past the fetch: the list may have changed while it was out.
  const now = gameData[game]
  if (now === undefined || !now.components.includes(type)) return
  gameSync.edit(gameDocId(game), [{ kind: 'set', path: ['components'], value: now.components.filter((t) => t !== type) }])
  notify.ok(`removed ${label} from ${mode.label}`)
}

/**
 * A game setting changed (ADR 0162): an edit to the game's live data file, shown at once and sent behind, and an
 * entry in the one undo history. `ongoing` while a number is dragged, so the drag is one entry.
 */
const changeGameSetting = (game: string, key: string, value: number | CurvePoint[], ongoing: boolean): void => {
  const mode = MODES[game]
  const have = gameData[game]
  if (mode === undefined || have === undefined) return
  const ops = diffAssetOps(have.settings[key], value, ['settings', key])
  const id = gameDocId(game)
  gameSync.edit(id, ops)
  const label = `${mode.label} ${mode.settings?.[key]?.label ?? key}`
  edits.recordAsset({ assetId: id, ops, inverses: applyAssetOps(have, ops).inverses.reverse(), label }, ongoing)
}

/**
 * A game's data file changed on screen — this tab's edit, anyone's, an undo (ADR 0162) — and what follows it: the
 * open level rebuilt against the registry when the list changed, the surface cells a setting lays out (the key
 * pitch, ADR 0120), and the games window's fields.
 */
const gameShown = (game: string, before: GameData | undefined): void => {
  const now = gameData[game]
  if (now === undefined) return
  const active = activeMode?.name === game
  if (JSON.stringify(before?.components) !== JSON.stringify(now.components)) {
    if (active && doc !== null) reopenWithRegistry()
    gamesWindow.render()
  }
  if (JSON.stringify(before?.settings) !== JSON.stringify(now.settings)) {
    if (active && activeMode?.surfaceGrid !== undefined) meshes.buildAll()
    gamesWindow.settingsChanged(game)
  }
}

/** Loaded assets. Both arrive at boot, before any document is opened. */
let assets: AssetLibrary | null = null

// ============================== the server ==============================
/** Who the server says you are. `null` until boot has asked. */
let me: Me | null = null
/** The last push failure the server reported, or `''`. Kodjo's to fix; shown so nobody thinks their work is on GitHub. */
let pushProblem = ''

/** Let go of the open file: leave its rooms, which is what commits the session there (ADR 0089). */
const leaveFile = (): void => {
  room.leaveAll()
  follow.reset()
  edits.discardHeld()
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
  inspectorRefresh: () => inspectorRefresh(),
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
  onMotion: (from, ms) => follow.onMotion(from, ms),
  holdsChanged: () => follow.holdsChanged(),
  // A material's edit, or a game data file's (ADR 0162): each to the copies that follow it.
  onAsset: (data) => (gameOfDocId(parseAssetEvent(data)?.assetId ?? '') === null ? assetSync : gameSync).onEvent(data),
  openAssetIds: () => (selectedAsset === null ? [] : [selectedAsset]),
  openAssetsChanged: () => {
    assetInspector.openersChanged()
    project.openersChanged()
  },
  fieldsChanged: () => {
    objectFields.repaint()
    assetFields.repaint()
  },
  roomsChanged: () => gamesWindow.render(),
  levelsChanged: () => void refreshFileList(),
  dropHistoryWhere: (predicate) => edits.dropWhere(predicate),
})
/** The connection the room last reported, so a reconnect is noticed. */
let presenceConn: string | null = null

/** Is the open document a live room? Prefabs are too (ADR 0091). */
const live = (): boolean => room.live()

/**
 * A level's own name, without its game (ADR 0108).
 *
 * `fileState.name` is the qualified `<game>/<name>` — what the route and the live document key
 * all use. Two places want the bare half: the name in the top bar, and the game's `?level=`, which a page
 * qualifies with its own game. A prefab's name is already bare and passes straight through.
 */
const shortName = (qualified: string): string => parseQualified(qualified)?.name ?? qualified


/**
 * Prefab definitions, as the `PrefabSource` `hydratePrefabs` takes (ADR 0091). `loadAssetLibrary` already
 * fetched every prefab file at boot, so resolving a level's references costs nothing and needs no await.
 */
const editorPrefabs: PrefabSource = { root: (assetId) => assets?.prefabOf(assetId) }
/** Prefab references the open level could not resolve — named in the Hierarchy and the status line. */
let missingPrefabs: string[] = []
/** What hydration added to the open level's table, so a save writes the references and not the definitions. */
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
  selection: () => selection,
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
 * Node `i`'s local transform under `parent` (`null` = the level root) that keeps it where it is in the world, read off
 * the **authored** poses (ADR 0126) and rounded as the document stores it — what a reparent writes, so nothing jumps.
 * `undefined` when a group is missing. The Hierarchy's drag and the reparent action both write this.
 */
const reframedLocal = (i: number, parent: number | null): Transform | undefined => {
  const parentGroup = parent === null ? null : (meshes.groupAt(parent) ?? null)
  const local = motion.withAuthoredPoses(() => localInside(meshes.groupAt(i), parentGroup))
  if (local === null) return undefined
  return {
    position: local.position,
    ...(isZeroRot(new THREE.Euler(local.rotation.x, local.rotation.y, local.rotation.z, 'XYZ'))
      ? {}
      : { rotation: vec3(roundAngle(local.rotation.x), roundAngle(local.rotation.y), roundAngle(local.rotation.z)) }),
    ...(isOne(new THREE.Vector3(local.scale.x, local.scale.y, local.scale.z)) ? {} : { scale: vec3(r4(local.scale.x), r4(local.scale.y), r4(local.scale.z)) }),
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
  levelSelected = false
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
  selectLike: (leader) => selectLike(leader),
  busy: () => tool.dragging() || points.dragging() || fieldDragging,
  motion: () => (motion.playing() ? motion.timeMs() : null),
  setMotion: (ms) => {
    if (ms === null) {
      if (motion.playing()) motion.setPlaying(false)
      return
    }
    if (!motion.playing()) motion.setPlaying(true)
    motion.setTime(ms)
  },
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
  // Anything, whoever else has it selected too (ADR 0158): theirs is shown, never in the way.
  selection = clampTo(next, doc?.count() ?? 0)
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

/**
 * Select one item outright — the plain click, and what every command that lands on a new item does.
 *
 * A selection of your own ends a follow (ADR 0184, Kodjo's call), as moving the camera does: the leader's next
 * would replace it. So do `selectWith`, `selectAsset` and `deselectOwn` — the inputs, never a restore after a
 * rebuild nor the follow's own `selectLike`, which go through `applySelection` and `deselect`.
 */
const select = (index: number): void => {
  if (meshes.groupAt(index) === undefined || doc === null) return
  follow.stop()
  applySelection([index])
}

/** A click that carries modifiers: Ctrl toggles one, Shift extends a range over `order`. */
const selectWith = (index: number, mode: SelectMode, order: readonly number[]): void => {
  if (meshes.groupAt(index) === undefined || doc === null) return
  follow.stop()
  applySelection(applySelect(selection, index, mode, order))
}

/**
 * What the leader holds, as this tab's selection (ADR 0184) — in the order they took it, so their primary is
 * yours. Nothing when it already is, so a hold elsewhere in the room rebuilds no Inspector.
 */
const selectLike = (leader: string): void => {
  const open = doc
  if (open === null || play.active()) return
  const theirs = room
    .holdsOf(leader)
    .map((h) => open.indexOfRef(h.ref))
    .filter((i): i is number => i !== null)
  const showsOther = selectedAsset !== null || envSelected || levelSelected
  if (!showsOther && theirs.length === selection.length && theirs.every((i, n) => selection[n] === i)) return
  // Theirs is the Inspector's one thing: not an asset, the sun or the level of yours from before the follow.
  envSelected = false
  levelSelected = false
  if (theirs.length > 0) applySelection(theirs)
  else {
    if (selectedAsset !== null) {
      selectedAsset = null
      assetInspector.show(null)
    }
    deselect()
  }
}

/**
 * Whose the document being edited is (ADR 0161): an open prefab's library — `null` for Shared's — or else the open
 * level's game. What its pickers offer and what may be placed in it follow from this (`mayUse`).
 */
const editingFor = (): string | null => {
  if (prefabOpen !== null) {
    const entry = assets?.db.byId[prefabOpen.assetId]
    return entry === undefined ? null : (libraryOf(entry.path) ?? null)
  }
  return activeMode?.name ?? null
}

const deselect = (): void => {
  selection = []
  selected = null
  tool.control.detach()
  inspectorRebuild()
  uiChanged()
  room.syncHolds()
}

/** A deselect of your own — a click on nothing, Escape, the sun's or the level's row: it ends a follow (`select`). */
const deselectOwn = (): void => {
  follow.stop()
  deselect()
}

/**
 * Show an asset in the Inspector. Selecting an asset and selecting something in the scene are the same slot in
 * the Inspector, so one clears the other rather than both claiming it.
 */
const selectAsset = (assetId: string): void => {
  follow.stop()
  selectedAsset = assetId
  deselect()
  assetInspector.show(assetId)
  refreshUi()
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
  deselect: () => deselectOwn(),
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
    run: () => {
      follow.stop()
      applySelection(doc === null ? [] : Array.from({ length: doc.count() }, (_, i) => i))
    },
    enabled: () => !play.active() && doc !== null && doc.count() > 0,
  },
  // The menu offers Focus with `F` beside it, so the key has to exist or the menu is lying.
  { id: 'focus', chords: ['f'], label: 'Focus the selection', run: () => nodes.focusSelection(), enabled: () => !play.active() && selection.length > 0 },
  // Unity's Align to Grid (ADR 0180). On a layout with no plain backslash key, the right-click menu has it.
  { id: 'align', chords: ['mod+\\'], label: 'Align to grid', run: () => tool.alignToGrid(), enabled: () => !play.active() && selection.length > 0 },
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
      deselectOwn()
    },
    // The only binding that stays live during play, because it is the way out of it.
    enabled: () => true,
  },
])

window.addEventListener('keydown', (e) => {
  editorShortcuts.handle(e)
})



// ============================ play, in the real game ============================
/**
 * Play is its own module (`play.ts`): the game's page in a frame, and nothing else (ADR 0172). What is left here
 * is its host — the getter bag every panel is wired with.
 */
const play = createPlay({
  controls,
  doc: () => doc,
  // Not a level, no game, or the server knows no page for it (ADR 0086).
  gamePageUrl: () =>
    fileState.mode !== 'level' || activeMode === undefined ? null : (me?.games[activeMode.name] ?? null),
  noPageReason: () => {
    if (fileState.mode !== 'level') return 'Play runs a level: open one to play it'
    if (activeMode === undefined) return 'this level’s game is not in the editor, so it has nowhere to play'
    return me?.games[activeMode.name] === undefined ? `${activeMode.label} has no game page on this server, so it cannot be played here` : null
  },
  fileName: () => fileState.name,
  levelName: () => shortName(fileState.name),
  live: () => live(),
  flush: () => room.flush(),
  hint: (text) => {
    playHint = text
    renderStatus()
  },
  refuse: (message) => notify.error(message),
  uiChanged: () => uiChanged(),
})

// ============================ panels ============================
// The shell is CSS grid (see index.html); each panel is its own module, and every one of them reads
// the editor's state through a getter rather than being handed a snapshot — so `refreshUi()` is the
// single "something changed, redraw the chrome" call, and no panel can hold a stale copy.

const app = $<HTMLDivElement>('#app')

const fileState: { mode: Mode; name: string } = { mode: 'level', name: 'untitled' }

const openFile = async (name: string): Promise<void> => {
  // The previous file goes first — leaving its room is what commits that session (ADR 0089).
  leaveFile()
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
       * already there.
       */
      missingPrefabs = hydratePrefabs(level, editorPrefabs).missing
      setDoc(edits.withOps(levelDoc(level, registry())), name)
      // Only now, past every throw above: a level that would not load must not be the one we come back to.
      rememberLevel(name)
      if (missingPrefabs.length > 0) notify.warn(`no prefab file for ${missingPrefabs.join(', ')} — those objects are empty`)
    }
  } catch (e) {
    notify.error(`load failed: ${String(e)}`)
  }
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
  gamesWindow?.render()
}

/**
 * Make a level file and open it live (ADR 0089): a blank one, or a copy of `from` — the server's current copy,
 * newer than the file while it is open. Names are files, so one that exists is refused.
 */
const createLevel = async (from: string | null, inGame?: string): Promise<void> => {
  /**
   * A level is made **in a game's folder** (ADR 0108), so there has to be a game: without one there is
   * nowhere for the file to go. Duplicating keeps the original's game; a blank one goes to the game asked for, or
   * the active one.
   */
  const game = (from === null ? (inGame ?? activeMode?.name) : parseQualified(from)?.game) ?? activeMode?.name
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
    game: activeMode?.label ?? null,
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
    history: historyView(),
    unseen: notices.unseen(),
    admin: me?.admin === true,
  }),
  {
    back: prefabs.closePrefab,
    openGames: () => gamesWindow.open(),
    undo: () => edits.undo(),
    redo: () => edits.redo(),
    toggleLog: (anchor) => notices.toggleLog(anchor),
    openAdmin: () => void window.open('/admin.html', '_blank', 'noopener'),
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
    levelSelected = false
    deselectOwn()
    hierarchy.render()
  },
  levelSelected: () => levelSelected,
  onSelectLevel: () => {
    levelSelected = true
    envSelected = false
    deselectOwn()
    hierarchy.render()
  },
  onSelect: (index, mode, order) => {
    envSelected = false
    levelSelected = false
    selectWith(index, mode, order)
  },
  // Who else has it selected, each in their colour (ADR 0158): shown, never in the way.
  holders: (index) => room.holdersOf(index).map((h) => ({ name: h.name, colour: peerCss(h.connId) })),
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
    const planned = moving.map((i) => ({ ref: open.refAt(i), reframed: reframedLocal(i, parent) }))
    // Refs, not indices: each move renumbers the tree depth-first, so every index after the first is stale.
    const parentRef = parent === null ? null : open.refAt(parent)

    const landedRefs: (NodeRef | null)[] = []
    let slot = at
    for (const step of planned) {
      if (step.ref === null) continue
      const here = open.indexOfRef(step.ref)
      const into = parentRef === null ? null : open.indexOfRef(parentRef)
      if (here === null || (parentRef !== null && into === null)) continue
      const landed = open.reparent(here, into, slot, step.reframed)
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
  gameLabel: () => activeMode?.label ?? null,
  alignToGrid: () => tool.alignToGrid(),
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
  editingFor: () => editingFor(),
  adoptable: () => adoptable(),
  adopt: (types) => adopt(types),
  recordEdit: (label) => edits.recordEdit(label),
  room: { live: () => live(), flush: () => room.flush(), leave: () => room.leave() },
  openFile: (qualified) => openFile(qualified),
  openFirstLevel: () => openFirstLevel(),
  refreshFileList: () => refreshFileList(),
  reloadAssets: (named) => reloadAssets(named === undefined ? {} : { named }),
  invalidatePreviews: () => previews.invalidate(),
  notify,
  refreshUi: () => refreshUi(),
})

/**
 * A prefab or a model dragged from the Project window into the viewport (`dragPlace.ts`, ADR 0164): a see-through
 * copy under the pointer, placed where it is let go.
 */
const dragPlace = createDragPlace(canvas, {
  scene: stage.scene,
  subject: (id) => {
    const entry = assets?.db.byId[id]
    if (entry?.kind === 'model') return runtime?.model(id) ?? null
    const root = entry?.kind === 'prefab' ? assets?.prefabOf(id) : undefined
    // Placed, it has only its own position: a placement's transform is its own, not the prefab root's (`prefabs.ts`).
    return root === undefined ? null : prefabObject({ ...root, transform: { position: vec3(0, 0, 0) } }, runtime)
  },
  load: async (id) => {
    await runtime?.load([id])
  },
  refusal: (id) => (play.active() ? 'not while playing' : doc === null ? 'nothing is open' : fileOps.unplaceableWhy(id)),
  surfaceUnder: (x, y) => pick.surfaceUnder(x, y),
  place: (id, at) => fileOps.whenPlaceable(id, (kind) => pick.placeAsset(kind, id, at)),
  readout: (text, at) => showReadout(text, at),
})

/**
 * What a drag of Project window tiles carries, by id, while one is under way (ADR 0176): a reference field has to
 * know before the drop, and a browser drag cannot say until then.
 */
let draggedAssets: readonly string[] = []

/** An asset's tile, shown in the Project window with the selection left alone: where a reference field points. */
const revealAsset = (id: string): void => {
  const path = assets?.db.byId[id]?.path
  if (path !== undefined) project.reveal(path)
}

const project: Project = createProjectPanel($<HTMLDivElement>('#palette'), {
  db: () => assets?.db ?? null,
  folders: () => assets?.folders ?? [],
  game: () => (activeMode === undefined ? null : { name: activeMode.name, label: activeMode.label }),
  menu: contextMenu,
  selectedAsset: () => selectedAsset,
  openers: (id) => room.openersOf(id).map((p) => ({ name: p.name, colour: peerCss(p.connId) })),
  unplaceableWhy: (id) => fileOps.unplaceableWhy(id),
  onOpenPrefab: (id) => {
    if (prefabOpen !== null) notify.warn('leave the prefab you are in first')
    else void prefabs.enterPrefab(id)
  },
  onDragAsset: (id) => dragPlace.dragging(id),
  onDragAssets: (ids) => void (draggedAssets = ids),
  onUpload: (files, folder) => {
    const cap = me?.maxUploadBytes ?? Infinity
    const tooBig = files.filter((f) => f.size > cap).map((f) => f.name)
    if (tooBig.length > 0) notify.warn(`too big (cap ${Math.round(cap / 1024 / 1024)} MB): ${tooBig.join(', ')}`)
    const fits = files.filter((f) => f.size <= cap)
    if (fits.length === 0) return
    const paths = fits.map((f) => `${folder}/${f.name}`)
    // Named, because a file uploaded over another keeps its id: only its bytes say it changed (ADR 0157).
    fileOps.afterFileOp(
      `uploaded ${fits.map((f) => f.name).join(', ')}`,
      async () => {
        for (const [i, f] of fits.entries()) await uploadAsset(paths[i]!, f)
      },
      paths,
    )
  },
  onSelectAsset: (assetId) => selectAsset(assetId),
  requestPreview: (kind, key, done) => previews.request(kind, key, done),
  dataTypes: (folder) => {
    const game = libraryOf(folder)
    return game === null || game === undefined ? [] : (MODES[game]?.dataTypes ?? []).map((d) => ({ type: d.type, path: dataMenuPath(d) }))
  },
  /**
   * New data (ADR 0181): a data asset of `type`, every field at its default, named after the type — `Keyboard-Style`,
   * then `Keyboard-Style-1` — in `folder`, which `dataTypes` only offers inside the declaring game's library.
   */
  onCreateData: (type, folder) => {
    void (async () => {
      const def = dataTypeAt(folder, type)
      if (assets === null || def === undefined) return
      const base = (def.label ?? def.type).replace(/[^\w-]+/g, '-') || 'data'
      const taken = (name: string): boolean => assets?.db.entries.some((e) => e.path === `${folder}/${name}.data.json`) === true
      let name = base
      for (let n = 1; taken(name); n++) name = `${base}-${n}`
      const created = await assets.createData(name, newDataAsset(def), folder).catch((e: unknown) => {
        notify.error(`new ${def.label ?? def.type} failed: ${String(e)}`)
        return undefined
      })
      await reloadAssets()
      if (created !== undefined) {
        selectedAsset = created.id
        assetInspector.show(created.id)
        room.syncHolds()
      }
      refreshUi()
    })()
  },
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
        room.syncHolds()
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
    const prefabHere = entry?.kind === 'prefab' ? entry.id : null
    // Placing is a drag into the viewport, and showing one in the Inspector a click (ADR 0164).
    contextMenu.open(
      at,
      [
        {
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
          hint: 'F2',
          run: () => askRenameAsset(path),
        },
        {
          label: isFolder ? (inFolder > 0 ? `Delete folder and ${inFolder} asset${inFolder === 1 ? '' : 's'}` : 'Delete empty folder') : 'Delete',
          divider: true,
          // It asks for itself: a folder with prefabs in it asks what their placements become (ADR 0097).
          run: () => fileOps.deleteAsset(path),
        },
      ],
      current,
    )
  },
  onMkdir: (parent, name) => fileOps.afterFileOp(`created ${name}`, async () => assets?.mkdir(parent, name) ?? Promise.resolve()),
  onMove: (froms, toFolder) => {
    // Refuse a folder into its own subtree here as well as on the server: a rejected drop should not need a
    // round trip to say so. Several go together or not at all (ADR 0166).
    if (froms.some((from) => !from.includes('.') && !canMoveFolder(from, toFolder))) {
      notify.warn('a folder cannot move inside itself')
      return
    }
    const moves = froms.map((from) => ({ from, to: movedInto(from, toFolder) }))
    const what = froms.length === 1 ? `moved into ${toFolder}` : `moved ${froms.length} items into ${toFolder}`
    fileOps.afterFileOp(what, async () => (moves.length === 1 ? assets?.move(moves[0]!.from, moves[0]!.to) : assets?.moveMany(moves)) ?? Promise.resolve())
  },
  onDelete: (paths) => fileOps.deleteAssets(paths),
  onRename: (path) => askRenameAsset(path),
  fileOf: (path) => assets?.fileOf(path),
})

/** Rename an asset or a folder, asked with its name now: the menu's *Rename…*, and F2 in the Project window. */
function askRenameAsset(path: string): void {
  const current = path.slice(path.lastIndexOf('/') + 1)
  const name = prompt('Rename', current)
  if (name === null || name.trim() === '' || name.trim() === current) return
  fileOps.renameAsset(path, name.trim())
}

/**
 * A level's menu (ADR 0110), from its tile in the games window (ADR 0162): Open, Duplicate, Rename, Copy name,
 * Delete. The host's, because it needs the open document — is this the one you are in? — and the listing.
 */
const levelMenu = (at: { x: number; y: number }, qualified: string): void => {
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
        run: () => void openFile(qualified),
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
}

/**
 * The games window (ADR 0162): every game, its levels with who is in each, and its components. Opening a level from
 * it is how the editor moves between games; picking a game there only browses.
 */
const ENGINE_TYPES = new Set([...ENGINE_COMPONENTS, ...PLAYER_COMPONENTS].map((d) => d.type))
const gamesWindow: GamesWindow = createGamesWindow({
  games: () => MODE_LIST.map((m) => ({ name: m.name, label: m.label })),
  levels: () => levelEntries,
  game: () => activeMode?.name ?? null,
  openLevel: () => fileState.name,
  peopleIn: (qualified) => room.peopleIn(qualified).map((p) => ({ name: p.name, colour: peerCss(p.connId) })),
  components: (game) => {
    const mode = MODES[game]
    if (mode === undefined) return null
    const rows = registryFor(mode)
      .all()
      .map((d) => ({ type: d.type, label: d.label ?? d.type }))
    return {
      own: rows.filter((r) => !ENGINE_TYPES.has(r.type) && !isSharedComponent(r.type)),
      shared: rows.filter((r) => !ENGINE_TYPES.has(r.type) && isSharedComponent(r.type)),
      engine: rows.filter((r) => ENGINE_TYPES.has(r.type)),
    }
  },
  onRemoveShared: (game, type) => void removeShared(game, type),
  onOpenLevel: (qualified) => {
    gamesWindow.close()
    void openFile(qualified)
  },
  onNewLevel: (game) => {
    gamesWindow.close()
    void createLevel(null, game)
  },
  onLevelContext: (at, qualified) => levelMenu(at, qualified),
  moveRefusal: (qualified, game) => levelMoveRefusal(qualified, game),
  onMoveLevel: (qualified, game) => {
    const why = levelMoveRefusal(qualified, game)
    if (why !== null) {
      notify.warn(`${shortName(qualified)} not moved: ${why}`)
      return
    }
    fileOps.moveLevelToGame(qualified, game, MODES[game]?.label ?? game)
  },
  /** What the game declares (ADR 0087/0088), over what its data file holds now. */
  settings: (game) => {
    const mode = MODES[game]
    if (mode === undefined) return null
    const decls = mode.settings ?? {}
    return { decls, values: readSettings(decls, gameData[game]?.settings) }
  },
  onSettingChanged: (game, key, value, ongoing) => changeGameSetting(game, key, value, ongoing),
  undo: () => edits.undo(),
  redo: () => edits.redo(),
})

/**
 * Why a level cannot move to `game` (ADR 0162), or `null`, from what the editor knows before asking the server: a
 * level of that name there already, someone in it, a component of another game's own that `game` cannot have. The
 * server refuses the rest — its old game's own assets — with why.
 */
function levelMoveRefusal(qualified: string, game: string): string | null {
  const ref = parseQualified(qualified)
  const mode = MODES[game]
  if (ref === null) return 'not a level'
  if (mode === undefined) return 'this build has no code for that game'
  if (levelEntries.some((e) => e.name === qualify({ game, name: ref.name }))) return `${mode.label} already has a level called ${ref.name}`
  const inside = room.peopleIn(qualified)
  if (inside.length > 0) return `${inside.map((p) => p.name).join(' and ')} ${inside.length === 1 ? 'is' : 'are'} in it`
  const target = registryFor(mode)
  const source = MODES[ref.game]
  const types = levelEntries.find((e) => e.name === qualified)?.components ?? []
  const foreign = types.filter((t) => !target.has(t) && !isSharedComponent(t))
  if (foreign.length > 0) {
    const labels = foreign.map((t) => (source === undefined ? undefined : registryFor(source).get(t)?.label) ?? t)
    return `it uses ${labels.join(', ')}, which ${mode.label} does not have`
  }
  return null
}

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
 * Undo, redo and the clipboard (`historyStore.ts`, ADR 0121). It owns the history, the pending batches, the
 * coalescing flag, the held-back drag batches and the clipboard.
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
  rebuildViewport: () => {
    meshes.buildAll()
    rebuildLoaded()
  },
  repaint: (ops) => room.repaint(ops),
  loadNewReferencesThen: (redraw) => loadNewReferences(redraw),
  // As this tab's edit: a material's through `assetSync`, and it then shows, the way a level undo shows the
  // selection; a game's data file's through `gameSync`, the games window's fields following if it is open.
  applyAsset: (id, ops, what, show = true) => {
    const game = gameOfDocId(id)
    const shown = game === null ? (assets?.materialOf(id) ?? assets?.dataOf(id)) : gameData[game]
    if (shown === undefined) {
      notify.warn(`cannot ${what}: the ${game === null ? 'asset' : 'game'} is gone`)
      return false
    }
    try {
      applyAssetOps(shown, ops)
    } catch (e) {
      notify.warn(`cannot ${what}: ${e instanceof LiveAssetError ? e.message : String(e)}`)
      return false
    }
    if (game !== null) {
      gameSync.edit(id, ops)
      return true
    }
    assetSync.edit(id, ops)
    if (show) selectAsset(id)
    return true
  },
  assetNow: (id) => {
    const game = gameOfDocId(id)
    return game === null ? (assets?.materialOf(id) ?? assets?.dataOf(id)) : gameData[game]
  },
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
  // Your own press ends a follow (ADR 0184), and tells anyone following you.
  follow.stop()
  motion.setPlaying(on)
  follow.motionChanged()
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
/**
 * Why an asset field may not take this asset, or `null`: a library the document may not use (ADR 0161), another kind,
 * a data asset of another type (ADR 0181). The Inspector's refusal, and an action's (ADR 0194).
 */
const fieldAssetRefusal = (of: AssetKind, id: string, dataType: string | undefined): string | null =>
  assetRefusal(assets?.db ?? null, of, id, editingFor()) ??
  (ofDataType(id, of, dataType) ? null : `this takes a ${(activeMode?.dataTypes ?? []).find((d) => d.type === dataType)?.label ?? dataType}, not a ${assets?.dataOf(id)?.type ?? 'data asset of another type'}`)

/**
 * A material edit is ops on its live document (ADR 0159): the difference between it as shown and as edited, shown at
 * once and sent behind (`assetSync.ts`), and an entry in the one undo history — or a step of `turn`, an agent's prompt
 * (ADR 0194). No lock: anyone edits it, the last change to land stays.
 */
const editMaterial = (id: string, material: MaterialAsset, label: string, ongoing: boolean, turn: Turn | null): void => {
  const before = assets?.materialOf(id)
  if (before === undefined) return
  const shaderChanged = before.shader !== material.shader
  const ops = diffAssetOps(before, material)
  assetSync.edit(id, ops)
  edits.recordAsset({ assetId: id, ops, inverses: applyAssetOps(before, ops).inverses.reverse(), label }, ongoing, turn)
  // Its fields are the new shader's; any other edit leaves the panel — and the field being dragged — alone.
  if (shaderChanged) assetInspector.show(id)
}

/** A data asset edited (ADR 0181), as a material is: ops on its live document, and one undo entry per drag. */
const editData = (id: string, data: DataAsset, label: string, ongoing: boolean, turn: Turn | null): void => {
  const before = assets?.dataOf(id)
  if (before === undefined) return
  const ops = diffAssetOps(before, data)
  assetSync.edit(id, ops)
  edits.recordAsset({ assetId: id, ops, inverses: applyAssetOps(before, ops).inverses.reverse(), label }, ongoing, turn)
}

const assetInspector: AssetInspector = createAssetInspector($<HTMLDivElement>('#asset-inspector'), {
  db: () => assets?.db ?? null,
  draggedAssets: () => draggedAssets,
  revealAsset: (id) => revealAsset(id),
  urlOf: (path) => assets?.urlOf(path) ?? path,
  materialOf: (id) => assets?.materialOf(id),
  openers: (id) => room.openersOf(id).map((p) => ({ name: p.name, colour: peerCss(p.connId) })),
  fileOf: (path) => assets?.fileOf(path),
  picture: (kind, id, done) => previews.request(kind, id, done, 'big'),
  prefabOf: (id) => assets?.prefabOf(id),
  componentLabel: (type) => registry().get(type)?.label ?? type,
  /** Loaded on the way if nothing placed it yet: the runtime only preloads what the open document uses. */
  modelFacts: async (id) => {
    if (runtime === null) return null
    if (runtime.model(id) === null) await runtime.load([id]).catch(() => undefined)
    const model = runtime.model(id)
    if (model === null) return null
    let triangles = 0
    let meshes = 0
    model.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return
      meshes++
      const g = o.geometry as THREE.BufferGeometry
      triangles += (g.index?.count ?? g.getAttribute('position')?.count ?? 0) / 3
    })
    return { triangles: Math.round(triangles), meshes }
  },
  users: (id) => fetchUsers(id),
  levelLabel: (qualified) => {
    const ref = parseQualified(qualified)
    return ref === null ? qualified : `${MODES[ref.game]?.label ?? ref.game} › ${ref.name}`
  },
  named: (path) => project.named(path),
  onOpenLevel: (qualified) => void openFile(qualified),
  // As a tile clicked in the Project window: selected there too, its folder open.
  onSelectAsset: (id) => {
    const path = assets?.db.byId[id]?.path
    selectAsset(id)
    if (path !== undefined) project.reveal(path)
  },
  /**
   * A material edit is ops on its live document (ADR 0159): the difference between it as shown and as edited,
   * shown at once and sent behind (`assetSync.ts`), and an entry in the one undo history. No lock: anyone edits
   * it, the last change to land stays.
   */
  onMaterialChanged: (id, material, label, ongoing = false) => editMaterial(id, material, label, ongoing, null),
  dataOf: (id) => assets?.dataOf(id),
  dataTypeOf: (path, type) => dataTypeAt(path, type),
  /** A data asset edited (ADR 0181), as a material is: ops on its live document, and one undo entry per drag. */
  onDataChanged: (id, data, label, ongoing = false) => editData(id, data, label, ongoing, null),
})

/**
 * Data-file assets edited live (`assetSync.ts`, ADR 0159): this tab's edits and everyone's, in the server's order,
 * onto the library's copies, the renderer following each in place (ADR 0157).
 */
const assetSync = createAssetSync({
  shown: (id) => assets?.materialOf(id) ?? assets?.dataOf(id),
  origin: (id) => assets?.originOf(id),
  show: (id, json, remote) => {
    const library = assets
    if (library === null) return
    // A data asset (ADR 0181): only its panel shows it; nothing is drawn from one in the editor.
    if (library.db.byId[id]?.kind === 'data') {
      if (!isDataAsset(json)) return
      library.setData(id, json)
      if (remote && selectedAsset === id) assetInspector.refresh(id)
      return
    }
    if (!isMaterialJson(json)) return
    library.setMaterial(id, json)
    void refreshCompiled([id]).then((rebuild) => {
      if (rebuild) meshes.buildAll()
    })
    // Someone else's edit: the panel's values follow, without redrawing a field being worked in.
    if (remote && selectedAsset === id) assetInspector.refresh(id)
    thumbnailsSoon()
  },
  fetch: (id) => assets?.fetchLive(id) ?? Promise.resolve(null),
  post: (id, batch) => postLiveOps(`/api/live/asset/${id}/ops`, batch),
  refused: (id, why) => {
    notify.error(`${assets?.db.byId[id]?.name ?? 'asset'}: edit not saved — ${why}`)
    if (selectedAsset === id) assetInspector.refresh(id)
  },
})

/**
 * Each game's data file edited live (ADR 0162), the way a material is: this tab's edits and everyone's, in the
 * server's order, onto `gameData`.
 */
const gameSync = createAssetSync({
  shown: (id) => gameData[gameOfDocId(id) ?? ''],
  origin: (id) => gameOrigins[gameOfDocId(id) ?? ''],
  show: (id, json) => {
    const game = gameOfDocId(id)
    if (game === null) return
    const before = gameData[game]
    gameData[game] = parseGameData(json)
    gameShown(game, before)
  },
  fetch: async (id) => {
    const game = gameOfDocId(id)
    if (game === null) return null
    const { data, origin } = await loadGame(game)
    return origin === undefined ? null : { json: data, origin }
  },
  post: (id, batch) => postLiveOps(`/api/live/game/${gameOfDocId(id) ?? ''}/ops`, batch),
  refused: (id, why) => notify.error(`${MODES[gameOfDocId(id) ?? '']?.label ?? 'game'}: edit not saved — ${why}`),
})

/** A live document's batch, on this tab's room connection: `null` once the server took it, else why it did not. */
async function postLiveOps(url: string, batch: { batchId: string; ops: AssetOp[] }): Promise<string | null> {
  const connId = room.connId()
  if (connId === null) return 'not connected to the editor server'
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connId, ...batch }) })
  if (r.ok) return null
  const body = (await r.json().catch(() => null)) as { error?: unknown } | null
  return typeof body?.error === 'string' ? body.error : `refused (${r.status})`
}
const isMaterialJson = (v: unknown): v is MaterialAsset =>
  typeof v === 'object' && v !== null && typeof (v as { shader?: unknown }).shader === 'string'

/**
 * The thumbnails, once edits have settled: a material's sphere and every prefab drawn with it are stale, and
 * redrawing them on each step of a drag is a render per tile per step.
 */
let thumbnailTimer: number | null = null
const thumbnailsSoon = (): void => {
  if (thumbnailTimer !== null) clearTimeout(thumbnailTimer)
  thumbnailTimer = window.setTimeout(() => {
    thumbnailTimer = null
    previews.invalidate()
    project.render()
    if (selectedAsset !== null) assetInspector.pictureChanged(selectedAsset)
  }, 400)
}

// --- inspector ---
const inspector: Inspector = createInspector($<HTMLDivElement>('#insp-head'), $<HTMLDivElement>('#inspector'), {
  menu: contextMenu,
  pointsChanged: () => points.refresh(),
  doc: () => doc,
  adoptable,
  adopt: (type) => adopt([type]),
  gameLabel: () => activeMode?.label ?? null,
  selected: () => selected,
  envSelected: () => envSelected,
  levelSelected: () => levelSelected,
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
  /**
   * Paste Component Values on the Transform (ADR 0191): every selected object to the copied three lines, as one
   * edit — `writeAxis`'s way, through each group and its write-back, so a moving item's offset comes out right.
   */
  pasteTransform: (t) => {
    if (doc === null || tool.dragging() || selection.length === 0) return
    const q = eulerToQuat(vec3(THREE.MathUtils.degToRad(t.rotationDeg.x), THREE.MathUtils.degToRad(t.rotationDeg.y), THREE.MathUtils.degToRad(t.rotationDeg.z)))
    edits.beginDrag()
    try {
      for (const i of selection) {
        const g = meshes.groupAt(i)
        if (g === undefined) continue
        g.position.set(t.position.x, t.position.y, t.position.z)
        g.quaternion.set(q.x, q.y, q.z, q.w)
        g.scale.set(t.scale.x, t.scale.y, t.scale.z)
        tool.writeBackItem(i)
        meshes.rebuildSubtree(i)
      }
    } finally {
      edits.abortDrag()
    }
    edits.endDrag(selection.length > 1 ? `paste transform ${selection.length}` : 'paste transform')
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
    // Every selected object, as the edit was written to every one (ADR 0112) — kept, since the selection may
    // have moved on by the time a material arrives.
    const items = [...selection]
    edits.recordEdit('properties')
    meshes.rebuildSelected()
    scheduleRebuild()
    hierarchy.render() // a trigger or name change shows in the row's badge/label
    // Draw with what is loaded now, then again once a newly named material has arrived.
    if (items.length > 0) loadNewReferences(() => {
      for (const i of items) meshes.rebuildItem(i)
    })
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
  assetOptions: (of, dataType) => {
    const options: Record<string, string> = { '(none)': '' }
    // The built-in shapes (ADR 0090) sit in the model slot beside the uploaded files.
    if (of === 'model') for (const id of BUILTIN_MODELS) options[BUILTIN_LABELS[id]] = id
    const db = assets?.db
    // Only what the document may use (ADR 0161): its game's own and Shared's, or Shared's in a Shared prefab.
    const user = editingFor()
    if (db !== undefined) for (const a of assetsOfKind(db, of)) if (mayUse(user, a.path) && ofDataType(a.id, of, dataType)) options[a.name] = a.id
    return options
  },
  assetFolders: (of, dataType) => {
    const out: { id: string; label: string; folders: string[] }[] = []
    if (of === 'model') for (const id of BUILTIN_MODELS) out.push({ id, label: BUILTIN_LABELS[id], folders: ['Built-in'] })
    const db = assets?.db
    const user = editingFor()
    // The folders as the Project window names them: `Keyboard/materials/red.mat.json` is in Keyboard › materials.
    if (db !== undefined)
      for (const a of assetsOfKind(db, of))
        // A woff2 is a font the text library cannot read (ADR 0190): not offered, and refused if dropped.
        if (mayUse(user, a.path) && ofDataType(a.id, of, dataType) && !(of === 'font' && textFontRefusal(a.path) !== null))
          out.push({ id: a.id, label: a.name, folders: project.named(a.path).split('/').slice(0, -1) })
    return out
  },
  dataTypeLabel: (type) => (activeMode?.dataTypes ?? []).find((d) => d.type === type)?.label ?? type,
  assetRefusal: (of, id, dataType) => fieldAssetRefusal(of, id, dataType),
  draggedAssets: () => draggedAssets,
  pingNode: (index) => hierarchy.ping(index),
  revealAsset: (id) => revealAsset(id),
  selectNode: (index) => select(index),
  openAsset: (id) => {
    selectAsset(id)
    revealAsset(id)
  },
})

/**
 * Who is in which Inspector field (ADR 0160): this tab's, told to everyone, and the others' as rings. The object
 * Inspector's lines write to the selected nodes — or the level's game or environment settings — and the asset
 * Inspector's to the asset it shows. One spot for the tab: the asset Inspector's when it has one, so a late
 * "left the object field" cannot clear the asset field just gone into.
 */
let objectSpot: FieldSpot | null = null
let assetSpot: FieldSpot | null = null
const tellField = (): void => room.setField(assetSpot ?? objectSpot)
const objectTargets = (): string[] => {
  if (levelSelected) return [room.docTarget('@level')]
  if (envSelected) return [room.docTarget('@env')]
  return selectionRefs().map((r) => room.docTarget(refKey(r)))
}
/** What the object Inspector shows, as a target: the primary node, or the level's settings. */
const objectTarget = (): string | null => {
  if (levelSelected) return room.docTarget('@level')
  if (envSelected) return room.docTarget('@env')
  const ref = selected === null ? null : (doc?.refAt(selected) ?? null)
  return ref === null ? null : room.docTarget(refKey(ref))
}
const ringsOn = (target: string | null): Ring[] =>
  target === null ? [] : room.fieldsOn(target).map((f) => ({ card: f.card, field: f.field, name: f.name, colour: peerCss(f.connId) }))
const objectFields = createFieldPresence($<HTMLDivElement>('#inspector'), {
  report: (spot) => {
    objectSpot = spot === null ? null : { targets: objectTargets(), ...spot }
    tellField()
  },
  rings: () => ringsOn(objectTarget()),
})
const assetFields = createFieldPresence($<HTMLDivElement>('#asset-inspector'), {
  report: (spot) => {
    assetSpot = spot === null || selectedAsset === null ? null : { targets: [`asset:${selectedAsset}`], ...spot }
    tellField()
  },
  rings: () => ringsOn(selectedAsset === null ? null : `asset:${selectedAsset}`),
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

/**
 * The assistant (ADR 0192): the round button at the viewport's bottom right and its chat. What it is told the person
 * is looking at — the open game, level or prefab, the selection with each object's components, the latest problems —
 * goes with each message, from this tab or to a tab the chat moved to.
 */
const assistantContext = (): EditorContext => {
  const open = doc
  const picked =
    open === null
      ? []
      : selection.slice(0, 12).map((i) => {
          const types = open.components(i).map((c) => open.registry.get(c.type)?.label ?? c.type)
          return `${open.label(i)} (${types.length === 0 ? 'no components' : types.join(', ')})`
        })
  return {
    ...(activeMode === undefined ? {} : { game: activeMode.name }),
    ...(fileState.name === '' ? {} : { level: fileState.name }),
    ...(prefabOpen === null ? {} : { prefab: prefabOpen.name }),
    selection: picked,
    problems: notices
      .log()
      .filter((n) => n.kind !== 'ok')
      .slice(-8)
      .map((n) => n.text),
  }
}
const assistantDock = createAssistantDock(stageEl, { context: assistantContext, playing: () => play.active() })

/**
 * The viewport as a small picture (ADR 0194, Kodjo's call: small and light): at most this many pixels along its longer
 * side, a JPEG at this quality — a few hundred image tokens to a model, tens of kilobytes on the wire.
 */
const SCREENSHOT_SIDE = 512
const SCREENSHOT_QUALITY = 0.7
const shrinkToJpeg = (src: HTMLCanvasElement): Screenshot | null => {
  if (src.width === 0 || src.height === 0) return null
  const k = Math.min(1, SCREENSHOT_SIDE / Math.max(src.width, src.height))
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(src.width * k))
  out.height = Math.max(1, Math.round(src.height * k))
  const g = out.getContext('2d')
  if (g === null) return null
  g.imageSmoothingQuality = 'high'
  g.drawImage(src, 0, 0, out.width, out.height)
  const url = out.toDataURL('image/jpeg', SCREENSHOT_QUALITY)
  return { mediaType: 'image/jpeg', data: url.slice(url.indexOf(',') + 1), width: out.width, height: out.height }
}

/**
 * The editor's actions (ADR 0194) over this tab's own document, history and room: what a person does here, named, for
 * an agent to be handed. Through the same calls as the controls: the reframe the Hierarchy's drag writes, the
 * Inspector's asset refusal, the asset Inspector's edits, the Project window's placing checks.
 */
installEditorActions(
  createEditorActions(
    {
      doc: () => doc,
      rootLevel: () => rootLevel(),
      history: edits,
      repaint: (ops) => room.repaint(ops),
      heldBy: (refs) => room.heldByOthers(refs),
      assetOpenBy: (id) => room.openersOf(id)[0]?.name ?? null,
      toPlace: async (id) => {
        const library = assets
        const entry = library?.db.byId[id]
        if (library === null || entry === undefined) return { refused: `no asset ${id}` }
        if (entry.kind !== 'prefab' && entry.kind !== 'model') return { refused: `${entry.name} is a ${entry.kind}: only a prefab or a model is placed` }
        // As it is now, the way a drop from the Project window places it (ADR 0164).
        if (entry.kind === 'prefab') await library.refreshPrefab(id).catch(() => undefined)
        const why = fileOps.unplaceableWhy(id)
        if (why !== null) return { refused: `${entry.name} ${why}` }
        const { shared } = fileOps.missingIn(id)
        if (shared.length > 0 && activeMode !== undefined && prefabOpen === null) {
          return { refused: `${entry.name} uses ${shared.join(', ')}, which this game has not added: adding a shared component to a game is for a person to do` }
        }
        if (entry.kind === 'model') return { kind: 'model' }
        const root = library.prefabOf(id)
        return root === undefined ? { refused: `${entry.name} did not load` } : { kind: 'prefab', root }
      },
      reframe: (i, parent) => reframedLocal(i, parent),
      assetEntry: (id) => assets?.db.byId[id],
      usableAssets: (kind) => {
        const db = assets?.db
        if (db === undefined) return []
        const user = editingFor()
        return (kind === undefined ? db.entries : assetsOfKind(db, kind)).filter((a) => mayUse(user, a.path))
      },
      assetRefusal: (of, id, dataType) => fieldAssetRefusal(of, id, dataType),
      materialOf: (id) => assets?.materialOf(id),
      shaderParams: (shader) =>
        shaderDef(shader)?.params.map((p) => ({ key: p.key, label: p.label, kind: p.kind, ...(p.min === undefined ? {} : { min: p.min }), ...(p.max === undefined ? {} : { max: p.max }) })),
      dataOf: (id) => assets?.dataOf(id),
      dataTypeOf: (id) => {
        const entry = assets?.db.byId[id]
        const data = assets?.dataOf(id)
        return entry === undefined || data === undefined ? undefined : dataTypeAt(entry.path, data.type)
      },
      editMaterial: (id, next, label, turn) => editMaterial(id, next, label, false, turn),
      editData: (id, next, label, turn) => editData(id, next, label, false, turn),
      adoptable,
      select: (indices) => {
        follow.stop()
        if (indices.length === 0) deselect()
        else applySelection(indices)
      },
      frame: (indices) => nodes.frame(indices),
      selection: () => selection,
      where: () => ({ game: activeMode?.name ?? null, level: fileState.name === '' ? null : fileState.name, prefab: prefabOpen?.name ?? null }),
      problems: () =>
        notices
          .log()
          .filter((n) => n.kind !== 'ok')
          .slice(-20)
          .map((n) => n.text),
      screenshot: () => (play.active() ? null : view.captureFrame(shrinkToJpeg)),
    },
    EDITOR_ACTIONS,
  ),
)

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
 * Redraw what shows the editor's state, now that the status bar is gone: the top bar (undo and redo,
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
  const hint = playHint ?? followHint
  hintPill.hidden = hint === null
  hintPill.textContent = hint ?? ''
  hierarchyCount.textContent = doc === null ? '' : String(doc.count())
  assistantDock.render()
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
inspectorRefresh = () => inspector.refresh()

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
  points.frame()
  edges.frame()
})

/**
 * (Re)read the asset database, bring the runtime up to date with what changed in it, then fetch everything the
 * open document needs.
 *
 * Loading is a separate pass from drawing on purpose: `meshes.buildAll` is synchronous, so a piece is never
 * briefly a grey box that becomes a model a moment later.
 *
 * Only what changed is recompiled (ADR 0157): a material in place, a texture and the materials using it. It used
 * to throw every texture, material and model away and load them again. `named` are paths this tab just wrote
 * whose bytes cannot be compared (an upload replacing a texture); `fresh` starts the runtime over — at boot, and
 * when the change feed lost track of what happened.
 */
const reloadAssets = (opts: { named?: readonly string[]; fresh?: boolean } = {}): Promise<void> =>
  inAssetQueue(async () => {
    const before = assets
    try {
      assets = await loadAssetLibrary()
      // Each game's shared-component list, live from disk (ADR 0077). Missing file = no extras.
      for (const mode of MODE_LIST) {
        const { data, origin } = await loadGame(mode.name)
        gameData[mode.name] = data
        gameOrigins[mode.name] = origin
      }
      setProblem('')
    } catch (e) {
      // The usual cause is a dev server started before these routes existed, which answers /api/assets with
      // the index page — so say what to do rather than only what failed.
      setProblem(`assets did not load (${String(e)}) — restart pnpm dev:editor`)
      return
    }
    // This tab's live-asset edits the server has not confirmed yet go back on top of the fresh copies (ADR 0159),
    // and its edits to a game's data file (ADR 0162).
    assetSync.reloaded()
    gameSync.reloaded()
    if (opts.fresh === true || before === null || runtime === null) {
      await freshRuntime()
      return
    }
    const { ids } = libraryChanges(before, assets, opts.named ?? [])
    if (await refreshCompiled(ids)) meshes.buildAll()
    await runtime.load(doc?.assetIds() ?? [])
  })

/**
 * Bring what the runtime compiled up to date with the library installed now, for these changed assets
 * (ADR 0157): a texture fetched again and the materials using it recompiled, a material recompiled — both in
 * place, into the objects meshes hold, their fade copies following — and a model fetched again. `true` when the
 * viewport has to be rebuilt: a model changed, or a material became another class of Three material. Otherwise
 * the next frame shows it.
 */
const refreshCompiled = async (ids: readonly string[]): Promise<boolean> => {
  const r = runtime
  const lib = assets
  if (r === null || lib === null) return false
  let rebuild = false
  const recompiled = new Set<string>()
  for (const id of ids) {
    const kind = lib.db.byId[id]?.kind
    if (kind === 'texture') for (const m of await r.refreshTexture(id)) recompiled.add(m)
    else if (kind === 'model') {
      await r.refreshModel(id)
      rebuild = true
    }
  }
  for (const id of ids) {
    if (lib.db.byId[id]?.kind !== 'material' || recompiled.has(id)) continue
    if (!(await r.refreshMaterial(id))) rebuild = true
    recompiled.add(id)
  }
  for (const id of recompiled) {
    const m = r.material(id)
    if (m !== null) meshes.followMaterial(m)
  }
  return rebuild
}

/** Asset reloads, one at a time: a watch and a local edit must not install two runtimes over each other. */
let assetQueue: Promise<void> = Promise.resolve()
const inAssetQueue = (run: () => Promise<void>): Promise<void> => {
  const next = assetQueue.then(run, run)
  assetQueue = next.catch(() => undefined)
  return next
}

/**
 * The library as the runtime sees it: whichever one is installed now, read at each lookup. So an asset added,
 * renamed or moved needs no new runtime to be loadable — only one whose contents changed does, since the
 * runtime holds what it compiled (ADR 0156).
 */
const libraryView: AssetDatabase = {
  get entries() {
    return assets?.db.entries ?? []
  },
  get byId() {
    return assets?.db.byId ?? {}
  },
}

/** Throw away every loaded texture, material and model, and load again what the open document needs. */
const freshRuntime = async (): Promise<void> => {
  runtime?.dispose()
  runtime = createAssetRuntime({
    db: libraryView,
    urlOf: (path) => assets?.urlOf(path) ?? path,
    materialOf: (id) => assets?.materialOf(id),
  })
  await runtime.load(doc?.assetIds() ?? [])
}

/**
 * Other people's asset changes (`assetWatch.ts`, ADR 0156). Paths gather while one batch is being applied, so a
 * collaborator's colour drag — a save per step — costs one reload per batch rather than one per step.
 */
const waitingPaths = new Set<string>()
let applying = false
const assetsChanged = async (paths: string[]): Promise<void> => {
  for (const p of paths) waitingPaths.add(p)
  if (applying) return
  applying = true
  try {
    while (waitingPaths.size > 0) {
      const paths = [...waitingPaths]
      waitingPaths.clear()
      await inAssetQueue(() => applyAssetChanges(paths))
    }
  } finally {
    applying = false
  }
}

/** A drag or a play-test owns what a rebuild would replace: the change waits for it. */
const busyEditing = (): boolean => tool.dragging() || points.dragging() || fieldDragging || play.active()

const applyAssetChanges = async (paths: string[]): Promise<void> => {
  const before = assets
  if (before === null) return
  let next: AssetLibrary
  try {
    // A live asset's contents come as its edits do (ADR 0159), ahead of its file and with this tab's own on top:
    // the file written behind is never fetched over them. Its path on the feed still says the list may differ.
    next = await loadAssetLibrary({ reuse: before, refetch: new Set(paths.filter((p) => !isLiveAssetPath(p))) })
  } catch {
    return // the next change, or the next local reload, brings it
  }
  const { list, ids } = libraryChanges(before, next, paths)
  if (!list && ids.length === 0) return
  while (busyEditing()) await new Promise((r) => setTimeout(r, 250))
  assets = next
  assetSync.reloaded()
  // What is only new, renamed or moved, the runtime's live view already sees; contents it compiled are refreshed.
  if (await refreshCompiled(ids)) meshes.buildAll()
  previews.invalidate()
  if (selectedAsset !== null && next.db.byId[selectedAsset] === undefined) {
    selectedAsset = null
    assetInspector.show(null)
    room.syncHolds()
  } else if (selectedAsset !== null && ids.includes(selectedAsset)) assetInspector.show(selectedAsset)
  refreshUi()
}

// --- boot ---
await initPhysics()
tool.applySnap()
// Who you are, and how often to ping. A dev server answers `local`; the hosted one, whoever Access let in.
me = await fetchMe().catch((e: unknown) => {
  setProblem(`who am I? ${String(e)} — restart pnpm dev:editor`)
  return null
})
await reloadAssets()
await openFirstLevel()
// Other people's asset changes, followed from where the list was read (ADR 0156).
watchAssets({
  seq: () => assets?.seq ?? 0,
  changed: assetsChanged,
  lost: async () => {
    while (busyEditing()) await new Promise((r) => setTimeout(r, 250))
    // Whatever happened meanwhile is unknown, bytes replaced included: start the runtime over.
    await reloadAssets({ fresh: true })
    previews.invalidate()
    meshes.buildAll()
    refreshUi()
  },
})

/**
 * Keep the live connection alive — the server drops one it has not heard from, holds included — and learn of a
 * push failure.
 */
window.setInterval(() => {
  void (async () => {
    if (live()) room.ping() // the server drops a connection it has not heard from, holds included
    const status = await serverStatus().catch(() => null)
    const next = status?.pushError ?? ''
    if (next !== pushProblem) {
      pushProblem = next
      notices.setProblem('push', next === '' ? '' : `not on GitHub yet: ${next}`)
    }
  })()
}, me?.heartbeatMs ?? 30_000)

// A closing tab leaves its room at once rather than waiting out the stale window.
window.addEventListener('pagehide', () => {
  room.beaconLeave()
})

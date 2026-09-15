import {
  addCharacter,
  CHAR_HALF_HEIGHT,
  CHAR_RADIUS,
  type CharacterState,
} from '@mp/humanoid'
import { createLocalController, type LocalController, type LocalWorld } from '@mp/client'
import {
  assetsOfKind,
  instantiateLevel,
  moveTrack,
  spinTrack,
  trackDuration,
  COLLIDER,
  SPAWN,
  RENDERER,
  type ClipSource,
  type PrefabSource,
  hydratePrefabs,
  stripHydrated,
  unlinkPrefab,
  type ComponentData,
  type Keyframe,
  type LoadedLevel,
  // Aliased: this file is DOM-heavy and `Node` is taken. A scene node is not a DOM node, and the day the two
  // are confused the error is a type error somewhere unrelated.
  type Level,
  type Pose,
  type Transform, validateLevel, applyBatch, refKey, OpError, type NodeRef, type Op,
  BUILTIN_LABELS, BUILTIN_MODELS, isBuiltinModel, scaleCollider, PRIMITIVE_LABELS, PRIMITIVE_ORDER, type PrimitiveKind, type EnvironmentConfig } from '@mp/content'
import { QUANT_BOUND } from '@mp/net'

import { createViewGizmo } from './viewGizmo'
import { DEFAULT_REGISTRY, characterAccess, createComponentRuntime, createRegistry, isSharedComponent, SHARED_COMPONENT_TYPES, sharedComponents, type ComponentRuntime, type Registry } from '@mp/components'
import { createOrbitCamera } from '@mp/camera'
import { PLAYER_NODE_ID, actionsHeld, type ModeDescriptor, readSettings } from '@mp/mode'
import { createSimClock, eulerToQuat, quat, startFixedLoop, TICK_DT, TICK_RATE_HZ, vec3, type EntityId, type LoopHandle, type Vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics, type PhysicsWorld } from '@mp/physics'
import {
  addLevel,
  addLights,
  applyGreyboxEnvironment,
  colorForMarker,
  createLight,
  createPostFX,
  createGreyboxMaterial,
  createThreeStage,
  geometryForBuiltin,
  geometryForCollider,
  lightAims,
  OrbitControls,
  createAssetRuntime,
  THREE,
  TransformControls,
  type AssetRuntime,
  type ContentLights,
  type LevelView,
  type LightDesc,
} from '@mp/render-three'
import { createCollab, httpTransport, parsePresence, type Hold, type Peer } from './collab'
import { componentTypesInRaw, levelDoc, prefabDoc, unknownComponentTypes, type ClipItem, type Doc, type KeyEditor, type Mode, type OpBatch } from './editorDoc'
import { createContextMenu, type ContextMenu, type MenuItem } from './menu'
import { askDestructive, askName, askUnsaved } from './confirm'
import { prefabFolder, prefabTarget, sanitisePrefabName } from './prefabPath'
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
import { createOpHistory, foldBatches } from './opHistory'
import { createInspector, type Inspector } from './inspector'
import { createAssetInspector, type AssetInspector } from './assetInspector'
import { loadAssetLibrary, type AssetLibrary } from './assetsApi'
import { canMoveFolder, movedInto, renamedTo } from './assetTree'
import { createPreviews, type Previews } from './previews'
import { createProjectPanel, type Project } from './projectPanel'
import { applySelect, clampTo, modeFor, primaryOf, rootsOf, type SelectMode } from './selection'
import { createShortcuts } from './shortcuts'
import { createSplitter, readPx, writePx } from './splitter'
import { MODES, MODE_LIST, modeOf, soleMode } from './modes'
import { createTimeline, type Timeline } from './timeline'
import { DIRS, pathPoints, putChannel, restKeys, setKeyPose, sortedKeys } from './trackEdit'
import { createToolbar, type GizmoMode, type GizmoSpace, type Toolbar } from './toolbar'

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!
const canvas = $<HTMLCanvasElement>('#view')

// --- scene + polished pipeline (same renderer the game/viewer use) ---
const stage = createThreeStage({ canvas, cameraPosition: [12, 10, 16], lookAt: [0, 1, 0] })
// Same sky and same sun the game runs, so what is authored here is lit the way it ships (ADR 0046).
// Same defaults as the game, on purpose: this pinned `shadowRadius: 40` and `bloomStrength: 0.3` against the
// game's 30 and 0.1, so the editor did not show what you would play. Post-FX now follows the open document.
const env = applyGreyboxEnvironment(stage.renderer, stage.scene, { sunIntensity: 2.4 })
const postfx = createPostFX(stage.renderer, stage.scene, stage.camera)

const controls = new OrbitControls(stage.camera, canvas)
controls.enableDamping = true
controls.target.set(0, 1, 0)

const grid = new THREE.GridHelper(80, 80, 0x475569, 0x1f2937)
;(grid.material as THREE.Material).transparent = true
;(grid.material as THREE.Material).opacity = 0.5
const axes = new THREE.AxesHelper(3)

/**
 * The network bounds, drawn (ADR 0093): the cube a peer's position is quantized over, centred on the origin.
 *
 * Off unless asked for. A level is almost always well inside it, so left on it would be a red box around
 * everything forever; the reason to draw it at all is the half-hour when someone is deciding how big it
 * should be, or checking that a level which grew still fits.
 */
const boundsBox = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(0xef4444))
boundsBox.visible = false
let showBoundsBox = false

stage.scene.add(grid, axes, boundsBox)

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
  setStatus(`added ${fresh.join(', ')} to ${mode.label}`)
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
  collab.leave()
  holdMap = new Map()
  lastHoldKey = null
  heldBack = []
  if (presenceTimer !== null) {
    clearInterval(presenceTimer)
    presenceTimer = null
  }
  await Promise.all(paths.map((p) => releaseLock(p).catch(() => undefined)))
}

// ============================== live levels (ADR 0089) ==============================
/** Who else has this level open, for the status bar. */
let livePeers: Peer[] = []
/** The prefab this tab is editing in its own room, and the level to go back to. `null` in a level. */
let prefabOpen: { assetId: string; name: string; from: string } | null = null
/** The level the last snapshot carried, for `openFile` to build its document over. */
let latestSnapshot: Level | null = null
/** True while `openFile` awaits its first snapshot; a later one (reconnect) reinstalls the document itself. */
let joining = false
/** Remote ops that landed mid-drag: applied to the data already, repainted when the drag ends. */
let deferredRemote: Op[] = []
/** Is the open document a level in a live session? Prefabs and materials are files with locks, as before. */
/** Is the open document a live room? Both kinds are now (ADR 0091); a material is still a file with a lock. */
const live = (): boolean => collab.name() !== null

const TRANSFORM_KINDS = new Set<string>(['setTransform', 'setOverrideTransform'])

// ------------------------------ holds (phase 3) ------------------------------
/** Every hold in the room by `refKey`, theirs and mine. */
let holdMap = new Map<string, Hold>()
/** The selection the server was last told to hold, as a key, so an unchanged selection sends nothing. */
let lastHoldKey: string | null = null

/** The name of another connection holding node `index` or any node above it; `null` when it is free. */
const heldBy = (index: number): string | null => {
  const open = doc
  if (open === null || holdMap.size === 0) return null
  const mine = collab.connId()
  for (let i: number | null = index; i !== null; i = open.parentOf(i)) {
    const ref = open.refAt(i)
    if (ref === null) continue
    const h = holdMap.get(refKey(ref))
    if (h !== undefined && h.connId !== mine) return h.name
  }
  return null
}

/**
 * Tell the room what I hold: the selection, whole, every time it changes. The server refuses a ref someone
 * else has (a race the local filter lost): the refused nodes drop out of the selection.
 */
const syncHolds = (): void => {
  if (!live()) return
  const refs = selectionRefs()
  const key = refs.map(refKey).sort().join('|')
  if (key === lastHoldKey) return
  lastHoldKey = key
  void collab.setHolds(refs).then((r) => {
    if (r.ok) return
    setStatus(`${r.holder} has that selected`)
    const refused = new Set(r.refused.map(refKey))
    const open = doc
    if (open === null) return
    applySelection(selection.filter((i) => {
      const ref = open.refAt(i)
      return ref === null || !refused.has(refKey(ref))
    }))
  })
}

/** Tinted boxes over nodes others hold, in world space and refreshed each frame so a drag keeps up. */
const holdRoot = new THREE.Group()
stage.scene.add(holdRoot)
const holdHelpers = new Map<number, THREE.BoxHelper>()
const holdColour = (connId: string): number => {
  let h = 0
  for (let i = 0; i < connId.length; i++) h = (h * 31 + connId.charCodeAt(i)) >>> 0
  return new THREE.Color().setHSL((h % 360) / 360, 0.75, 0.6).getHex()
}
/**
 * Rebuild every collaborator's hold box.
 *
 * Called from `buildItems` as well as on a holds event, and that is the load-bearing part: a `BoxHelper` wraps
 * the object it was built around, so a rebuild leaves every one of them wrapping a group that is no longer in
 * the scene and whose meshes have been disposed. It draws a stale box rather than throwing, which is why this
 * outlived the same bug in the gizmo (see `reattachGizmo`).
 */
const rebuildHoldHelpers = (): void => {
  for (const helper of holdHelpers.values()) {
    holdRoot.remove(helper)
    helper.dispose()
  }
  holdHelpers.clear()
  const open = doc
  if (open === null || !live()) return
  const mine = collab.connId()
  for (const h of holdMap.values()) {
    if (h.connId === mine) continue
    const i = open.indexOfRef(h.ref)
    if (i === null) continue
    // A hold covers the node and everything under it, so every node of the subtree gets its own box: a group
    // with no meshes of its own would otherwise show nothing at all. Depth-first order makes the subtree the
    // run of deeper indices right after the node.
    const depth = open.depthOf(i)
    for (let j = i; j < open.count() && (j === i || open.depthOf(j) > depth); j++) {
      const g = instanceGroups[j]
      if (g === undefined || holdHelpers.has(j) || meshHolderOf(g).children.length === 0) continue
      const helper = new THREE.BoxHelper(meshHolderOf(g), holdColour(h.connId))
      ;(helper.material as THREE.LineBasicMaterial).depthTest = false
      helper.renderOrder = 1
      holdRoot.add(helper)
      holdHelpers.set(j, helper)
    }
  }
}
const updateHoldHelpers = (): void => {
  for (const helper of holdHelpers.values()) helper.update()
}

/** The room's holds changed: drop what I can no longer have, redraw the badges and the boxes. */
const onHoldsChanged = (holds: Hold[]): void => {
  holdMap = new Map(holds.map((h) => [refKey(h.ref), h]))
  if (selection.some((i) => heldBy(i) !== null)) applySelection(selection.filter((i) => heldBy(i) === null))
  rebuildHoldHelpers()
  hierarchy.render()
}

/**
 * Redraw after ops changed the level from outside the document — a remote batch, an undo. Transforms alone
 * move groups; anything else rebuilds from data, as every structural edit does, and puts the selection back
 * by identity. Mid-drag, the redraw waits: the gizmo owns the groups until the pointer comes up.
 */
const repaintAfterOps = (ops: readonly Op[]): void => {
  if (gizmoDragging) {
    deferredRemote.push(...ops)
    return
  }
  const open = doc
  if (open === null) return
  if (ops.every((o) => TRANSFORM_KINDS.has(o.kind))) {
    applyPreviewPoses()
    // A remote scale change: the meshes are built from the scale (ADR 0090), so the touched subtrees redraw.
    for (const o of ops) {
      const ref: NodeRef | null = o.kind === 'setTransform' ? (o.table !== undefined ? { table: o.table, id: o.id } : { id: o.id }) : o.kind === 'setOverrideTransform' ? { owner: o.owner, node: o.node } : null
      const i = ref === null ? null : open.indexOfRef(ref)
      if (i !== null) rebuildSubtreeMeshes(i)
    }
    scheduleRebuild()
    inspectorSync()
    updateTrackHelper()
    return
  }
  const keep = selectionRefs()
  deselect()
  installEnvironment(open.environment())
  buildItems()
  rebuildLoaded()
  const restored = keep.map((r) => open.indexOfRef(r)).filter((i): i is number => i !== null)
  if (restored.length > 0) applySelection(restored)
  refreshUi()
  inspectorRebuild()
  loadNewReferences(buildItems)
}

/**
 * A fresh copy of the **level** arrived (a reconnect): rebuild the document over it, keeping the history.
 *
 * Refused while a prefab room is open: that stream's snapshots are a prefab wrapper, and building a level
 * document over one would put a prefab's root in the level's place.
 */
const reinstallLevel = (level: Level): void => {
  const root = docStack[0]
  if (root === undefined || prefabOpen !== null) return
  try {
    validateLevel(level, registry())
  } catch (e) {
    setProblem(`the server's copy does not load: ${String(e)}`)
    return
  }
  docStack.length = 1
  docStack[0] = { doc: withOps(levelDoc(level, registry(), editorClips)), label: root.label }
  showDoc()
  lastHoldKey = null // a reconnect is a new connection: the server holds nothing for it yet
  syncHolds()
}

// ------------------------------ presence (phase 4) ------------------------------
/** ~10 Hz: what a pointer drag looks like from across the room without a POST per pointer event. */
const PRESENCE_MS = 100
let presenceTimer: ReturnType<typeof setInterval> | null = null
/** Batches the document reported during a gizmo drag: held back and sent as one op at drag end. */
let heldBack: OpBatch[] = []

/** The poses of what I am dragging, off the groups: what the gizmo has set, whatever the document will store. */
const dragPoses = (): { ref: NodeRef; position: Vec3; rotation: Vec3; scale: Vec3 }[] => {
  const open = doc
  if (open === null) return []
  const out: { ref: NodeRef; position: Vec3; rotation: Vec3; scale: Vec3 }[] = []
  for (const i of selection) {
    const g = instanceGroups[i]
    const ref = open.refAt(i)
    if (g === undefined || ref === null) continue
    const pose = groupPose(g)
    out.push({ ref, position: pose.position, rotation: pose.rotation, scale: vec3(g.scale.x, g.scale.y, g.scale.z) })
  }
  return out
}
const startPresence = (): void => {
  if (!live() || presenceTimer !== null) return
  presenceTimer = setInterval(() => collab.presence({ kind: 'pose', poses: dragPoses() }), PRESENCE_MS)
}
const stopPresence = (): void => {
  if (presenceTimer === null) return
  clearInterval(presenceTimer)
  presenceTimer = null
  collab.presence({ kind: 'pose', poses: [], end: true })
}

/** A peer's drag: pose their groups where they are, write nothing. `end` puts every group back on its data. */
const onPresence = (data: unknown): void => {
  const p = parsePresence(data)
  const open = doc
  if (p === null || open === null) return
  if (p.end === true) {
    // Not while my own gizmo owns the groups: my drag end repaints, and the deferred remote ops with it.
    if (!gizmoDragging) applyPreviewPoses()
    return
  }
  for (const pose of p.poses) {
    const i = open.indexOfRef(pose.ref)
    const g = i === null ? undefined : instanceGroups[i]
    if (i === null || g === undefined || (gizmoDragging && selection.includes(i))) continue
    g.position.set(pose.position.x, pose.position.y, pose.position.z)
    const q = eulerToQuat(pose.rotation)
    g.quaternion.set(q.x, q.y, q.z, q.w)
    g.scale.set(pose.scale.x, pose.scale.y, pose.scale.z)
  }
}

/**
 * A prefab the open level uses was edited in its own document (ADR 0091). Its ops are written against that
 * prefab's wrapper, whose one root **is** the definition this level resolved, so wrapping and applying them
 * writes through to every placement at once. Nothing is sent back: this level's own sequence did not move.
 */
const onPrefabOps = (assetId: string, ops: Op[]): void => {
  const level = rootLevel()
  const root = level?.prefabs?.[assetId]
  if (level === undefined || level === null || root === undefined) return
  try {
    applyBatch({ id: assetId, config: {}, nodes: [root] }, ops)
  } catch (e) {
    // The definition here is behind the server's; the next open will take a fresh copy.
    setStatus(`a prefab changed in a way this level could not follow: ${e instanceof OpError ? e.message : String(e)}`)
    return
  }
  // Every placement of it changed shape, so this is the structural repaint, not the cheap one.
  const open = doc
  if (open === null) return
  const keep = selectionRefs()
  deselect()
  buildItems()
  rebuildLoaded()
  const restored = keep.map((r) => open.indexOfRef(r)).filter((i): i is number => i !== null)
  if (restored.length > 0) applySelection(restored)
  refreshUi()
  inspectorRebuild()
  previews.invalidate()
  loadNewReferences(buildItems)
}

const collab = createCollab(httpTransport(), {
  level: () => (fileState.mode === 'level' ? rootLevel() : null),
  onSnapshot: (level) => {
    latestSnapshot = level
    if (!joining) reinstallLevel(level)
  },
  onApplied: (ops) => repaintAfterOps(ops),
  onRejected: (batch, reason) => {
    // The batch is already rolled back in the data; forget the history entry that holds it, then redraw.
    history.dropWhere((entry) => entry.ops.some((o) => batch.ops.includes(o)) || entry.inverses.some((o) => batch.ops.includes(o)))
    setStatus(`edit refused: ${reason}`)
    repaintAfterOps(batch.inverses)
  },
  onPeers: (peers) => {
    livePeers = peers
    renderStatus()
  },
  onHolds: (holds) => onHoldsChanged(holds),
  onPresence: (_from, _name, data) => onPresence(data),
  onPrefabOps: (assetId, ops) => onPrefabOps(assetId, ops),
  onError: (message) => setStatus(`live: ${message}`),
})

/** The key the open file is locked by. Levels and prefabs are live rooms; this is for the rest. */
const docLockKey = (): string => lockKey.level(fileState.name)

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
  setStatus(`${entry.name} is read-only: locked by ${owner}`)
  return false
}

/**
 * Animation clips, for every document this editor opens (ADR 0050).
 *
 * A stable object that reads `assets` on each call rather than the library itself, so it can be handed to a
 * document without caring whether the library has finished loading — and so a clip created mid-session
 * resolves without rebuilding the document.
 */
const editorClips: ClipSource = { keys: (assetId) => assets?.keys(assetId) }
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
  // Spawn is the engine's: every game starts a player somewhere, and `Spawn` is an engine component.
  for (const m of loaded.markers) if (m.kind === 'spawn') markerGroup.add(markerGizmo(m.position, colorForMarker('spawn')))
  /**
   * A gizmo per gameplay rule, on the node that owns the collider you would touch — coloured by **the game's**
   * table (ADR 0052), so a new game's rules get markers without touching this file.
   *
   * This was `RULE_KINDS` from `@mp/components`, which covered exactly parkour's four because they were the
   * only rules that existed. The editor no longer names a rule anywhere.
   */
  const gizmos = activeMode?.gizmos
  if (gizmos !== undefined)
    for (const n of loaded.nodes)
      for (const c of n.components) {
        const color = gizmos[c.type]
        if (color !== undefined) markerGroup.add(markerGizmo(n.position, color))
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

/**
 * Shadow cap for the authored viewport (ADR 0047). Three renders forward, so each caster is an extra scene
 * render per frame and a point light is six of them. Reset per rebuild, and counted in document order so the
 * same lights win each time rather than flickering between rebuilds.
 */
const EDITOR_SHADOW_CAP = 4
let editorShadowCasters = 0

/**
 * A pickable wireframe for a light. Chrome, not content: it never casts, never writes depth, and is not
 * tone-mapped, so it reads the same against a bright sky as a dark one.
 *
 * Shape says the kind at a glance — a sphere for the omnidirectional ones, a cone down -Z for a spot, a
 * line down -Z for a directional. Tinted with the light's own colour so a wall of them is still legible.
 */
const lightGizmo = (light: LightDesc): THREE.Object3D => {
  const color = new THREE.Color().setStyle(light.color, THREE.SRGBColorSpace)
  const material = new THREE.MeshBasicMaterial({ color, wireframe: true, depthWrite: false, toneMapped: false })
  const group = new THREE.Group()
  if (light.kind === 'spot') {
    const h = 1.2
    const r = Math.tan(THREE.MathUtils.degToRad(light.angleDeg)) * h
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r, h, 12, 1, true), material)
    // ConeGeometry points up +Y with its apex at the top; put the apex on the node and lay it down -Z.
    cone.rotation.x = -Math.PI / 2
    cone.position.z = -h / 2
    group.add(cone)
  } else {
    group.add(new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 6), material))
  }
  if (light.kind === 'directional') {
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1.6)]), new THREE.LineBasicMaterial({ color, toneMapped: false })))
  }
  return group
}

const buildItemMeshes = (g: THREE.Group, i: number): void => {
  if (doc === null) return
  const holder = meshHolderOf(g)
  /**
   * Drawn at final size (ADR 0090). The group carries the node's scale for its children and the gizmo; the
   * holder undoes it, and every shape here is built from the *world* dimensions — as the game builds them
   * from the baked collider. So a rounded edge is computed on the real size instead of being stretched with
   * the scale, and a built-in shape is the unit shape times the scale. A model file gets the scale back.
   */
  g.updateWorldMatrix(true, false)
  const ws = g.getWorldScale(new THREE.Vector3())
  const inv = (v: number): number => (Math.abs(v) < 1e-6 ? 1 : 1 / v)
  holder.scale.set(inv(ws.x), inv(ws.y), inv(ws.z))
  const worldScale = vec3(ws.x, ws.y, ws.z)
  for (const spec of doc.meshSpecs(i)) {
    // The same precedence the game's level view uses, so the editor is never showing a different scene:
    // a model replaces the greybox shape, a material replaces the greybox style, and either falling
    // through leaves the piece as its collider, greyboxed when no material is assigned.
    const builtin = isBuiltinModel(spec.model) ? spec.model : null
    const model = spec.model !== undefined && builtin === null ? (runtime?.model(spec.model) ?? null) : null
    const material = spec.material !== undefined ? (runtime?.material(spec.material) ?? null) : null
    let object: THREE.Object3D
    if (model !== null) {
      if (material !== null) model.traverse((o) => void (o instanceof THREE.Mesh && (o.material = material)))
      object = model
    } else {
      const geometry = builtin !== null ? geometryForBuiltin(builtin, worldScale) : geometryForCollider(scaleCollider(spec.collider, worldScale))
      object = new THREE.Mesh(geometry, material ?? createGreyboxMaterial())
    }
    const p = spec.transform.position
    applyTransform(object, vec3(p.x * ws.x, p.y * ws.y, p.z * ws.z), spec.transform.rotation, spec.transform.scale)
    if (model !== null) object.scale.multiply(ws)
    object.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true
        o.receiveShadow = true
      }
    })
    holder.add(object)
  }

  /**
   * The node's light, if it has one (ADR 0047). Two objects, both parented into the node's own group so its
   * transform places and aims them with no extra bookkeeping:
   *
   * - the real `THREE.Light`, so the viewport shows what the level will actually look like
   * - a wireframe **gizmo**, because a light node has no `Renderer` and no `Collider`, so without one there is
   *   nothing under the cursor to click. It sits inside the group that carries `userData.index`, so the
   *   existing pick walk finds it for free.
   */
  const light = doc.lightSpec(i)
  if (light !== undefined) {
    const casts = light.castShadow && light.kind !== 'ambient' && editorShadowCasters < EDITOR_SHADOW_CAP
    if (casts) editorShadowCasters += 1
    const object = createLight(light, casts)
    holder.add(object)
    if (lightAims(light.kind)) {
      // Aimed down the group's -Z, which is the node's forward. Three needs the target in the graph.
      const target = new THREE.Object3D()
      target.position.set(0, 0, -1)
      holder.add(target)
      ;(object as THREE.SpotLight | THREE.DirectionalLight).target = target
    }
    holder.add(lightGizmo(light))
  }
}

const buildItems = (): void => {
  disposeMeshes(instanceRoot)
  instanceGroups = []
  // Counted fresh each rebuild, in document order, so the same lights keep their shadows instead of the cap
  // handing them to whichever node happened to rebuild first.
  editorShadowCasters = 0
  if (doc === null) {
    reattachGizmo()
    rebuildHoldHelpers()
    refreshBoundsBox()
    return
  }
  // Depth-first order, so a parent's group always exists before its children ask for it.
  for (let i = 0; i < doc.count(); i++) {
    const g = new THREE.Group()
    const t = doc.transformOf(i)
    applyTransform(g, t.position, t.rotation, t.scale)
    g.userData.index = i
    const holder = new THREE.Group()
    g.userData.meshes = holder
    g.add(holder)
    /**
     * A switched-off node draws nothing (ADR 0099) — Kodjo's call, the same as Unity's scene view.
     *
     * **No meshes rather than an invisible group.** Three does not skip invisible objects when raycasting
     * (`Raycaster.js`), so `visible = false` would leave it clickable in the viewport: you would select
     * something you cannot see. Building nothing is also what the loader does, so the two agree.
     *
     * The group itself still exists, so document indices, the Hierarchy's selection and the gizmo all keep
     * working — you can still move a disabled object, you just cannot see it.
     */
    if (doc.nodeEnabled(i) && !doc.disabledByAncestor(i)) buildItemMeshes(g, i)
    const parent = doc.parentOf(i)
    ;(parent === null ? instanceRoot : (instanceGroups[parent] ?? instanceRoot)).add(g)
    instanceGroups[i] = g
  }
  // Authored transforms are only where *static* items sit. An animated one belongs at its track's pose for
  // the current playhead — which at 0 is where the game starts it, so the two now agree (ADR 0029).
  applyPreviewPoses()
  reattachGizmo()
  rebuildHoldHelpers()
  refreshBoundsBox()
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
 * Meshes are built from the world scale (ADR 0090), so a scale change on a node redraws it and everything
 * under it. Depth-first order makes the subtree the run of deeper indices right after the node.
 */
const rebuildSubtreeMeshes = (i: number): void => {
  const open = doc
  if (open === null) return
  const depth = open.depthOf(i)
  for (let j = i; j < open.count() && (j === i || open.depthOf(j) > depth); j++) rebuildItemMeshes(j)
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
  const points = pathPoints(keys, doc.transformOf(selected).position)
  if (points.length === 0) return // a spin-only track has no path to draw

  // Key offsets land on the item's authored position, giving *local* poses, which are then placed by the
  // item's parent — which for a nested item is another animated group, and that is exactly right: the path
  // is drawn where the motion happens.
  const parent = g.parent ?? instanceRoot
  parent.updateWorldMatrix(true, false)
  const world = points.map((p) => parent.localToWorld(new THREE.Vector3(p.position.x, p.position.y, p.position.z)))

  if (world.length > 1) trackHelper.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(world), pathLineMat))

  const chosen = new Set(keySelection)
  world.forEach((at, n) => {
    const row = points[n]
    if (row === undefined) return
    const dot = new THREE.Mesh(keyDotGeo, chosen.has(row.index) ? keyDotActiveMat : keyDotMat)
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
    loaded = instantiateLevel(world, doc.asLevel(), registry(), editorClips)
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
  envSelected = false
  gameSelected = false
  doc = docStack[docStack.length - 1]?.doc ?? null
  // The level owns its sun (ADR 0048), so opening one relights the viewport and rebakes the sky. A prefab has
  // none, which `sun()` reports as `undefined`, and that falls back to the renderer's defaults.
  installEnvironment(doc?.environment())
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
  docStack[0] = { doc: withOps(levelDoc(root.doc.asLevel(), registry(), editorClips)), label: root.label }
  showDoc()
}

const setDoc = (next: Doc, name: string): void => {
  docStack.length = 0
  docStack.push({ doc: next, label: `${next.mode}: ${name}` })
  fileState.name = name
  showDoc()
  // Another file's edits are not this one's, and its snapshots would restore the wrong document entirely.
  resetHistory()
}

/**
 * Edit the prefab behind a placement — in **its own live room** (ADR 0091), not as a lens over this level's
 * copy, because there is no copy any more. Its edits are ops on that document, everyone in it sees them, and
 * every open level following it repaints. There is no Save.
 *
 * The level's session is left, so this tab is in one document at a time: the viewport, the physics world, the
 * selection and the holds are all singletons keyed to the open document, and two joined rooms would be two
 * streams repainting one screen. Back rejoins the level, and the server greets that with a fresh snapshot, so
 * what everyone else did while you were away is there when you return.
 */
const enterPrefab = async (assetId: string): Promise<void> => {
  const entry = assets?.db.byId[assetId]
  if (entry === undefined) {
    setStatus('that prefab is not in the project')
    return
  }
  const from = fileState.name
  collab.leave()
  joining = true
  try {
    await collab.join(assetId, 'prefab')
  } catch (e) {
    joining = false
    setStatus(`could not open ${entry.name}: ${e instanceof Error ? e.message : String(e)}`)
    void rejoinLevel(from)
    return
  }
  joining = false
  const root = latestSnapshot?.nodes[0]
  if (root === undefined) {
    setStatus('that prefab did not load')
    void rejoinLevel(from)
    return
  }
  prefabOpen = { assetId, name: entry.name, from }
  docStack.length = 0
  docStack.push({ doc: withOps(prefabDoc(root, registry(), editorClips)), label: `prefab: ${entry.name}` })
  showDoc()
  resetHistory()
  refreshUi()
}

const openPrefabOf = (index: number): void => {
  const id = doc?.refOf(index)
  if (id === null || id === undefined) return
  void enterPrefab(id)
}

/** Leave the prefab and rejoin the level it was opened from, which arrives as a fresh snapshot. */
const closePrefab = (): void => {
  const open = prefabOpen
  if (open === null) return
  prefabOpen = null
  collab.leave()
  void rejoinLevel(open.from)
}

/** Reopen a level by name, as `openFile` does — used on the way back out of a prefab. */
const rejoinLevel = async (name: string): Promise<void> => {
  prefabOpen = null
  fileState.mode = 'level'
  await openFile(name)
}

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
 * The isometric camera (ADR 0094). `stage.camera` stays the perspective one and stays the game's — play mode
 * hands it to `createOrbitCamera`, which tunes its `fov` — so this is a second camera the editor swaps in,
 * not a change to the stage.
 *
 * "Isometric" is Unity's word for it and the one on the label; it is an orthographic projection, not the
 * 30-degree angle the word means in drawing.
 */
const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000)
let isometric = false

/** The camera actually being looked through. Everything that casts a ray or draws must ask for it. */
const activeCamera = (): THREE.PerspectiveCamera | THREE.OrthographicCamera => (isometric ? orthoCamera : stage.camera)

/** Half the world height the orthographic camera shows, chosen to match what perspective shows at the target. */
const orthoHalfHeight = (): number => {
  const distance = Math.max(0.001, stage.camera.position.distanceTo(controls.target))
  return distance * Math.tan((stage.camera.fov * Math.PI) / 360)
}

/** Re-cut the orthographic frustum for the canvas's aspect, keeping the height it is already showing. */
const syncOrthoFrustum = (halfHeight: number): void => {
  const aspect = Math.max(0.001, canvas.clientWidth / Math.max(1, canvas.clientHeight))
  orthoCamera.top = halfHeight
  orthoCamera.bottom = -halfHeight
  orthoCamera.left = -halfHeight * aspect
  orthoCamera.right = halfHeight * aspect
  orthoCamera.updateProjectionMatrix()
}

/**
 * Swap projection, keeping the view.
 *
 * The outgoing camera's placement carries over, and the frustum is cut so the two show the same thing at the
 * orbit target — so the toggle reads as the perspective draining out of the picture rather than as a jump.
 * Going back, the distance is recovered from the frustum, since orthographic has no distance of its own.
 *
 * Everything holding a camera is re-pointed rather than rebuilt: the post-FX passes took theirs at
 * construction, and rebuilding the composer would throw away the AO and bloom the level asked for.
 */
const setProjection = (ortho: boolean): void => {
  if (ortho === isometric) return
  if (ortho) {
    const half = orthoHalfHeight()
    orthoCamera.position.copy(stage.camera.position)
    orthoCamera.quaternion.copy(stage.camera.quaternion)
    orthoCamera.zoom = 1
    syncOrthoFrustum(half)
  } else {
    // Orthographic distance is meaningless, so put the perspective camera where it shows the same height.
    const half = (orthoCamera.top - orthoCamera.bottom) / 2 / orthoCamera.zoom
    const distance = half / Math.tan((stage.camera.fov * Math.PI) / 360)
    const back = orthoCamera.position.clone().sub(controls.target)
    if (back.lengthSq() < 1e-6) back.set(0, 1, 1)
    stage.camera.quaternion.copy(orthoCamera.quaternion)
    stage.camera.position.copy(controls.target).add(back.normalize().multiplyScalar(distance))
  }
  isometric = ortho
  applyProjectionBackground()
  const camera = activeCamera()
  postfx.setCamera(camera)
  controls.object = camera
  gizmo.camera = camera
  controls.update()
  viewGizmo.setLabel(ortho ? 'Iso' : 'Persp')
  setStatus(ortho ? 'isometric' : 'perspective')
  uiChanged()
}

/**
 * The navigation gizmo, top right (ADR 0094). Blender's ball-and-stick, Unity's click-the-middle to toggle
 * isometric, and no auto-switch: looking down an axis and dropping perspective are two decisions.
 */
const viewGizmo = createViewGizmo({
  camera: activeCamera,
  target: () => controls.target,
  dom: canvas,
})

/**
 * Drawn after post-processing, because it clears depth and paints over the finished image — composite
 * anything afterwards and it would be covered. Hidden during play, where the viewport is the game's.
 */
stage.setRenderStep(() => {
  postfx.render()
  if (!playing) viewGizmo.render(stage.renderer)
})

/**
 * The gizmo gets the pointer before anything else does.
 *
 * On the document in the **capture** phase rather than on the canvas: `OrbitControls` and the rest listen on
 * the canvas itself, and listeners on one element fire in the order they were added, so there is no way to
 * get in front of them from there. Capturing on an ancestor is, and `stopPropagation` then means the event
 * never reaches the canvas at all — no orbit, no selection click, no context menu.
 */
let viewGizmoHolding = false
document.addEventListener(
  'pointerdown',
  (e) => {
    if (e.target !== canvas || playing || e.button !== 0) return
    if (!viewGizmo.pointerDown(e)) return
    viewGizmoHolding = true
    e.stopPropagation()
    e.preventDefault()
  },
  true,
)
document.addEventListener(
  'pointermove',
  (e) => {
    if (!viewGizmoHolding) return
    viewGizmo.pointerMove(e)
    e.stopPropagation()
  },
  true,
)
document.addEventListener(
  'pointerup',
  (e) => {
    if (!viewGizmoHolding) return
    viewGizmoHolding = false
    if (viewGizmo.pointerUp(e) === 'centre') setProjection(!isometric)
    e.stopPropagation()
  },
  true,
)

const gizmo = new TransformControls(stage.camera, canvas)
const applySnap = (): void => {
  gizmo.setTranslationSnap(edit.snap ? edit.step : null)
  gizmo.setRotationSnap(edit.snap ? THREE.MathUtils.degToRad(15) : null)
  gizmo.setScaleSnap(edit.snap ? 0.1 : null)
}
stage.scene.add(gizmo.getHelper())

/**
 * Point the gizmo at the primary's group, or at nothing.
 *
 * `buildItems` replaces every group, so anything holding one is stale the moment it returns — and a gizmo
 * holding a group that is no longer in the scene throws on the next click ("the attached 3D object must be a
 * part of the scene graph", then a null `updateMatrixWorld` in `pointerDown`). Called at both of `buildItems`'
 * exits, so the invariant holds however it was reached: a redraw after an async asset load
 * (`loadNewReferences`) never went through a selection change, which is how the stale attachment survived.
 */
const reattachGizmo = (): void => {
  const g = selected === null || playing ? undefined : instanceGroups[selected]
  if (g === undefined) gizmo.detach()
  else gizmo.attach(g)
}

/**
 * A flat stand-in for the sky while the camera is orthographic.
 *
 * Three draws a cubemap background as a **1 x 1 x 1 box parked at the camera**, inside-out, depth test off
 * (`WebGLBackground`). A perspective divide is what makes that fill the screen: a corner half a metre away at
 * 45 degrees lands at the edge. Orthographic has no divide, so half a metre stays half a metre and the box
 * projects to a few percent of a viewport metres across — a small patch of sky in the middle of the clear
 * colour, which is what "the skybox goes black in isometric" actually is.
 *
 * So isometric gets a flat colour instead, mixed from the level's own sky so it is not jarring. Not tone
 * mapped, because a `Color` background is a clear colour rather than a drawn surface, so the sky's `gain` is
 * deliberately left out of it.
 *
 * The alternative is drawing the sky ourselves — a mesh, or a full-screen quad reconstructing the view ray —
 * which is correct in both projections and costs a draw every frame in the game as well. Deferred to the
 * render pass (`budgets.md`) rather than taken now.
 */
const isoBackground = new THREE.Color()
/** Whatever the sky put there, so leaving isometric restores exactly that. `undefined` = nothing captured. */
let backgroundBeforeIso: THREE.Scene['background'] | undefined

/**
 * Install a level's environment, and then make the background match the projection.
 *
 * One function rather than the four pairs of calls this replaces, for the reason `buildItems` keeps its own
 * invariants: every path that installs a sky has to re-apply this, and a path that forgets is a black
 * viewport that only shows up in isometric.
 */
const installEnvironment = (from: Partial<EnvironmentConfig> | undefined): void => {
  env.applyEnvironment(from)
  postfx.apply(from?.postfx)
  applyProjectionBackground()
}

/** Swap the cubemap background for a flat colour while isometric, and put it back afterwards. */
const applyProjectionBackground = (): void => {
  if (isometric) {
    // Anything but our own colour is the sky the environment just installed: remember it before replacing it.
    if (stage.scene.background !== isoBackground) backgroundBeforeIso = stage.scene.background
    const sky = env.skyParams
    isoBackground.set(sky.bottomColor).lerp(new THREE.Color(sky.topColor), 0.5)
    stage.scene.background = isoBackground
    return
  }
  if (backgroundBeforeIso !== undefined) {
    stage.scene.background = backgroundBeforeIso
    backgroundBeforeIso = undefined
  }
}

/** The bound in force for the open document: the level's own, or the platform default. */
const effectiveBounds = (): number => doc?.netBounds() ?? QUANT_BOUND

/**
 * Re-size the box and decide whether it is drawn.
 *
 * Hidden inside a prefab as well as when switched off: a prefab has no bounds of its own (it is placed into
 * a level, and the level's box is the one that matters), so drawing the default around it would be a lie.
 */
const refreshBoundsBox = (): void => {
  const b = effectiveBounds()
  boundsBox.box.set(new THREE.Vector3(-b, -b, -b), new THREE.Vector3(b, b, b))
  boundsBox.visible = showBoundsBox && prefabOpen === null && doc !== null
}

/**
 * How far the level actually reaches, and how much of it is outside the bound.
 *
 * Measured off the drawn objects rather than the authored positions, so a wide platform counts by its edge
 * and not by its origin — the edge is where a player can stand, and standing there is what the bound has to
 * carry. Top-level objects only, or a nested child would be counted twice with its parent.
 */
const boundsReach = (): { outside: number; reach: number } | null => {
  if (doc === null) return null
  const b = effectiveBounds()
  const far = (box: THREE.Box3): number =>
    box.isEmpty() ? 0 : Math.max(Math.abs(box.min.x), Math.abs(box.min.y), Math.abs(box.min.z), box.max.x, box.max.y, box.max.z)
  let outside = 0
  for (const g of instanceGroups) {
    if (g === undefined || g.parent !== instanceRoot) continue
    if (far(new THREE.Box3().setFromObject(g)) > b) outside += 1
  }
  return { outside, reach: far(new THREE.Box3().setFromObject(instanceRoot)) }
}

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
 * Selected keys, as indices into the open track's sorted array, **primary last** (ADR 0051).
 *
 * A list rather than one index, so the panel can box-select and retime a passage in one drag. Primary last is
 * `selection.ts`'s convention (ADR 0031) and for the same reason: everything with a single subject — the
 * gizmo, the numeric fields, the status bar — still reads one index off the end.
 *
 * Selecting a key also parks the playhead on it (the timeline does that), so the item is *already* drawn at
 * that key's pose — which is why the gizmo needs no proxy object to drag. It edits what it is sitting on.
 */
let keySelection: readonly number[] = []
/** The key the gizmo writes, or `null` for the item as a whole. */
const activeKey = (): number | null => (keySelection.length === 0 ? null : (keySelection[keySelection.length - 1] ?? null))
/**
 * Armed to record: a gizmo drag writes a key at the playhead instead of moving the object's rest pose
 * (ADR 0051).
 *
 * Only the channel the drag touched, taken from the gizmo's own mode — so nudging a platform sideways cannot
 * invent a rotation key that would freeze a spin. Scale is not animatable, so a scale drag is unaffected.
 */
let recording = false
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
 * One job now: a multi-selection mirrors the primary's delta onto everything else, which is meaningless
 * without the pose each of them started from (ADR 0031). It used to have a second — snapshotting the keys of
 * an animated item, whose whole track was rewritten by a delta on every pointer event — and ADR 0050 removed
 * it, because an offset track moves by its transform and needs nothing to accumulate against.
 */
interface DragStart {
  pose: Pose
  scale: Vec3
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

const setKeySelection = (indices: readonly number[]): void => {
  keySelection = [...indices]
  updateTrackHelper()
}

/**
 * The keys of an item's first keyframe parameter — from its clip if it plays one — or `null` when it has no
 * keyframe parameter at all.
 *
 * Per *item*, not per selection: a multi-selection drag writes each item back through its own component, and
 * the panel's target only says what it has open. Clip-aware for the same reason `writeKeys` is: reading the
 * inline keys of a node playing a clip would show the gizmo a track nobody is playing.
 */
const keysOfItem = (index: number): readonly Keyframe[] | null => {
  if (doc === null) return null
  const editor = doc.keyEditors(index)[0]
  if (editor === undefined) return null
  const clip = clipIdOf(index, editor)
  return clip !== '' ? (assets?.keys(clip) ?? []) : doc.keysOf(index, editor)
}

/**
 * The animation clip a node's keyframe parameter is playing, or `''` for its own inline keys (ADR 0050).
 *
 * Which sibling parameter holds it comes from the `keys` declaration (`KeyEditor.clipParam`), so this stays a
 * question about parameters rather than about `Track`.
 */
const clipIdOf = (index: number, editor: KeyEditor): string => {
  if (doc === null || editor.clipParam === null) return ''
  const c = doc.components(index).find((x) => x.id === editor.componentId)
  const v = c?.params[editor.clipParam]
  return typeof v === 'string' ? v : ''
}

/** The clip the panel has open, or `''`. */
const openClipId = (): string => (selected === null || keyTarget === null ? '' : clipIdOf(selected, keyTarget))

/**
 * Write keys wherever this node's keys actually live — its clip, or the component's own parameter.
 *
 * **The one seam.** Every path that changes keys goes through here: the panel, the gizmo dragging a key, and
 * Record mode. Routing only some of them would let a gizmo drag write inline keys onto a node playing a clip,
 * which the loader's precedence would then honour — silently overriding the clip for that one object.
 *
 * A clip edit is not a document edit, so it is outside undo. See `setSelectedKeys`.
 */
const writeKeys = (index: number, editor: KeyEditor, keys: readonly Keyframe[]): void => {
  const clip = clipIdOf(index, editor)
  if (clip !== '') {
    assets?.setClipKeys(clip, sortedKeys(keys))
    scheduleClipSave(clip)
    return
  }
  doc?.setKeys(index, editor, keys)
}

/**
 * The keys the panel has open: the clip's when the component names one, otherwise the component's own.
 *
 * Same precedence the loader applies, and it has to be — a panel that edited the inline keys of a component
 * playing a clip would show edits that never reach the viewport.
 *
 * A clip id that resolves to nothing yields `[]` rather than `null`: the component *is* animatable, its clip
 * is just missing or still loading, and saying "nothing animatable selected" would be a lie.
 */
const selectedKeys = (): readonly Keyframe[] | null => {
  if (selected === null || doc === null || keyTarget === null) return null
  const clip = openClipId()
  if (clip !== '') return assets?.keys(clip) ?? []
  return doc.keysOf(selected, keyTarget)
}

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
 * A clip edit written to disk, debounced.
 *
 * In memory first, on disk later: the panel calls `setKeys` on every pointer event of a drag, and the viewport
 * has to follow at once while a PUT per event would flood the dev server. 400ms after the last edit is late
 * enough to coalesce a drag and early enough that nobody loses work to a closed tab.
 */
let clipSaveTimer: number | null = null
const scheduleClipSave = (assetId: string): void => {
  if (clipSaveTimer !== null) window.clearTimeout(clipSaveTimer)
  clipSaveTimer = window.setTimeout(() => {
    clipSaveTimer = null
    void lockAsset(assetId).then((mine) => {
      if (mine) return assets?.saveClip(assetId).catch((e: unknown) => setProblem(`clip save failed: ${String(e)}`))
      return undefined
    })
  }, 400)
}

/**
 * Replace the open keys, then redraw everything they affect: the item's pose at the playhead, the path
 * handles, the physics instance, and the panel.
 *
 * **A clip edit is not a document edit.** It lands in the asset, so it is outside the document history and
 * Ctrl+Z will not take it back — the same as editing a material, and for the same reason: `history.ts`
 * snapshots the document, and an asset file is not in it. The panel says when you are editing a clip.
 */
const setSelectedKeys = (keys: readonly Keyframe[]): void => {
  if (selected === null || doc === null || keyTarget === null) return
  writeKeys(selected, keyTarget, keys)
  // Only a document edit is undoable, so only a document edit records one. A clip edit lands in the asset.
  if (openClipId() === '') recordEdit('animation')
  applyPreviewPoses()
  updateTrackHelper()
  scheduleRebuild()
  timeline.render()
  hierarchy.render()
  renderStatus()
}

/**
 * Lift the open inline keys into a new clip asset, and point the component at it.
 *
 * The inline keys are **emptied** in the same edit, so the two can never disagree and the precedence rule
 * (inline wins) never has to arbitrate something a person authored by accident.
 */
const saveAsClip = (): void => {
  void (async () => {
    const at = selected
    const target = keyTarget
    if (at === null || doc === null || target === null || target.clipParam === null || assets === null) return
    const keys = doc.keysOf(at, target)
    if (keys === null || keys.length === 0) return
    const created = await assets.createAnimation(`${doc.label(at)}-clip`, { keys: sortedKeys(keys) }).catch((e: unknown) => {
      setProblem(`save as clip failed: ${String(e)}`)
      return undefined
    })
    if (created === undefined) return
    await reloadAssets()
    doc.setParams(at, target.componentId, { [target.clipParam]: created.id, [target.param]: [] })
    recordEdit('save as clip')
    inspectorRebuild()
    scheduleRebuild()
    timeline.render()
    setStatus(`saved ${created.name}`)
  })()
}

/** Copy a clip's keys back inline and clear the reference, leaving this object with a track of its own. */
const unlinkClip = (): void => {
  const at = selected
  const target = keyTarget
  if (at === null || doc === null || target === null || target.clipParam === null) return
  const clip = openClipId()
  if (clip === '') return
  doc.setParams(at, target.componentId, { [target.param]: sortedKeys(assets?.keys(clip) ?? []), [target.clipParam]: '' })
  recordEdit('unlink clip')
  inspectorRebuild()
  scheduleRebuild()
  timeline.render()
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
    // One history entry per drag, recorded when it ends. `coalescing` holds `recordEdit` off while the hundred
    // pointer events each report a transform op; the record at the end folds them into one.
    coalescing = true
    heldBack = []
    startPresence()
    dragStart = new Map()
    if (doc !== null) {
      for (const i of selection) {
        const g = instanceGroups[i]
        if (g === undefined) continue
        dragStart.set(i, {
          // Read off the group, not from `poseOf`, though at this instant they agree: every value compared
          // against it later is also read off a group, so both sides share one rounding and one euler branch.
          // Mixing the stored euler with a re-derived one leaves a residue in the delta that accumulates.
          pose: groupPose(g),
          scale: vec3(g.scale.x, g.scale.y, g.scale.z),
        })
      }
    }
  } else {
    coalescing = false
    stopPresence()
    // The whole drag as one op per node — what the history holds, and what the room gets.
    const drag = foldBatches(heldBack, edit.mode, [])
    heldBack = []
    if (drag !== null && live()) collab.submit({ ops: drag.ops, inverses: drag.inverses })
    recordEdit(selection.length > 1 ? `${edit.mode} ${selection.length}` : edit.mode)
    dragStart = new Map()
    rebuildLoaded()
    if (deferredRemote.length > 0) {
      const ops = deferredRemote
      deferredRemote = []
      repaintAfterOps(ops)
    }
  }
})
gizmo.addEventListener('objectChange', () => {
  writeBackSelected()
  mirrorDragToSelection()
  if (edit.mode === 'scale') for (const i of selection) rebuildSubtreeMeshes(i)
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
  if (activeKey() !== null) return
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
 * Where a gizmo drag lands (ADR 0029, simplified by ADR 0050).
 *
 * - **No key selected**: the authored transform — animated or not, which is why this is now one row instead
 *   of two. Keys are offsets, so moving the transform carries the whole path with it, and the visible
 *   polyline shows it move. Under absolute keys this case had to rewrite every key by a delta.
 * - **A key selected**: that key's offset. The item is drawn at the key (the playhead is parked on it), so
 *   the gizmo is dragging the key itself.
 *
 * A channel the track does not animate falls through to the authored transform, so rotating a
 * translation-only lift tilts the lift rather than inventing a one-key rotation channel that would freeze it.
 */
const writeBackItem = (index: number): void => {
  if (doc === null) return
  const g = instanceGroups[index]
  if (g === undefined) return
  const keys = keysOfItem(index)
  // An **empty** track routes here too when armed: recording the first key is the whole point of arming, and
  // requiring a key before you can record one would be a chicken-and-egg. Unarmed, an empty track is just an
  // object, and a drag moves it.
  if (keys !== null && (keys.length > 0 || recording)) {
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

/**
 * How much of an item's posed pose came from its track, at the playhead.
 *
 * Measured as the difference between where the item is drawn and where it rests, rather than by evaluating
 * the track again here — so it is right for whatever component owns the keys without this needing to know
 * which one, and it cannot drift from what `applyPreviewPoses` actually drew.
 *
 * Invariant across a drag: keys are offsets, so this depends on the keys and the playhead and not on the
 * transform the drag is rewriting. That is what lets the write-back below be a subtraction instead of a
 * delta against a snapshot.
 */
const trackOffsetAt = (index: number, timeMs: number): Pose => {
  if (doc === null) return { position: vec3(0, 0, 0), rotation: vec3(0, 0, 0) }
  const authored = doc.transformOf(index)
  const rest = authored.rotation ?? vec3(0, 0, 0)
  const at = doc.poseOf(index, timeMs)
  return {
    position: vec3(at.position.x - authored.position.x, at.position.y - authored.position.y, at.position.z - authored.position.z),
    rotation: vec3(at.rotation.x - rest.x, at.rotation.y - rest.y, at.rotation.z - rest.z),
  }
}

/** Scale is not animatable, so it always belongs to the transform — key selected, recording, or neither. */
const keepScaleOnTransform = (index: number, g: THREE.Group): void => {
  if (doc === null) return
  const authored = doc.transformOf(index)
  doc.setTransform(index, {
    position: authored.position,
    ...(authored.rotation !== undefined ? { rotation: authored.rotation } : {}),
    ...(isOne(g.scale) ? {} : { scale: vec3(r4(g.scale.x), r4(g.scale.y), r4(g.scale.z)) }),
  })
}

const writeBackIntoTrack = (index: number, keys: readonly Keyframe[], g: THREE.Group): void => {
  if (doc === null) return
  const editor = doc.keyEditors(index)[0]
  if (editor === undefined) return
  const pose = groupPose(g)
  const at = activeKey()

  /**
   * Armed to record: the drag writes a **key at the playhead**, on the one channel the gizmo mode moved
   * (ADR 0051).
   *
   * One channel, not a whole pose, because `putKey` would invent a rotation key the moment you nudged a
   * platform sideways and freeze whatever spin it had. `putChannel` merges into the key already at the
   * playhead, so a hundred pointer events in one drag replace rather than stack.
   *
   * `scale` falls through: it is not animatable, so a scale drag is an ordinary transform edit even armed.
   */
  if (recording && edit.mode !== 'scale') {
    const authored = doc.transformOf(index)
    const rest = authored.rotation ?? vec3(0, 0, 0)
    const written =
      edit.mode === 'rotate'
        ? putChannel(keys, previewMs, 'rotation', vec3(r4(pose.rotation.x - rest.x), r4(pose.rotation.y - rest.y), r4(pose.rotation.z - rest.z)))
        : putChannel(
            keys,
            previewMs,
            'position',
            vec3(r4(pose.position.x - authored.position.x), r4(pose.position.y - authored.position.y), r4(pose.position.z - authored.position.z)),
          )
    writeKeys(index, editor, written.keys)
    keySelection = [written.index]
    return
  }

  if (at === null) {
    /**
     * No key selected: the drag moves where the object *rests*, and the whole path rides along because every
     * key is an offset from it (ADR 0050).
     *
     * The group is drawn at rest + the track's offset at the playhead, so stripping that offset back off is
     * what the transform should be. A subtraction, not a delta against a drag snapshot — so a hundred pointer
     * events in one drag cannot compound, and a typed Inspector value needs no snapshot to land.
     */
    const offset = trackOffsetAt(index, previewMs)
    const rot = new THREE.Euler(pose.rotation.x - offset.rotation.x, pose.rotation.y - offset.rotation.y, pose.rotation.z - offset.rotation.z)
    doc.setTransform(index, {
      position: vec3(r4(pose.position.x - offset.position.x), r4(pose.position.y - offset.position.y), r4(pose.position.z - offset.position.z)),
      ...(isZeroRot(rot) ? {} : { rotation: vec3(r4(rot.x), r4(rot.y), r4(rot.z)) }),
      ...(isOne(g.scale) ? {} : { scale: vec3(r4(g.scale.x), r4(g.scale.y), r4(g.scale.z)) }),
    })
    return
  }

  /**
   * A key selected: the gizmo drags that key. A key holds an offset, so what goes in is the posed group
   * measured against where the object rests.
   *
   * Only the channels **this key already carries** are written, not every channel the track animates: a key
   * that keys position alone must not sprout a rotation channel because the gizmo was dragged, which is the
   * same reason Record mode writes one channel.
   */
  const authored = doc.transformOf(index)
  const rest = authored.rotation ?? vec3(0, 0, 0)
  const key = sortedKeys(keys)[at]
  keepScaleOnTransform(index, g)
  if (key === undefined) return

  writeKeys(
    index,
    editor,
    setKeyPose(keys, at, {
      ...(key.position !== undefined
        ? { position: vec3(r4(pose.position.x - authored.position.x), r4(pose.position.y - authored.position.y), r4(pose.position.z - authored.position.z)) }
        : {}),
      ...(key.rotation !== undefined ? { rotation: vec3(r4(pose.rotation.x - rest.x), r4(pose.rotation.y - rest.y), r4(pose.rotation.z - rest.z)) } : {}),
    }),
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
  // A node someone else holds is theirs: never in the selection, so the gizmo never lands on it (ADR 0089).
  selection = clampTo(next, doc?.count() ?? 0).filter((i) => heldBy(i) === null)
  const primary = primaryOf(selection)
  selected = primary
  keySelection = [] // a fresh selection edits the object, not whichever key the last one was on
  // Disarmed too: armed Record left running across a selection change would write keys onto the next object
  // you dragged, which is a surprise nobody asked for.
  recording = false
  keyTarget = primary === null || doc === null ? null : (doc.keyEditors(primary)[0] ?? null)

  reattachGizmo()

  inspectorRebuild()
  updateTrackHelper()
  timeline.render()
  uiChanged()
  // After the panel has been rebuilt, not before: a nested object selected in the viewport is inside a
  // collapsed parent as often as not, and marking a row nobody can see is the same as not marking it.
  if (primary !== null) hierarchy.reveal(primary)
  syncHolds()
}

/** Select one item outright — the plain click, and what every command that lands on a new item does. */
const select = (index: number): void => {
  if (instanceGroups[index] === undefined || doc === null) return
  if (refuseHeld(index)) return
  applySelection([index])
}

/** A click that carries modifiers: Ctrl toggles one, Shift extends a range over `order`. */
const selectWith = (index: number, mode: SelectMode, order: readonly number[]): void => {
  if (instanceGroups[index] === undefined || doc === null) return
  if (refuseHeld(index)) return
  applySelection(applySelect(selection, index, mode, order))
}

/** A click on a node someone else holds: say who, do nothing. */
const refuseHeld = (index: number): boolean => {
  const holder = heldBy(index)
  if (holder === null) return false
  setStatus(`${holder} has that selected`)
  return true
}

const deselect = (): void => {
  selection = []
  selected = null
  keySelection = []
  gizmo.detach()
  inspectorRebuild()
  updateTrackHelper()
  timeline.render()
  uiChanged()
  syncHolds()
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
  raycaster.setFromCamera(ndc, activeCamera())
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
      placing.kind === 'model'
        ? doc.placeModel(placing.assetId, at)
        : prefabAsset !== undefined
          ? doc.placePrefab(placing.assetId, prefabAsset, at)
          : -1
    if (idx < 0) {
      const unknown = prefabAsset === undefined ? [] : unknownComponentTypes(prefabAsset, doc.registry)
      setStatus(unknown.length > 0 ? `uses ${unknown.join(', ')}, which this game does not have` : 'that prefab did not load')
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
    // Shift extends, matching the panel and the Hierarchy — a path handle is another way to reach the same key.
    setKeySelection(e.shiftKey ? [...keySelection.filter((i) => i !== index), index] : [index])
    const keys = selectedKeys()
    const key = keys === null ? undefined : sortedKeys(keys)[index]
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
/**
 * Write the selection into a prefab file and point it at that file (ADR 0091) — the one action that makes a
 * prefab, replacing both `Extract to prefab`, which wrote no file, and prefab mode's Save, which made no
 * reference.
 *
 * **The file goes first.** A failed write costs nothing but a status line, where the reverse order would leave
 * a placement pointing at a prefab that does not exist. If the write lands and the level edit does not, the
 * file is simply an unreferenced prefab, which is visible in the Project panel and placeable by hand.
 *
 * The undo entry holds the level's `replaceNode` and its inverse. It does **not** delete the file: by the time
 * anyone presses Ctrl+Z another level may already reference it, and deleting a file on an undo is a surprise
 * nobody recovers from. The Project panel is where a prefab is deleted.
 */
const saveAsPrefab = async (index: number): Promise<void> => {
  const open = doc
  if (open === null || open.mode !== 'level' || assets === null) return
  const definition = open.definitionOf(index)
  if (definition === null) return
  if (refuseHeld(index)) return

  // Identity that survives the awaits: an index shifts under a remote edit, a ref does not.
  const ref = open.refAt(index)
  if (ref === null) return

  const folder = project.folder()
  const asked = await askName('Save as prefab', sanitisePrefabName(open.nameOf(index) || open.label(index)), `Saved in content/assets/${prefabFolder(folder)}/ — the folder open in the Project panel. Letters, digits, - and _.`)
  if (asked === null) return
  const target = prefabTarget(folder, asked, assets.db.entries.map((e) => e.path))
  if ('error' in target) {
    setStatus(target.error)
    return
  }

  let created
  try {
    created = await assets.createPrefab(target.path, definition)
  } catch (e) {
    setStatus(`could not save ${target.path}: ${String(e)}`)
    return
  }
  if (created === undefined) {
    setProblem(`wrote ${target.path} but it was given no id — reload the editor`)
    return
  }
  previews.invalidate()
  await reloadAssets()

  // The document may have moved under the dialog and the two requests.
  const at = doc === open ? open.indexOfRef(ref) : null
  if (at === null || !open.linkToPrefab(at, created.id, definition)) {
    setStatus(`saved ${created.name} to ${target.path}, but that object is gone — place it from the Project panel`)
    refreshUi()
    return
  }
  recordEdit('save as prefab')
  buildItems()
  rebuildLoaded()
  applySelection([open.indexOfRef(ref) ?? at])
  inspectorRebuild()
  uiChanged()
  loadNewReferences(buildItems)
  setStatus(`saved ${created.name} to ${target.path} — every level can place it now`)
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

let char: CharacterState | null = null
let controller: LocalController | null = null
let playLoop: LoopHandle | null = null
let playView: LevelView | null = null
// Play mode hides instanceRoot, which hides the authored lights with it, so it needs its own (ADR 0047).
let playLights: ContentLights | null = null
let ownPos: Vec3 = { x: 0, y: 1, z: 0 }

/**
 * The game's third-person camera — `@mp/camera`, the same object the game builds (ADR 0059).
 *
 * This was a **third** hand-written third-person camera: its own yaw and pitch, a fixed distance, `lookAt`
 * instead of a boom, and no occlusion at all. So every camera fix since ADR 0055 — the see-through hole, the
 * below-the-feet rule, the three sightlines down the body — was invisible in the editor, which is the one
 * place you would go to check whether a level plays well. ADR 0056 recorded this file as using
 * `OrbitControls` for it; that was wrong, and the duplicate is why.
 *
 * Built once rather than per play, so zoom and pitch survive stopping and starting — and because the cutout
 * mask it owns clones a material per occluder, which is not worth rebuilding on every play.
 */
const playCamera = createOrbitCamera(stage.camera)
window.addEventListener('mousemove', (e) => {
  if (!playing || document.pointerLockElement !== canvas) return
  playCamera.lookMouse(e.movementX, e.movementY)
})
// Wheel zoom, which the hand-written camera simply did not have.
window.addEventListener(
  'wheel',
  (e) => {
    if (!playing || document.pointerLockElement !== canvas) return
    e.preventDefault()
    playCamera.zoomNotch(Math.sign(e.deltaY))
  },
  { passive: false },
)
canvas.addEventListener('click', () => {
  if (playing && document.pointerLockElement !== canvas) void canvas.requestPointerLock()
})
document.addEventListener('pointerlockchange', () => {
  if (playing && gameFrame === null && document.pointerLockElement !== canvas) stopPlay() // Esc / lost lock exits play
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
  const facing = playCamera.yaw()
  const fwdX = -Math.sin(facing)
  const fwdZ = -Math.cos(facing)
  let x = fwdX * -rz + -fwdZ * rx
  let z = fwdZ * -rz + fwdX * rx
  const l = Math.hypot(x, z)
  if (l > 1) {
    x /= l
    z /= l
  }
  return { x, z }
}

/**
 * The active game's own actions that are held right now, by name (ADR 0061).
 *
 * Read off `activeMode` per tick rather than flattened once, because the game can change while the editor is
 * open. `actionsHeld` is shared with the game client on purpose: two copies of this mapping is how the editor
 * and the game came to disagree about post-FX (ADR 0057).
 */
const heldActions = (): ReadonlySet<string> => actionsHeld(activeMode?.actions, keys)

/** The live components while playing. Detached on stop, so a component's teardown runs like the game's. */
let playComponents: ComponentRuntime | null = null

// ============================== Play = the real game, in a frame (ADR 0086) ==============================
/** The frame showing the game while a level is being play-tested; `null` otherwise. */
let gameFrame: HTMLIFrameElement | null = null
/** Where the open level's game plays, or `null`: not a level, no game, or the server knows no page for it. */
const gamePageUrl = (): string | null => {
  if (fileState.mode !== 'level' || activeMode === undefined) return null
  return me?.games[activeMode.name] ?? null
}

/**
 * Play a level in the **real game** — HUD, progression, other players — rather than the editor's own loop. The
 * game page reads the saved file, so unsaved edits are saved first; a save that fails (read-only, locked) means
 * no play. Stop is the toolbar button: Esc inside the frame is the game's pause, not ours.
 */
const startFramePlay = async (url: string): Promise<void> => {
  if (live()) await collab.flush() // the game reads the file: make it current first
  else if (dirty && !(await saveNow())) return
  const frame = document.createElement('iframe')
  frame.id = 'game-frame'
  frame.src = `${url}?level=${encodeURIComponent(fileState.name)}`
  frame.allow = 'fullscreen; pointer-lock'
  document.getElementById('centre')?.append(frame)
  gameFrame = frame
  playing = true
  controls.enabled = false
  setStatus(`playing ${fileState.name} in the game — Stop to come back`)
  uiChanged()
}

const startPlay = (): void => {
  if (doc === null || playing) return
  const url = gamePageUrl()
  if (url !== null) {
    void startFramePlay(url)
    return
  }
  // Two clocks running at once would be two answers to "where is this platform". Play wins: it is the real
  // one, and the track helper hides itself while playing anyway.
  setPreviewing(false)
  rebuildLoaded() // fresh world + loaded from the current data
  if (loaded === null || world === null) return
  deselect()
  /**
   * Play-in-place runs **the game's own rules**, not a copy of them (ADR 0052).
   *
   * `mode.session` is the same function the game's client calls, so spawn, progress and death cannot drift
   * from it. They had: this used to die on any fall, ignoring `fallBehavior`, so a `physical-fall` tower
   * killed you here and let you fall in the game. The only difference left is what a client *does* about a
   * death — no ragdoll, no persistence, just a teleport back.
   *
   * With no game (an unassigned level, or one whose game is missing) there are no rules to run: you get the
   * character and the geometry, which is still the useful half of a play-test.
   */
  const mode = activeMode
  const spawn: Vec3 = mode?.spawn(loaded) ?? { x: 0, y: 3, z: 0 }
  char = addCharacter(world, spawn)
  const rules = mode?.session(loaded)
  playComponents =
    rules === undefined
      ? null
      : createComponentRuntime(loaded, registry(), {
          character: characterAccess(char),
          effects: rules.effects,
          // The game's player components too, so a play-test has the abilities the game has (ADR 0059) —
          // the same reason it runs the game's own `tuning` and rules rather than a default. Their
          // definitions come from the game as well (ADR 0061), which is what gives a play-test the game's
          // *locomotion* and not the stack's.
          ...(mode?.player === undefined
            ? {}
            : {
                player: {
                  id: PLAYER_NODE_ID,
                  components: mode.player,
                  ...(mode.playerDefs === undefined
                    ? {}
                    : {
                        defs: mode.playerDefs({
                          character: () => char,
                          tuning: () => mode.tuning,
                          platforms: () => loaded?.basePose,
                          // The play-test has a real world and a real level, so a game's component gets the
                          // same two handles here as it does in the game (ADR 0066). Anything it draws will
                          // not appear — the editor has no frame hook of its own to offer — which is the
                          // known limit of play-in-place.
                          world: () => world,
                          level: () => loaded,
                        }),
                      }),
                },
              }),
        })
  let playTick = 0
  playComponents?.attach(playTick, 0, TICK_DT)

  // One fixed step of platform time per fixed step — see @mp/core simClock (reading the wall
  // clock inside the tick stalls the platforms during a multi-tick wake and jitters carry).
  const simClock = createSimClock({ tickMs: TICK_DT * 1000, reference: () => performance.now() })

  const local: LocalWorld = {
    applyInput: (cmd) => {
      if (world === null || loaded === null || char === null) return
      const nowMs = simClock.tick()
      // Components first, then the frame tree — the same order as the game (ADR 0058), because a component
      // that moves its node writes an offset the frame tree reads, and posing first lands it a tick late.
      playComponents?.fixedUpdate(++playTick, nowMs, TICK_DT)
      loaded.update(nowMs, char.base?.colliderHandle) // only the ridden piece is frozen
      world.step(TICK_DT) // (A) platforms move
      /**
       * The movement slot (ADR 0061), same as the game's. A game whose locomotion is its own component feels
       * like itself here, where before this ran `stepCharacter` with the game's *numbers* and the stack's
       * mechanics.
       *
       * A level with no game, or a game with no locomotion component, does not move — which is honest: there
       * is nothing to ask. It used to fall back to `DEFAULT_TUNING`, quietly play-testing parkour.
       */
      playComponents?.locomote(playTick, nowMs, TICK_DT, cmd)
      world.step(TICK_DT) // (B) character resolves against the moved platforms
      lastSimTickAt = performance.now()
    },
    readState: () => new Map<EntityId, Vec3>([[PLAYER_ID, char!.body.translation()]]),
  }
  controller = createLocalController({ world: local, tickRateHz: TICK_RATE_HZ })

  instanceRoot.visible = false
  // The cutout mask, so an obstruction dithers away here exactly as it does in the game (ADR 0055). The edit
  // view deliberately does not get one — it would clone a material per occluder for a camera nobody is
  // playing through.
  playView = addLevel(stage.scene, loaded.visuals, { cutout: playCamera.cutout })
  /**
   * The two queries the camera needs, over the play world (ADR 0056: the camera imports no physics, it is
   * handed the casts). Self-exclusion is the character's own capsule; there is no ragdoll here to skip.
   */
  playCamera.observe({
    cast: (origin, direction, maxDistance, skip) => {
      const hit = world?.castSphere({
        origin,
        direction,
        maxDistance,
        radius: playCamera.probeRadius,
        exclude: [...(char === null ? [] : [char.body.colliderHandle]), ...(skip ?? [])],
      })
      return hit === undefined ? undefined : { distance: hit.distance, colliderHandle: hit.colliderHandle }
    },
    occupied: (point) =>
      world?.sphereOverlaps({
        center: point,
        radius: playCamera.probeRadius,
        exclude: char === null ? [] : [char.body.colliderHandle],
      }) === true,
  })
  playLights = addLights(stage.scene, loaded.lights)
  charMesh.visible = true
  // The player camera is `stage.camera` and tunes its fov (`createOrbitCamera`), so play is perspective.
  setProjection(false)
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
      // The game's own actions too (ADR 0061), so a play-test has the controls the game has — the same
      // reason it runs the game's `tuning`, its rules and its player components rather than defaults.
      controller.step({ moveX: m.x, moveZ: m.z, jump: keys.has('Space'), actions: heldActions() })
      // Solids and triggers both: a sensor resolves no movement, so it is not in `collisions` (ADR 0054).
      playComponents?.contact([...char.body.collisions(), ...char.body.overlaps()])
      // One question, asked of the game's rules, which also consume the flag. A level with no game never dies.
      if (rules?.takeDeath() === true) {
        char.body.setPosition(rules.respawnAt())
        char.vx = 0
        char.vy = 0
        char.vz = 0
        char.grounded = false
      }
      // A rule that relocates without killing (ADR 0073) — a play-test cashes out the way the game does.
      const teleport = rules?.takeTeleport?.() ?? null
      if (teleport !== null) {
        char.body.setPosition(teleport)
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
  if (gameFrame !== null) {
    gameFrame.remove()
    gameFrame = null
    playing = false
    controls.enabled = true
    statusMsg = ''
    uiChanged()
    return
  }
  playLoop?.stop()
  playLoop = null
  playComponents?.detach()
  playComponents = null
  char?.body.remove()
  char = null
  controller = null
  playView?.dispose()
  playView = null
  playLights?.dispose()
  playLights = null
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
  // The previous file's locks go first — releasing them is what commits that session (ADR 0083).
  await dropAllLocks()
  try {
    {
      /**
       * A level is a live session, not a file with a lock (ADR 0089): join it and the server answers with its
       * copy — newer than the file whenever someone has it open.
       *
       * The level says which game it is for, and that decides the registry it is validated against — so
       * opening a level that uses a component its game does not declare is a clear load error rather than a
       * silently broken Inspector (ADR 0052). Read before validating, so the mode can pick the registry.
       */
      joining = true
      try {
        await collab.join(name)
      } finally {
        joining = false
      }
      const raw: unknown = latestSnapshot ?? (await loadLevelRaw(name))
      const declared = (raw as { config?: { mode?: { name?: unknown } } }).config?.mode?.name
      activeMode = (typeof declared === 'string' ? MODES[declared] : undefined) ?? soleMode()
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
      setDoc(withOps(levelDoc(level, registry(), editorClips)), name)
      if (missingPrefabs.length > 0) setStatus(`no prefab file for ${missingPrefabs.join(', ')} — those objects are empty`)
    }
  } catch (e) {
    setStatus(`load failed: ${String(e)}`)
  }
  if (readOnlyBy !== null) setStatus(`${name} is open read-only: ${readOnlyBy} has it`)
}

/** Every level on disk with the game it declares, so the list can be narrowed to one game (ADR 0052). */
let levelEntries: FileEntry[] = []

/**
 * The levels worth offering: the ones for the game being authored for.
 *
 * A level naming **no** game is always offered, because it is not another game's — it is unassigned, and
 * hiding it would make a file you can see on disk unreachable in the tool that is supposed to fix it. With no
 * active game, everything is offered.
 */
const visibleLevels = (): string[] =>
  levelEntries.filter((e) => activeMode === undefined || e.mode === undefined || e.mode === activeMode.name).map((e) => e.name)

const refreshFileList = async (): Promise<void> => {
  levelEntries = await listFiles('levels').catch(() => [] as FileEntry[])
  fileNames = visibleLevels()
  toolbar?.render()
}

/**
 * Make a level file and open it live (ADR 0089): a blank one, or a copy of `from` — the server's current copy,
 * newer than the file while it is open. Names are files, so one that exists is refused.
 */
const createLevel = async (from: string | null): Promise<void> => {
  const title = from === null ? 'New level' : `Duplicate ${from}`
  const name = await askName(title, from === null ? 'untitled' : `${from}-copy`, 'File name in content/levels/. Letters, digits, - and _.')
  if (name === null) return
  if (!/^[\w-]+$/.test(name)) {
    setStatus(`"${name}" is not a file name: letters, digits, - and _ only`)
    return
  }
  const existing = await listFiles('levels').catch(() => [] as FileEntry[])
  if (existing.some((e) => e.name === name)) {
    setStatus(`a level called ${name} already exists`)
    return
  }
  let data: unknown
  if (from === null) {
    const blank = blankLevel(name)
    if (activeMode !== undefined) blank.config = { ...blank.config, mode: { name: activeMode.name } }
    data = blank
  } else {
    const copy = (await loadLevelRaw(from)) as { id?: unknown }
    copy.id = name
    data = copy
  }
  try {
    await saveFile('levels', name, data)
  } catch (e) {
    setStatus(`could not create ${name}: ${String(e)}`)
    return
  }
  await refreshFileList()
  await openFile(name)
}

/** Open the first level the active game has, or a blank one when it has none. */
const openFirstLevel = async (): Promise<void> => {
  await refreshFileList()
  if (fileNames[0] !== undefined) await openFile(fileNames[0])
  else setDoc(withOps(levelDoc(blankLevel('untitled'), registry(), editorClips)), 'untitled')
}

// --- toolbar ---
const toolbar: Toolbar = createToolbar(
  $<HTMLDivElement>('#toolbar'),
  () => ({
    game: activeMode?.name ?? '',
    games: MODE_LIST.map((m) => ({ name: m.name, label: m.label })),
    name: fileState.name,
    files: fileNames,
    gizmo: edit.mode,
    space: edit.space,
    snap: edit.snap,
    step: edit.step,
    playing,
    inPrefab: prefabOpen !== null,
    readOnly: readOnlyBy,
    live: live(),
    grid: grid.visible,
    markers: markerGroup.visible,
  }),
  {
    setGame: (name) => {
      /**
       * The authoring context, not the open level's tag: retagging happens in the Game row, where the
       * consequences of changing a level's game are in front of you (ADR 0052).
       *
       * It **opens that game's first level**, because the file list is filtered by game and leaving the
       * previous game's document open showed one game's levels while editing another's — and Save writes the
       * *open* file, so a save after switching to Swing wrote parkour's `default.json`. Harmless with one
       * game installed, which is why it survived until there were two.
       */
      void guardUnsaved().then((go) => {
        if (!go) return
        activeMode = MODES[name]
        void refreshFileList().then(async () => {
          refreshUi()
          if (fileNames[0] !== undefined) await openFile(fileNames[0])
        })
      })
    },
    open: (name) => void guardUnsaved().then(async (go) => {
      if (go) await openFile(name)
    }),
    setName: (name) => {
      fileState.name = name === '' ? 'untitled' : name
      refreshUi()
    },
    // A live level exists the moment it is named: the file is created on the server, then joined.
    newBlank: () => void createLevel(null),
    duplicate: () => void createLevel(fileState.name),
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
  heldBy,
  onRename: (index, name) => {
    doc?.setName(index, name)
    recordEdit('rename')
    inspectorRebuild() // the inspector's own name field mirrors this one
    uiChanged()
  },
  onReparent: (from, parent, at) => {
    if (doc === null || !doc.canReparent(from, parent)) return
    if (parent !== null && refuseHeld(parent)) return
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
/**
 * Push this placement's overrides into the shared prefab — two documents, one gesture (ADR 0091). The prefab's
 * ops go to its own room, and only once the server has taken them does the override here go, so a refusal
 * leaves the placement exactly as it was rather than clean but unapplied.
 *
 * Ctrl+Z afterwards puts **this placement's** override back; it does not take the change out of the prefab.
 * The result looks the same either way, and the status line says so, because pushing into a prefab is a
 * deliberate act on something other levels share.
 */
const applyOverrides = async (): Promise<void> => {
  const open = doc
  const at = selected
  if (at === null || open === null) return
  const plan = open.overrideOpsFor(at)
  if (plan === null) return
  const name = assets?.db.byId[plan.assetId]?.name ?? 'the prefab'
  const refused = await collab.submitToPrefab(plan.assetId, plan.ops)
  if (refused !== null) {
    setStatus(`${name} did not take it: ${refused} — this placement is unchanged`)
    return
  }
  if (doc !== open) return // the document moved under the round trip
  open.revert(at)
  recordEdit('apply to prefab')
  buildItems()
  rebuildLoaded()
  applySelection(selection)
  setStatus(`applied to ${name} — every level using it follows; undo puts this placement's override back`)
}

/**
 * The Hierarchy's right-click menus.
 *
 * Almost every entry is a command that already existed and could only be reached from the keyboard or by a
 * gesture nobody discovers: rename was double-click only, Save as prefab and Open lived in the Inspector's header,
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
      items: [
        ...doc.registry
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
        // Shared components the game has not opted into: picking one adds it to the game first (ADR 0077).
        ...adoptable().map((type) => ({
          label: `${type} (adds to game)`,
          run: () => {
            void adopt([type]).then(() => {
              doc?.addComponent(index, type)
              recordEdit('add component')
              scheduleRebuild()
              inspectorRebuild()
              uiChanged()
            })
          },
        })),
      ],
    },
    { label: 'Create child', divider: true, enabled: own, why, items: createMenu(index) },
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
      label: 'Save as prefab…',
      enabled: own && ref === null && doc.mode === 'level',
      why: ref !== null ? 'already a prefab' : doc.mode === 'prefab' ? 'already inside a prefab' : why,
      run: () => void saveAsPrefab(index),
    },
    { label: 'Revert to prefab', divider: true, enabled: inherited && doc.overridesOf(index).length > 0, why: 'nothing overridden here', run: () => revertOverride() },
    { label: 'Apply to prefab', enabled: inherited && doc.overridesOf(index).length > 0, why: 'nothing overridden here', run: () => void applyOverrides() },
  ]
}

/** What can be made: the built-in shapes at their preset sizes (ADR 0090), and an empty. */
const createMenu = (parent: number | null, at?: Vec3): MenuItem[] => [
  ...PRIMITIVE_ORDER.map((kind) => ({ label: PRIMITIVE_LABELS[kind], run: () => createPrimitive(kind, parent, at) })),
  { label: 'Empty', divider: true, run: () => createEmpty(parent, at) },
]

/** The blank-space menu: what you can make when you are not pointing at anything. */
const blankMenu = (): MenuItem[] => [
  { label: 'Create', items: createMenu(null) },
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

/** Create a built-in shape at its preset size (ADR 0090) and select it. Placed like `createEmpty`. */
const createPrimitive = (kind: PrimitiveKind, parent: number | null, at?: Vec3): void => {
  if (doc === null) return
  const where = at ?? (parent === null ? vec3(r4(controls.target.x), r4(controls.target.y), r4(controls.target.z)) : vec3(0, 0, 0))
  const landed = doc.placePrimitive(kind, where, parent)
  if (landed < 0) {
    setStatus('nowhere to put that')
    return
  }
  recordEdit(`create ${PRIMITIVE_LABELS[kind].toLowerCase()}`)
  buildItems()
  scheduleRebuild()
  select(landed)
  uiChanged()
  loadNewReferences(buildItems)
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
  const camera = activeCamera()
  const back = camera.position.clone().sub(controls.target)
  // Degenerate only if the camera is already at its own target, which the controls do not allow.
  if (back.lengthSq() < 1e-6) back.set(0, 1, 1)
  controls.target.copy(centre)
  if (isometric) {
    // No fov to frame with: an orthographic camera frames by how much world its frustum holds, so the
    // distance only has to clear the geometry and the frustum does the framing.
    orthoCamera.zoom = 1
    syncOrthoFrustum(radius * 1.4)
    orthoCamera.position.copy(centre).add(back.normalize().multiplyScalar(Math.max(radius * 4, 10)))
  } else {
    const distance = (radius / Math.tan((stage.camera.fov * Math.PI) / 360)) * 1.4
    stage.camera.position.copy(centre).add(back.normalize().multiplyScalar(distance))
  }
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
    { label: 'Create here', enabled: point !== null, why: 'no surface under the pointer', items: createMenu(null, point ?? undefined) },
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
  prefabFor: (assetId) => assets?.prefabOf(assetId),
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
/**
 * The component types a prefab file uses that the open document's registry lacks, split into the shared ones
 * the game can adopt (ADR 0077) and another game's private ones, which it cannot (ADR 0076).
 */
const missingIn = (assetId: string): { shared: string[]; foreign: string[] } => {
  const entry = assets?.db.byId[assetId]
  const root = entry?.kind === 'prefab' ? assets?.prefabOf(assetId) : undefined
  if (root === undefined || doc === null) return { shared: [], foreign: [] }
  const unknown = unknownComponentTypes(root, doc.registry)
  return { shared: unknown.filter(isSharedComponent), foreign: unknown.filter((t) => !isSharedComponent(t)) }
}

/** Why this asset cannot be placed into the open document, or `null`. Only another game's private component is a reason. */
const unplaceableWhy = (assetId: string): string | null => {
  const { foreign } = missingIn(assetId)
  return foreign.length === 0 ? null : `uses ${foreign.join(', ')}, which this game does not have`
}

const armAsset = (assetId: string): void => {
  const entry = assets?.db.byId[assetId]
  if (entry === undefined) return
  const why = unplaceableWhy(assetId)
  if (why !== null) {
    setStatus(`${entry.name} ${why}`)
    return
  }
  // A shared component the game lacks is adopted on the way to arming, so the click that places it never sees
  // a registry without it (ADR 0077). Not while a prefab is open on top: a prefab belongs to no game.
  const { shared } = missingIn(assetId)
  if (shared.length > 0 && activeMode !== undefined && docStack.length === 1) {
    void adopt(shared).then(() => armAsset(assetId))
    return
  }
  const kind = entry.kind === 'prefab' ? ('prefabAsset' as const) : ('model' as const)
  placing = placing?.assetId === assetId ? null : { kind, assetId }
  refreshUi()
}

const renameAsset = (path: string, name: string): void =>
  afterFileOp(`renamed to ${name}`, async () => assets?.move(path, renamedTo(path, name)) ?? Promise.resolve())

/** A node id, minted the way `editorDoc` mints them: four random bytes, hex. */
const freshNodeId = (): string => {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Every `nodeRef` parameter a component type declares — what a re-id has to follow (ADR 0097). */
const nodeRefKeysOf = (type: string): string[] => {
  const def = registry().get(type)
  return def === undefined ? [] : Object.entries(def.params).filter(([, spec]) => spec.kind === 'nodeRef').map(([key]) => key)
}

/**
 * Delete an asset — and for a **prefab**, unlink every placement of it first (ADR 0097).
 *
 * Deleting a prefab used to be silent and unrecoverable: no warning, no count of what referenced it, and the
 * `.meta` sidecar went with the file, so the asset id died and re-creating the prefab could never re-link the
 * placements. They degraded to objects that kept a transform and drew nothing — right for a file that went
 * missing by accident, wrong for one somebody chose to delete.
 *
 * So the placements are unlinked instead: they keep exactly what they were drawing and stop being copies of
 * anything. Kodjo's call.
 *
 * Two paths, because the editor is the only side that can do this. The unlink needs a component registry —
 * for which components are singletons, and which parameters are node references that must follow a re-id —
 * and the editor-server has none by design.
 *
 * - the **open** level goes through its own document, as ops: one undo entry, and everyone in the room sees it.
 * - every **other** level goes through `GET` + `PUT`, which 409s while that level is open live. That refusal
 *   is the guard: rather than rewrite a file under somebody, the whole delete stops and names the level.
 *
 * The prefab file goes last. A failed unlink then costs nothing, where the reverse order would leave
 * placements pointing at an id that no longer exists.
 */
const deleteAsset = (path: string): void => {
  const entry = assets?.db.entries.find((e) => e.path === path)
  if (entry === undefined || entry.kind !== 'prefab') {
    afterFileOp(`deleted ${path}`, async () => assets?.remove(path) ?? Promise.resolve())
    return
  }
  void (async () => {
    const id = entry.id
    const all = await listFiles('levels').catch(() => [] as FileEntry[])
    const users = all.filter((f) => f.prefabs?.includes(id) === true).map((f) => f.name)
    const openName = fileState.name
    const here = doc?.refCount(id) ?? 0
    // The open document is ahead of the listing either way: it may have placed one since the last write, or
    // removed the last one.
    const others = users.filter((n) => n !== openName)

    const counts = [
      here > 0 ? `${here} in this level` : null,
      others.length > 0 ? `${others.length} other level${others.length === 1 ? '' : 's'} (${others.join(', ')})` : null,
    ].filter((s) => s !== null)
    const body =
      counts.length === 0
        ? 'Nothing places it. The file and its id go for good — a prefab created again later gets a new id.'
        : `Used by ${counts.join(' and ')}. Those objects stay where they are and keep what they are drawing; they just stop being copies of this prefab. The file and its id go for good.`
    if (!(await askDestructive(`Delete ${entry.name}?`, body, 'Delete'))) return setStatus('kept')

    // Other levels first: they are the ones that can refuse, and a refusal must stop the whole thing.
    for (const name of others) {
      try {
        const level = (await loadLevelRaw(name)) as Level
        hydratePrefabs(level, editorPrefabs)
        const n = unlinkPrefab(level, id, { types: registry(), freshId: freshNodeId, refKeysOf: nodeRefKeysOf })
        if (n > 0) await saveFile('levels', name, stripHydrated(level, [id]))
      } catch (e) {
        setStatus(`${name} could not be unlinked (${String(e)}) — nothing deleted`)
        return
      }
    }
    if (here > 0) {
      doc?.unlinkPrefab(id)
      recordEdit(`unlinked ${entry.name}`)
      await collab.flush().catch(() => undefined)
    }
    afterFileOp(`deleted ${path}`, async () => assets?.remove(path) ?? Promise.resolve())
  })()
}

const project: Project = createProjectPanel($<HTMLDivElement>('#palette'), {
  db: () => assets?.db ?? null,
  folders: () => assets?.folders ?? [],
  urlOf: (path) => assets?.urlOf(path) ?? path,
  armed: () => placing?.assetId ?? null,
  selectedAsset: () => selectedAsset,
  onPickAsset: armAsset,
  unplaceableWhy,
  onUpload: (files, folder) => {
    const cap = me?.maxUploadBytes ?? Infinity
    const tooBig = files.filter((f) => f.size > cap).map((f) => f.name)
    if (tooBig.length > 0) setStatus(`too big (cap ${Math.round(cap / 1024 / 1024)} MB): ${tooBig.join(', ')}`)
    const fits = files.filter((f) => f.size <= cap)
    if (fits.length === 0) return
    afterFileOp(`uploaded ${fits.map((f) => f.name).join(', ')}`, async () => {
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
    if (kind === 'material' || kind === 'animation') void lockAsset(assetId).then(() => renderStatus())
  },
  requestPreview: (kind, key, done) => previews.request(kind, key, done),
  onCreateAsset: (kind, folder) => {
    void (async () => {
      if (assets === null) return
      const name = `${kind}-${Date.now()}`
      // An empty clip is a legitimate starting point: no keys means no motion, so a fresh one holds the
      // transform of anything that plays it (ADR 0050).
      const make =
        kind === 'animation' ? assets.createAnimation(name, { keys: [] }, folder) : assets.createMaterial(name, { shader: 'standard', params: {} }, folder)
      const created = await make.catch((e: unknown) => {
        setStatus(`new ${kind} failed: ${String(e)}`)
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
    const foreign = entry === undefined ? null : unplaceableWhy(entry.id)
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
            if (placeable) armAsset(entry.id)
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
          run: () => void (prefabHere !== null && enterPrefab(prefabHere)),
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


// ============================== undo/redo by inverse ops (ADR 0089) ==============================
/**
 * The document reports every edit as ops with their inverses (`Doc.onOps`); `recordEdit` folds what arrived
 * since the last call into one history entry. Undo applies the entry's inverses to the level — an ordinary
 * edit as far as everything else is concerned — and never touches what anyone else did. Snapshots of the whole
 * document (ADR 0030) went with the per-file lock: a snapshot cannot belong to one person.
 */
const history = createOpHistory()
/** Batches the open documents reported since the last `recordEdit`. A gizmo drag piles up a hundred. */
let pending: OpBatch[] = []
const onDocOps = (batch: OpBatch): void => {
  pending.push(batch)
  if (!live()) return
  // Mid-drag the room sees presence, not a hundred ops: the batches wait and go as one when the drag ends.
  if (coalescing) heldBack.push(batch)
  else collab.submit(batch)
}
/** Every document this file builds reports its ops here; the top of the stack and the root alike. */
const withOps = (d: Doc): Doc => {
  d.onOps = onDocOps
  return d
}
/** True while a gizmo drag is in flight: one history entry per drag, not one per pointer event. */
let coalescing = false
/**
 * Are there edits not on disk?
 *
 * Set at `recordEdit`, the one seam every mutation already goes through, and cleared by `resetHistory` —
 * which runs on save and on opening a document, the two moments after which there is nothing to lose. A
 * separate flag rather than `history.canUndo()`: undo depth survives a save, and asking "can I undo" is not
 * asking "is this on disk".
 */
let dirty = false

/**
 * Write the open document to disk. Awaitable, because the unsaved-edits prompt has to be able to save
 * *and then* continue with whatever the person was doing.
 *
 * Resolves `true` on success. A failed write resolves `false` rather than throwing, so a caller that was
 * about to replace the document does not replace it after a save that did not happen.
 */
const saveNow = async (): Promise<boolean> => {
  const root = docStack[0]?.doc
  if (root === undefined) return false
  if (live()) return true // every edit already reached the server; the file follows within a second
  if (readOnlyBy !== null) {
    setStatus(`not saved: ${fileState.name} is locked by ${readOnlyBy}`)
    return false
  }
  // The name may have changed since the file was opened (Save-as), or this may be a new file: the lock follows
  // what is about to be written. Refused means someone else has a file by that name open.
  const key = docLockKey()
  if (!heldLocks.has(key)) {
    const owner = await takeLock(key)
    if (owner !== null) {
      setStatus(`not saved: ${fileState.name} is locked by ${owner}`)
      return false
    }
  }
  // Saving writes the *file*, not whatever prefab is open on top of it, and the id follows the name. Letting
  // them drift is how content/levels ended up with three files all claiming "level1".
  root.setId(fileState.name)
  try {
    await saveFile('levels', fileState.name, stripHydrated(root.toJSON() as Level, hydratedPrefabs))
  } catch (e: unknown) {
    setStatus(`save failed: ${String(e)}`)
    return false
  }
  dirty = false
  setStatus(`saved ${fileState.name}`)
  previews.invalidate()
  await reloadAssets()
  await refreshFileList()
  refreshUi()
  return true
}

/**
 * May the open document be replaced? Asks first if it has edits that are not on disk.
 *
 * Every path that unloads a document goes through this: switching game, switching between levels and
 * prefabs, and opening another file. Nothing else may replace `docStack` — the undo history is cleared with
 * the document, so unsaved work is gone for good rather than one Ctrl+Z away.
 */
const guardUnsaved = async (): Promise<boolean> => {
  if (!dirty) return true
  const choice = await askUnsaved(fileState.name)
  if (choice === 'cancel') return false
  if (choice === 'discard') return true
  return saveNow()
}

/** The selection, by identity that survives renumbering — what an undo puts back. */
const selectionRefs = (): NodeRef[] => {
  const open = doc
  if (open === null) return []
  return selection.map((i) => open.refAt(i)).filter((r): r is NodeRef => r !== null)
}

/**
 * Record that an edit just happened: fold the batches the document reported since the last record into one
 * history entry. An edit that changed nothing reported nothing — the document drops an op whose inverse is
 * `null` — so a click on a gizmo handle, or picking the material a piece already had, records nothing, and
 * Ctrl+Z never needs pressing twice for one visible change.
 */
const recordEdit = (label: string): void => {
  if (coalescing) return
  const entry = foldBatches(pending, label, selectionRefs())
  pending = []
  if (entry === null) return
  history.push(entry)
  dirty = !live() // a live level is saved as it is edited
  renderStatus()
}

/** Start a fresh history: a different file's edits are not this one's. */
const resetHistory = (): void => {
  history.clear()
  pending = []
  dirty = false
}

/** The level every op applies to: the open file's. A prefab opened on top is one of its table entries. */
const rootLevel = (): Level | null => docStack[0]?.doc.asLevel() ?? null

/**
 * Apply a history entry's ops straight to the level — not through a document, so nothing is re-reported — then
 * rebuild everything from the data, as any structural edit does, and put the selection back by identity.
 * Resolves `false` when the ops no longer apply (the node is gone); the entry is dropped and the status bar
 * says why.
 */
const applyHistory = (ops: readonly Op[], keep: readonly NodeRef[], what: string): boolean => {
  const level = rootLevel()
  if (level === null) return false
  let applied: { ops: Op[]; inverses: Op[] }
  try {
    applied = applyBatch(level, ops)
  } catch (e) {
    setStatus(`cannot ${what}: ${e instanceof OpError ? e.message : String(e)}`)
    return false
  }
  // An undo is an edit like any other to the room.
  if (live() && applied.ops.length > 0) collab.submit(applied)
  pending = []
  deselect()
  installEnvironment(doc?.environment())
  buildItems()
  rebuildLoaded()
  const open = doc
  const restored = open === null ? [] : keep.map((r) => open.indexOfRef(r)).filter((i): i is number => i !== null)
  if (restored.length > 0) applySelection(restored)
  dirty = !live()
  refreshUi()
  inspectorRebuild()
  loadNewReferences(buildItems)
  return true
}

const undo = (): void => {
  const entry = history.undo()
  if (entry === null) {
    setStatus('nothing to undo')
    return
  }
  if (!applyHistory(entry.inverses, entry.selection, `undo ${entry.label}`)) {
    history.drop(entry)
    return
  }
  setStatus(`undid: ${entry.label}`)
}

const redo = (): void => {
  const entry = history.redo()
  if (entry === null) {
    setStatus('nothing to redo')
    return
  }
  if (!applyHistory(entry.ops, entry.selection, `redo ${entry.label}`)) {
    history.drop(entry)
    return
  }
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
  setKeySelection([])
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
  clip: () => {
    const id = openClipId()
    const entry = id === '' ? undefined : assets?.db.byId[id]
    return entry === undefined ? null : { id, name: entry.name }
  },
  saveAsClip,
  unlinkClip,
  selection: () => keySelection,
  setSelection: (indices) => {
    setKeySelection(indices)
    timeline.render()
  },
  recording: () => recording,
  setRecording: (on) => {
    recording = on
    // Not while previewing: the playhead is where a recorded key lands, so a moving playhead would scatter one
    // drag's worth of keys across the track.
    if (on && previewing) setPreviewing(false)
    timeline.render()
    renderStatus()
  },
  poseNow: () => (selected === null || doc === null ? null : doc.poseOf(selected, previewMs)),
  // The same grid the transform gizmo snaps to, in time: a 0.25 grid means quarter-second keys, which keeps
  // authored times round without a second setting to forget about.
  snapMs: () => (edit.snap ? edit.step * 1000 : 0),
  addKeyComponent: () => {
    addKeyComponent()
    // One key at rest, so the strip has something to show and the gizmo something to move. It holds the
    // object where it stands rather than baking its pose into the key, which is what offsets buy.
    if (keyTarget !== null && selected !== null && doc !== null) {
      setSelectedKeys(restKeys())
      setKeySelection([0])
    }
    setPreviewTime(0)
  },
  // Neither preset needs the item's pose any more: offsets are measured from rest, so the same keys are
  // correct for the object wherever it happens to be standing.
  applyMovePreset: (dir, distance, periodMs) => {
    if (selected === null || doc === null) return
    applyPreset(moveTrack(DIRS[dir] ?? vec3(0, 1, 0), distance, periodMs))
  },
  applySpinPreset: (dir, periodMs) => {
    if (selected === null || doc === null) return
    applyPreset(spinTrack(DIRS[dir] ?? vec3(0, 1, 0), periodMs))
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
      const owner = lockedAssets.get(id)
      if (owner !== undefined) {
        setStatus(`not saved: ${assets.db.byId[id]?.name ?? 'material'} is locked by ${owner}`)
        assetInspector.show(id)
        return
      }
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
    void saveGame(mode.name, next).then(
      () => setStatus(`${mode.label}: ${key} = ${Array.isArray(value) ? `${value.length} points` : value}`),
      (e: unknown) => setStatus(`settings save failed: ${String(e)}`),
    )
  },
  onModeChanged: () => {
    // The registry changed with the game, so everything derived from it is stale: the document's own registry,
    // the Add Component menu, the rule gizmos and the physics instance.
    activeMode = doc === null ? activeMode : (modeOf(doc.asLevel()) ?? soleMode())
    reopenWithRegistry()
    void refreshFileList()
  },
  boundsBoxShown: () => showBoundsBox,
  showBoundsBox: (on) => {
    showBoundsBox = on
    refreshBoundsBox()
  },
  onNetBoundsChanged: () => {
    refreshBoundsBox()
    recordEdit('network bounds')
    uiChanged()
  },
  boundsReach,
  /**
   * The header's active checkbox (ADR 0099, moved to the Inspector by ADR 0102). A structural change: what
   * the level contains just changed, so the physics world, the markers and the drawn items are all rebuilt,
   * exactly as a delete would.
   */
  onSetEnabled: (on) => {
    if (doc === null || selected === null) return
    doc.setNodeEnabled(selected, on)
    recordEdit(on ? 'enabled' : 'disabled')
    rebuildLoaded()
    buildItems()
    hierarchy.render()
    inspectorRebuild()
  },
  onEnvironmentChanged: () => {
    // Elevation and azimuth move the sky as well as the light, so this rebakes rather than just relighting.
    installEnvironment(doc?.environment())
    recordEdit('environment')
    uiChanged()
  },
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
    // No snapshot needed: an offset track's write-back is a subtraction, not a delta against the pose the
    // drag started from (ADR 0050), so a typed value lands the same way a dragged one does.
    g.position.set(t.position.x, t.position.y, t.position.z)
    const q = eulerToQuat(vec3(THREE.MathUtils.degToRad(t.rotationDeg.x), THREE.MathUtils.degToRad(t.rotationDeg.y), THREE.MathUtils.degToRad(t.rotationDeg.z)))
    g.quaternion.set(q.x, q.y, q.z, q.w)
    g.scale.set(t.scale.x, t.scale.y, t.scale.z)
    writeBackSelected()
    rebuildSubtreeMeshes(selected) // the scale may have changed, and the meshes are built from it
    recordEdit('transform')
    applyPreviewPoses() // the rest pose moved, so the item's drawn pose at the playhead moved with it
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
  saveAsPrefab: () => void (selected !== null && saveAsPrefab(selected)),
  openPrefab: () => {
    if (selected !== null) openPrefabOf(selected)
  },
  revertOverride,
  applyOverrides: () => void applyOverrides(),
  editKeys: (componentId, param) => {
    if (selected === null || doc === null) return
    keyTarget = doc.keyEditors(selected).find((e) => e.componentId === componentId && e.param === param) ?? null
    setKeySelection([])
    setPreviewTime(0)
    showBottomTab('timeline')
    timeline.render()
  },
  assetOptions: (of) => {
    const options: Record<string, string> = { '(none)': '' }
    // The built-in shapes (ADR 0090) sit in the model slot beside the uploaded files.
    if (of === 'model') for (const id of BUILTIN_MODELS) options[BUILTIN_LABELS[id]] = id
    const db = assets?.db
    if (db !== undefined) for (const a of assetsOfKind(db, of)) options[a.name] = a.id
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
  const parts: string[] = []
  if (me !== null) parts.push(`<b>${me.user.name}</b>`)
  parts.push(breadcrumb())
  if (readOnlyBy !== null) parts.push(`<span class="problem">read-only · locked by ${readOnlyBy}</span>`)
  if (live()) {
    const others = livePeers.filter((p) => p.connId !== collab.connId()).map((p) => p.name)
    parts.push(others.length === 0 ? 'live' : `live · with ${[...new Set(others)].join(', ')}`)
  }
  if (selected !== null && doc !== null) {
    parts.push(selection.length > 1 ? `${selection.length} selected · editing ${doc.label(selected)}` : `selected #${selected} (${doc.label(selected)})`)
  }
  // What the gizmo is about to move is not otherwise visible, and it is the difference between dragging one
  // key, dragging a whole path, and writing a new key where the playhead is.
  if (selectedKeys()?.length ?? 0) {
    const at = activeKey()
    const what = recording ? 'recording' : keySelection.length > 1 ? `${keySelection.length} keys` : at !== null ? `key ${at + 1}` : 'whole track'
    parts.push(`t=${(previewMs / 1000).toFixed(2)}s · ${what}`)
  }
  if (placing !== null) {
    const what = assets?.db.byId[placing.assetId]?.name ?? 'asset'
    parts.push(`click in the viewport to place <b>${what}</b>`)
  }
  // Undo depth in the status bar because nothing else says whether Ctrl+Z will do anything, and the answer
  // changes with every edit. The clipboard likewise: a paste that silently does nothing reads as broken.
  const depth = history.depth()
  if (depth.undo > 0 || depth.redo > 0) parts.push(`undo ${depth.undo}${depth.redo > 0 ? ` · redo ${depth.redo}` : ''}`)
  if (clipboard.length > 0) parts.push(`clipboard: ${clipboard.length} object${clipboard.length > 1 ? 's' : ''}`)
  if (statusMsg !== '') parts.push(statusMsg)
  if (problemMsg !== '') parts.push(`<span class="problem">${problemMsg}</span>`)
  if (pushProblem !== '') parts.push(`<span class="problem">not on GitHub yet: ${pushProblem}</span>`)
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
    // `stage.resize` only knows the perspective camera; this one is the editor's.
    if (isometric) syncOrthoFrustum((orthoCamera.top - orthoCamera.bottom) / 2)
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
stage.start((dt) => {
  updateHoldHelpers()
  if (playing && controller !== null && loaded !== null) {
    // Interpolate clock-driven pieces + the character between the last two sim ticks (same
    // timeline as the game), then place the player camera (mouselook orbit) around the character.
    const alpha = Math.min(1, Math.max(0, (performance.now() - lastSimTickAt) / (1000 / TICK_RATE_HZ)))
    loaded.render(alpha)
    playView?.sync()
    playLights?.sync()
    ownPos = controller.renderPositions().get(PLAYER_ID) ?? ownPos
    charMesh.position.set(ownPos.x, ownPos.y, ownPos.z)
    // The camera places itself around the capsule's centre and reports whether we are inside our own rig;
    // `setOccluders` is what puts the hole in whatever is in the way.
    const { rigVisible } = playCamera.update(dt, ownPos, (handles) => playView?.setOccluders(handles))
    charMesh.visible = rigVisible
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
    viewGizmo.update(dt)
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
applySnap()
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
        if (readOnlyBy !== null) setStatus(`${fileState.name} is now read-only: ${readOnlyBy} took it while this tab was away`)
        refreshUi()
      }
    }
    if (live()) collab.ping() // the server drops a connection it has not heard from, holds included
    const status = await serverStatus().catch(() => null)
    const next = status?.pushError ?? ''
    if (next !== pushProblem) {
      pushProblem = next
      renderStatus()
    }
  })()
}, me?.heartbeatMs ?? 30_000)

// A closing tab lets go of its locks at once rather than waiting out the stale window.
window.addEventListener('pagehide', () => {
  for (const p of heldLocks) releaseLockBeacon(p)
  collab.beaconLeave()
})

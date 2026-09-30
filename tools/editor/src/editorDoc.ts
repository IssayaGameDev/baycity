import {
  bakeOverrides,
  childrenFor,
  boolParam,
  effectiveNode,
  modelOf,
  numberParam,
  vec3Param,
  stringParam,
  COLLIDER,
  LIGHT,
  MATERIAL_OVERRIDE,
  RENDERER,
  AT_REST_POSE,
  SELF,
  SEQUENCE,
  UNMOVED,
  channelsOf,
  combineSequences,
  compileSequence,
  sampleSequence,
  sequenceOf,
  type CompiledSequence,
  diffStages,
  readStages,
  retargetSequenceOverride,
  retargetSequenceParams,
  type Stage,
  type SequenceAxes,
  type SequenceOverride,
  type ColliderDesc,
  type ComponentData,
  type Node,
  type Level,
  type NodeOverride,
  type EnvironmentConfig,
  type ModeRef,
  type Transform,
  applyBatch,
  type NodeRef,
  type Op,
  isBuiltinModel,
  unitColliderFor,
  PRIMITIVE_ORDER,
  PRIMITIVE_PRESETS,
  type BuiltinModel,
  type PrimitiveKind,
  unlinkedNode,
  childListsOf,
  forEachNode,
  overrideFieldsSet,
} from '@mp/content'
import { DEFAULT_REGISTRY, type Registry } from '@mp/components'
import type { LightDesc } from '@mp/render-three'
import { eulerToQuat, mulQuat, quat, vec3, type Quat, type Vec3 } from '@mp/core'

import { routeSteps, type MoveStep } from './sequencePoints'

/**
 * Editor document abstraction, over a **node tree** (PLAN-component-system, stage C1).
 *
 * One node type replaced `Piece` and `PrefabInstance`, and the whole instance-versus-piece split went with
 * it. What is left is a single distinction that is about *ownership* rather than about kind: a node is either
 * **own** (this document authored it, so edits write straight to it) or **inherited** (it belongs to a prefab
 * this placement references, so edits become overrides on the placement). Everything a node has — collider,
 * visual, motion, gameplay rule — is a component in a list, added and removed like Unity's.
 *
 * **Nodes are addressed by depth-first index**, recomputed per call. A cache kept between calls would have to be
 * invalidated by every mutation, including one made through the level object rather than through this doc, and
 * the day it missed, an index would silently address the wrong node. **Except inside `reading`**: a synchronous
 * pass that only reads — a redraw, a panel — walks once and holds it; a commit inside drops it, and nothing else
 * can change the level in the middle of one. Levels have hundreds of nodes now, and a redraw asking about each of
 * them re-walked the tree each time: 430 ms of a collaborator's edit on a 395-node level (ADR 0167). Indices shift
 * when the tree changes, which is safe because every structural edit rebuilds the meshes, the physics world and
 * the panels; the mutating calls return where the node landed.
 *
 * Order per node: the node, then what it inherits from its prefab, then its own children. Inherited first
 * because they are what the object *is*; a child is something placed on it.
 */
export type Mode = 'level' | 'prefab'

/**
 * Whether this document owns the node or inherits it from a prefab.
 *
 * Every operation works on both (ADR 0151). What differs is where it lands: on an own node, the node; on an
 * inherited one, this placement's record — its contents as overrides, its removal, its order among its
 * siblings, the children added under it.
 */
export type NodeKind = 'own' | 'inherited'

/** One mesh to draw under a node's group. `transform` is the collider's own offset within it. */
export interface MeshSpec {
  collider: ColliderDesc
  transform: Transform
  name: string | undefined
  /** Model asset id — drawn instead of a collider shape. */
  model: string | undefined
  /** Material asset id — absent means unsurfaced, which the viewport greyboxes. */
  material: string | undefined
}

/** A component as the Inspector shows it: its values, plus what this placement has changed about it. */
export interface ComponentView {
  id: string
  type: string
  params: Record<string, unknown>
  enabled: boolean
  /** From the prefab rather than from this placement — so editing it writes an override. */
  inherited: boolean
  /** Added by this placement onto an inherited node. */
  added: boolean
  /** Parameter keys this placement overrides, plus `'enabled'` when it has been switched here. */
  overridden: string[]
}

/**
 * A detached copy of a node and its subtree, plus **the prefab definitions it references**.
 *
 * Carrying the definitions is what makes paste work at all: a placement names a prefab by a key into the
 * *source* level's table, so the node alone would paste into another level as a dangling reference. With the
 * definitions along for the ride, a paste is self-contained — any key the clipboard names is interned into
 * the destination if it is not already there.
 */
export interface ClipItem {
  readonly node: Node
  readonly prefabs: Record<string, Node>
}

/**
 * Component types in a node tree that a registry does not know (ADR 0076).
 *
 * A level is validated against **its game's** registry, and a prefab file is written against whichever game
 * happened to be open when it was authored. Placing one into a level for a game that lacks a type it uses
 * produces a level the game refuses to load — the editor has to say so *before* placing, not the game after.
 */
export const unknownComponentTypes = (root: Node, registry: Registry): string[] =>
  componentTypesIn(root).filter((type) => !registry.has(type))

/** Every component type in a node tree, once each, sorted. */
export const componentTypesIn = (root: Node): string[] => {
  const seen = new Set<string>()
  // Every node, and every component a placement added to one of its pieces (ADR 0151).
  forEachNode([root], (n) => {
    for (const c of n.components) seen.add(c.type)
    for (const over of Object.values(n.overrides ?? {})) for (const c of over.added ?? []) seen.add(c.type)
  })
  return [...seen].sort()
}

/**
 * Every component type an **unvalidated** level file uses — its nodes and its prefab table — once each, sorted.
 *
 * Tolerant of shape, because it runs *before* validation: this is how the editor learns which shared components
 * a level needs so it can add them to the game and then validate (ADR 0077). Anything not shaped like a node is
 * skipped rather than thrown on; validation will say what is wrong with it.
 */
export const componentTypesInRaw = (data: unknown): string[] => {
  const seen = new Set<string>()
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
  const types = (list: unknown): void => {
    if (Array.isArray(list)) for (const c of list) if (isObj(c) && typeof c['type'] === 'string') seen.add(c['type'])
  }
  const walk = (n: unknown): void => {
    if (!isObj(n)) return
    types(n['components'])
    if (Array.isArray(n['children'])) for (const kid of n['children']) walk(kid)
    // What a placement added to its pieces, components and children alike (ADR 0151).
    if (isObj(n['overrides'])) {
      for (const over of Object.values(n['overrides'])) {
        if (!isObj(over)) continue
        types(over['added'])
        if (Array.isArray(over['addedChildren'])) for (const kid of over['addedChildren']) walk(kid)
      }
    }
  }
  if (isObj(data)) {
    if (Array.isArray(data['nodes'])) for (const n of data['nodes']) walk(n)
    if (isObj(data['prefabs'])) for (const root of Object.values(data['prefabs'])) walk(root)
  }
  return [...seen].sort()
}

/** What one edit did, as data: the ops that changed something, and the ops that undo them in undo order (ADR 0089). */
export interface OpBatch {
  ops: Op[]
  inverses: Op[]
}

export interface Doc {
  readonly mode: Mode
  /** Every component type this build knows, for the add menu. */
  readonly registry: Registry
  /**
   * Every mutation below is applied through `applyBatch` and reported here (ADR 0089). The host records the
   * batch for undo and, live, sends it to the server. `null` until the host attaches; the edit still applies.
   */
  onOps: ((batch: OpBatch) => void) | null
  /** The wire identity of index `i` — stable across renumbering, unlike the index — or `null` past the end. */
  refAt: (i: number) => NodeRef | null
  /** Where a ref is now, or `null` when the node is gone (someone removed it) or is not in this document. */
  indexOfRef: (ref: NodeRef) => number | null
  /**
   * Run a pass that only reads — a redraw, a panel — walking the tree once for all of it (ADR 0167). Outside one,
   * every lookup by index walks the whole level, so a pass asking about each of N objects walked it N times. A
   * commit inside drops what it held; nested passes share it.
   */
  reading: <T>(read: () => T) => T
  count: () => number
  kindOf: (i: number) => NodeKind
  transformOf: (i: number) => Transform
  /**
   * Replace a node's local transform. Absent `rotation`/`scale` are **removed**, which is how a clean file
   * stays clean. A setter rather than mutating what `transformOf` returns, because for an inherited node the
   * two are different objects: reading gives the prefab's value, writing creates the placement's own.
   */
  setTransform: (i: number, t: Transform) => void
  meshSpecs: (i: number) => MeshSpec[]
  /**
   * The node's light, or `undefined` (ADR 0047). Position is deliberately absent: the caller parents the light
   * into the node's own group, which already carries its transform.
   */
  lightSpec: (i: number) => LightDesc | undefined
  /**
   * Place a primitive by name under a prefab's root — what the prefab palette offers. `-1` in a level, where a
   * primitive is placed by `placePrimitive` and a prefab by `placePrefab` (ADR 0091).
   */
  placeNamed: (name: string, position: Vec3) => number
  /**
   * Place a model asset: a node with the mesh as its `Visual` and an authored box as its `Collider`. Visual is
   * not collision (ADR 0014), so a detailed prop collides as a shape somebody can see and resize.
   */
  placeModel: (assetId: string, position: Vec3) => number
  /**
   * Place a prefab **by asset id** (ADR 0091): the level gets a reference, never a copy, so editing the prefab
   * reaches this placement and every other. `root` is the definition, used to resolve the reference locally
   * and to refuse a prefab this game cannot load — it is not stored in the level.
   *
   * In prefab mode there is no reference to make: a prefab holds nodes, never prefabs, so its children are
   * copied in with fresh ids.
   */
  placePrefab: (assetId: string, root: Node, position: Vec3) => number
  /**
   * A node with only a transform — Unity's Create Empty.
   *
   * `parent` is a node to put it under, or `null` for the top level (the prefab's root, in prefab mode). It is
   * the only thing here that makes a *grouping handle*: everything else places geometry, so before this the
   * only way to get one was to place something and delete its components.
   */
  placeEmpty: (position: Vec3, parent: number | null) => number
  /**
   * A built-in shape at its preset scale (ADR 0090): unit collider, `Mesh` on the built-in, unsurfaced
   * `Renderer`. Same parent rule as `placeEmpty`.
   */
  placePrimitive: (kind: PrimitiveKind, position: Vec3, parent: number | null) => number
  /** The built-in shape this node draws, or `null` — when set, its colliders are locked to the unit shape. */
  builtinOf: (i: number) => BuiltinModel | null
  remove: (i: number) => void
  duplicate: (i: number) => number
  /** Display name: the typed name if there is one, else what the node is made of. */
  label: (i: number) => string
  /** The *typed* name, empty when none — so the field can show the fallback as a placeholder. */
  nameOf: (i: number) => string
  setName: (i: number, name: string) => void
  /**
   * Reorder within the node's own sibling list: put it *before* what was sibling index `to`. Order is not
   * cosmetic — checkpoint progression follows it, and so does the movement-base index a rider replicates
   * (ADR 0021). Returns the node's new depth-first index.
   */
  move: (from: number, to: number) => number
  depthOf: (i: number) => number
  parentOf: (i: number) => number | null
  siblingIndexOf: (i: number) => number
  /** Sibling path from the root — a key for per-row UI state that survives edits elsewhere in the tree. */
  pathOf: (i: number) => string
  childCount: (i: number) => number
  canReparent: (from: number, parent: number | null) => boolean
  /**
   * Move a node to a new parent, optionally re-expressing its transform in that parent's frame.
   *
   * **`transform` goes in the same batch as the move** (ADR 0113). A reparent is one edit: preserving the
   * world pose means the stored local numbers must change, and if that change is a second commit it lands in
   * the *next* history entry — so one Ctrl+Z restores the parent link while leaving the transform behind, or
   * restores a transform belonging to a reparent two edits ago. Peers see one message rather than a move
   * followed by a correction.
   */
  reparent: (from: number, parent: number | null, at: number, transform?: Transform) => number
  /** Assets every node in the document references — what to preload before drawing it. */
  assetIds: () => string[]

  // ---- components ---------------------------------------------------------------------------------
  /** Every component on the node, resolved, in order. */
  components: (i: number) => ComponentView[]
  /** Whether this type may be added here — false for a singleton the node already has. */
  canAdd: (i: number, type: string) => boolean
  /** Add a component at its declared defaults. Returns its id, or `null` if it was refused. */
  addComponent: (i: number, type: string) => string | null
  /** Remove it. On an inherited node this records a removal rather than touching the prefab. */
  removeComponent: (i: number, componentId: string) => void
  /** Patch some of a component's parameters, leaving the rest. */
  setParams: (i: number, componentId: string, patch: Record<string, unknown>) => void
  /**
   * A `Sequence`'s stages, as the person now sees them (ADR 0139). On a node of this document it is a params
   * write; on a prefab's piece, or a placement's inherited root, the difference from the prefab is worked out
   * (`diffStages`) and recorded whole, so the placement keeps following its prefab everywhere else.
   */
  setSequenceStages: (i: number, componentId: string, stages: readonly Stage[]) => void
  /**
   * Several of one node's sequences at once, as **one** commit — a step dragged from one sequence into another
   * is one edit and one Ctrl+Z, not two.
   */
  setSequencesStages: (i: number, changes: readonly { readonly componentId: string; readonly stages: readonly Stage[] }[]) => void
  /**
   * The node's direct children, by the id a step's `target` names them with (ADR 0137) — for the target
   * picker, and for saying a target is gone. Inherited children answer with their prefab ids, which is what a
   * prefab's own sequence aims at.
   */
  childTargets: (i: number) => { readonly id: string; readonly label: string }[]
  /**
   * How this placement's copy of an inherited `Sequence` differs from the prefab's (ADR 0139), or `undefined`
   * when it does not — what the Inspector marks steps and counts overrides from (ADR 0143).
   */
  sequenceOverrideOf: (i: number, componentId: string) => SequenceOverride | undefined
  /**
   * Every sequence that moves node `i`, with its move steps in play order (ADR 0144): its own sequences' steps
   * aimed at itself, and its parent's aimed at it by id — the loader's rule (ADR 0141). A switched-off sequence
   * moves nothing and is left out, as is one with no move for it.
   */
  routesAt: (i: number) => readonly SequenceRoute[]
  /** The node a step on node `i` aims at: `i` itself for `SELF`, else its direct child of that id; `null` when there is none. */
  stepTargetOf: (i: number, target: string) => number | null
  /**
   * The same patch on several nodes at once, as **one** commit — so it is one undo entry and one message to
   * the room (ADR 0112). `targets` pairs each node with its own component id, since ids are per component.
   *
   * A function gives each target its own patch. A patch replaces a parameter whole, so one axis of a vec3
   * written to nodes that disagree about the others is that axis over **each node's own** value; one `{ y }`
   * for all of them would drop their x and z.
   */
  setParamsAcross: <T extends { at: number; componentId: string }>(targets: readonly T[], patch: Record<string, unknown> | ((target: T) => Record<string, unknown>)) => void
  setComponentEnabled: (i: number, componentId: string, on: boolean) => void
  /**
   * Is this node built at all (ADR 0099)? `false` means it and everything under it is absent from the level,
   * in the editor and in the game.
   *
   * Resolved, so a placement reports its own answer where it has one and the prefab root's otherwise, and an
   * inherited node reports what this placement's override says.
   */
  nodeEnabled: (i: number) => boolean
  /** Switch a node and its subtree off, or back on. An override when the node is inherited. */
  setNodeEnabled: (i: number, on: boolean) => void
  /** `true` when an **ancestor** is switched off, so this node is absent whatever its own flag says. */
  disabledByAncestor: (i: number) => boolean
  /**
   * Move a component one place up or down its node's list.
   *
   * Order is not cosmetic: it is the order hooks run in (ADR 0036) and the order several colliders draw in.
   * Refused on an inherited node — the list belongs to the prefab, and a reordering is not something a
   * per-placement override can express.
   */
  moveComponent: (i: number, componentId: string, delta: number) => void
  /**
   * Nodes a `nodeRef` on this node may point at, in tree order (stage C4).
   *
   * **Scoped, not everything.** A reference is stored where the node is authored: one on an own node lands in
   * the level, one authored inside a prefab lands in the prefab file — so offering a level node to a node
   * inside a prefab would author a reference that dangles in every other level the prefab is used in. An
   * inherited node gets both, because a reference set *there* is an override and lives in the level.
   */
  nodeChoices: (i: number) => readonly { readonly id: string; readonly label: string }[]
  /**
   * The value a `nodeRef` on node `i` stores to point at node `j` — `j`'s id — or `null` when `j` is out of its
   * reach, by the rule `nodeChoices` lists by (ADR 0176). By index, not id: two placements of one prefab carry the
   * same piece ids, and a drag names the row it was.
   */
  refTo: (i: number, j: number) => string | null
  /** Where a `nodeRef` on node `i` holding `id` points: its own placement's piece first, then the level's. */
  refTarget: (i: number, id: string) => number | null

  // ---- prefab overrides ---------------------------------------------------------------------------
  /** What this placement changes about the node, in a stable order. Empty for an own node. */
  overridesOf: (i: number) => string[]
  /**
   * Drop one override — `'transform'`, `'name'`, or a component id — or all of them, so the node goes back
   * to what the prefab says.
   */
  revert: (i: number, field?: string) => void
  /**
   * The ops that would push this placement's overrides into the shared prefab, and which prefab (ADR 0091).
   * Pure: a prefab is its own live document, so its ops are the host's to send there, and this document only
   * clears the override afterwards with `revert`.
   */
  overrideOpsFor: (i: number) => { assetId: string; ops: Op[] } | null
  /**
   * Every piece of the placement at `i` that carries an override, and what each one overrides.
   *
   * The placement **root** holds no override of its own and never will: its transform is its own, and an
   * override is by definition a difference from the prefab, which only the inherited pieces have. So the
   * root's answer to "has anything changed here" has to be asked of its pieces, which is what this does —
   * Unity's Revert All / Apply All on an instance root. Empty for a node that is not a placement.
   *
   * Only pieces owned by **this** placement: a prefab containing a placement of another prefab has pieces
   * owned by that inner one, and those belong to it.
   */
  placementOverrides: (i: number) => { index: number; fields: string[] }[]
  /**
   * Children this level has added under a placement or any of its pieces — Unity's *Added GameObject*
   * (ADR 0130, ADR 0135): the roots of what the placement's records add, and whatever ADR 0130 kept on the
   * placement's own node. Counted beside the overrides, by the menus and the Inspector strip.
   *
   * Roots only. A child of an added child travels inside it and is not its own entry. A child that is itself
   * a **placement** is excluded: inserting one into a prefab means a prefab referencing a prefab, whose
   * definition would have to resolve in the prefab's own room (ADR 0124), and that is not built.
   */
  /**
   * Prefab node ids this placement does without (ADR 0133) — Unity's removed GameObject.
   *
   * Read off the placement's override records rather than the tree, because a removed piece is not in the
   * tree and has no index to ask about. Carried by the placement-scope Revert and Apply like the rest.
   */
  placementRemoved: (i: number) => string[]
  placementAdded: (i: number) => number[]
  /**
   * Make a placement look like its prefab (ADR 0151): every record cleared — what it changed, what it removed,
   * the order it kept and the children it added under a piece — and what ADR 0130 kept on its own node taken
   * off. One batch: one undo entry, one message to the room.
   */
  revertPlacement: (i: number) => void
  /**
   * Everything a placement records, as one batch of ops for the prefab's own document (ADR 0091): removals,
   * then each record's fields, added children (fresh ids, a prefab's being its own) and order.
   */
  placementOverrideOps: (i: number) => { assetId: string; ops: Op[] } | null

  // ---- motion -------------------------------------------------------------------------------------
  /**
   * The node's local pose at a level time, with its sequences when `sequences` is set (ADR 0141) — its own
   * aimed at it and its parent's aimed at it — and its authored transform otherwise.
   *
   * What the viewport draws while previewing. The same composition the loader does, because anything shown
   * here has to be what the game builds. `posesAt(t)[i]`, so the two cannot disagree.
   */
  poseOf: (i: number, timeMs: number, opts?: { readonly sequences?: boolean }) => PreviewPose
  /**
   * Every node's pose at a level time, in document order — `poseOf` for the whole tree, in **one** walk
   * (ADR 0125).
   *
   * What the preview clock needs sixty times a second. Asking `poseOf` per index instead costs four full
   * document walks per node: `nodes()` is recomputed per call outside `reading` (see the note at the top of this
   * file). Quadratic, on a level with hundreds of platforms, per frame.
   *
   * Here the list is walked once and each parent's accumulated rotation and scale are carried **down** — a
   * depth-first list puts a parent before its children, so its accumulation is always ready. `nodes()` is called
   * once rather than made to persist.
   */
  posesAt: (timeMs: number, opts?: { readonly sequences?: boolean }) => PreviewPose[]
  /** Whether a sequence moves this node — its own, or its parent's aimed at it: whether previewing shows it move. */
  movesAt: (i: number) => boolean
  /**
   * Whether a sequence can fade this node — its own aimed at it, or its parent's (ADR 0141). The viewport gives
   * such a node its own material copies, as the game does, so fading it fades nothing else.
   */
  fadesAt: (i: number) => boolean

  // ---- clipboard, references, files ---------------------------------------------------------------
  copy: (i: number) => ClipItem | null
  paste: (item: ClipItem, parent: number | null) => number
  /** The prefab **asset id** this node references, or `null` (ADR 0091). */
  refOf: (i: number) => string | null
  /**
   * The prefab this node would become: its components and children at the origin. Pure — nothing is written
   * and no op is reported, because the definition becomes a **file**, which is the host's to write. `null`
   * when the node is inherited, already a placement, or this document is a prefab.
   */
  definitionOf: (i: number) => Node | null
  /**
   * Point a node at a prefab asset: its own components go, its transform and name stay, and it inherits the
   * definition. One op, invertible, so the whole action is one undo step. `false` when it could not apply.
   */
  linkToPrefab: (i: number, assetId: string, root: Node) => boolean
  /** The definition behind an asset id, as this document resolved it — the object every placement reads. */
  prefabAt: (id: string) => Node | undefined
  /** How many placements in **this level** reference `id`. A prefab is shared across levels the editor cannot see. */
  refCount: (id: string) => number
  /**
   * Turn every placement of `id` into plain nodes keeping what they were drawing, and report how many
   * (ADR 0097). What deleting a prefab does to the level using it.
   *
   * Ops, so it is one undo and it reaches everyone in the room — which is also why the **open** level is
   * unlinked through here while the closed ones go through the files API.
   */
  unlinkPrefab: (id: string) => number
  /**
   * Turn **one** placement into a plain node keeping what it was drawing, and report whether it did
   * (ADR 0111). The prefab file and every other placement of it are untouched.
   *
   * One op, so it is one undo and it reaches everyone in the room, like every other edit.
   */
  unlinkNode: (i: number) => boolean
  /** A level to instantiate for spawn gizmos and physics (prefab mode → wrapped at the origin). */
  asLevel: () => Level
  toJSON: () => Level | Node
  /**
   * The level's sun (ADR 0048), or `undefined` when it has none and the renderer's defaults apply.
   *
   * A level setting rather than a node, because the sun and the sky are one input (ADR 0046). In prefab mode
   * this reads the throwaway wrapper's config, so it is always `undefined` and setting it is a no-op — a prefab
   * has no sun of its own.
   */
  environment: () => Partial<EnvironmentConfig> | undefined
  setEnvironment: (env: Partial<EnvironmentConfig>) => void
  /**
   * How far this level reaches on the wire, in metres from the origin (ADR 0093), or `undefined` for the
   * platform default. A prefab has none, for the same reason it has no sun.
   */
  netBounds: () => number | undefined
  /** Set the level's own bound, or clear it back to the default. */
  setNetBounds: (metres: number | null) => void
  /**
   * Whether the game camera sees through what is in its way on this level, or is stopped by it (ADR 0148).
   * `false` for a prefab, which has no camera of its own; setting it there is a no-op.
   */
  cameraSeeThrough: () => boolean
  setCameraSeeThrough: (on: boolean) => void
  /**
   * Which game this level is for (ADR 0052). `undefined` for an unassigned level, and always for a prefab —
   * a prefab belongs to no game.
   */
  modeRef: () => ModeRef | undefined
  /** Reassign the level to a game, or to none. */
  setMode: (name: string | null) => void
  /** Save writes under a file name; the id follows it, or the two silently diverge. */
  setId: (id: string) => void
}

/** A node's local pose: its authored transform with whatever is moving it applied. */
export interface LocalPose {
  readonly position: Vec3
  readonly rotation: Vec3
}

/**
 * A node as the preview draws it (ADR 0141). `rotation` is the authored euler; a sequence's turn goes on top
 * of it, inside the node, as `turn`. `scale` is the local scale now — authored, times a
 * sequence's. `shown` is `false` while a sequence has it disabled, or one above it.
 */
export interface PreviewPose extends LocalPose {
  readonly turn: Quat
  readonly scale: Vec3
  readonly opacity: number
  readonly shown: boolean
}

/** One sequence's moves of one node, as the viewport draws its route (ADR 0144). */
export interface SequenceRoute {
  /** The node the sequence is on: the one it moves, or that one's parent. */
  readonly holder: number
  readonly componentId: string
  readonly axes: SequenceAxes
  readonly steps: readonly MoveStep[]
}

/**
 * Eight hex characters from `crypto`, the same shape the asset importer mints: short enough to read in a
 * diff, long enough that two never collide within one tree.
 */
const freshId = (): string => {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 }

/** Primitive nodes for prefab mode. Only shapes the physics loader supports (no cylinder). */
/** A built-in shape as a node (ADR 0090): unit collider, an unsurfaced Mesh Renderer drawing it (ADR 0153), the preset scale. */
const primitiveNode = (kind: PrimitiveKind, position: Vec3, name: string = kind): Node => {
  const preset = PRIMITIVE_PRESETS[kind]
  const one = preset.scale.x === 1 && preset.scale.y === 1 && preset.scale.z === 1
  return {
    id: freshId(),
    name,
    transform: { position, ...(one ? {} : { scale: { ...preset.scale } }) },
    components: [component(COLLIDER, { shape: unitColliderFor(preset.model), center: ZERO }), component(RENDERER, { model: preset.model, material: '' })],
  }
}
const isPrimitiveKind = (name: string): name is PrimitiveKind => (PRIMITIVE_ORDER as readonly string[]).includes(name)

const component = (type: string, params: Record<string, unknown>): ComponentData => ({ id: freshId(), type, params })

/** The type of the component with this id, anywhere in a tree. What an override patch names but does not say. */
const typeOfComponent = (root: Node, componentId: string): string | undefined => {
  const here = root.components.find((c) => c.id === componentId)
  if (here !== undefined) return here.type
  for (const kid of root.children ?? []) {
    const found = typeOfComponent(kid, componentId)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * A solid, visible node — what placing a primitive or a model produces.
 *
 * What it collides as, then what it draws: `model` given, the Mesh Renderer draws it; omitted, it draws the
 * collider shape (ADR 0153).
 */
const solidNode = (shape: ColliderDesc, transform: Transform, name?: string, model?: string): Node => ({
  id: freshId(),
  ...(name !== undefined ? { name } : {}),
  transform,
  components: [
    component(COLLIDER, { shape, center: ZERO }),
    component(RENDERER, { model: model ?? '', material: '' }),
  ],
})

/**
 * Where an item at `from` lands when dropped *before* the original index `to`, in an array of `length`. `to` is
 * expressed against the array as it was, which is what a drop between two rows naturally gives you — hence the
 * shift when moving downward, where removing the item first pulls every later index back by one.
 */
const moveTarget = (length: number, from: number, to: number): number => {
  if (from < 0 || from >= length || from === to) return from
  return Math.max(0, Math.min(length - 1, to > from ? to - 1 : to))
}

/** One addressable node, and everything needed to read it and to write it back. */
interface DocNode {
  /** The node's contents with overrides applied — what the panels show. */
  view: Node
  /** The object a write lands on for an **own** node, and the prefab's own object for an inherited one. */
  authored: Node
  /** The placement carrying the overrides, when this node is inherited. */
  owner: Node | undefined
  /** The array `authored` lives in — `undefined` for an inherited node, whose place belongs to the prefab. */
  siblings: Node[] | undefined
  /** Where `authored` is in `siblings`, or a piece among its prefab siblings — a **storage** position. */
  index: number
  /**
   * Where it is **shown** among its siblings (ADR 0151). Not `index`: under a placement or a piece, inherited
   * and added children are stored in different lists but shown in one, and a drop between two rows means a
   * place in the one shown.
   */
  slot: number
  parent: number
  depth: number
  path: string
}

/**
 * The core, shared by both modes.
 *
 * `roots` is the forest this document edits: a level's `nodes`, or the one root node of a prefab. Prefab mode
 * is a level of one node with no table, which is why there is one implementation here where there used to be
 * two — the operations differ only in what the palette offers and in whether references exist at all.
 */
const docOver = (
  level: Level,
  opts: { mode: Mode; registry: Registry; json: () => Level | Node; table?: string },
): Doc => {
  const { mode, registry } = opts
  const roots = level.nodes
  /**
   * Every mutation goes through here (ADR 0089): the ops apply to this document's level through the one shared
   * `applyBatch`, no-op edits fall out (their inverse is `null`), and what changed is reported to the host —
   * stamped with the prefab table key when this document is a prefab opened on top of a level, so the same ops
   * apply to the level's `prefabs[key]` on every other copy. Applying here is unscoped: the wrapper's one root
   * *is* that table entry.
   */
  const table_ = opts.table
  const stamp = (op: Op): Op => (table_ === undefined || op.table !== undefined ? op : { ...op, table: table_ })
  const commit = (ops: readonly Op[]): void => {
    if (ops.length === 0) return
    const r = applyBatch(level, ops)
    held = null
    if (r.ops.length === 0) return
    self.onOps?.({ ops: r.ops.map(stamp), inverses: r.inverses.map(stamp) })
  }

  /** The walked tree while a `reading` pass is on, and how many passes are: nothing is held outside one. */
  let held: DocNode[] | null = null
  let readers = 0
  const nodes = (): DocNode[] => (readers > 0 ? (held ??= walk()) : walk())
  const reading = <T,>(read: () => T): T => {
    readers++
    try {
      return read()
    } finally {
      if (--readers === 0) held = null
    }
  }

  const walk = (): DocNode[] => {
    const out: DocNode[] = []
    const push = (authored: Node, owner: Node | undefined, siblings: Node[] | undefined, index: number, slot: number, parent: number, depth: number, path: string): void => {
      const self = out.length
      // A placement resolves against its prefab; an inherited node only needs its own patch applied. Both
      // land on the same shape, so nothing downstream asks which it was.
      let view: Node
      if (owner === undefined) {
        const r = effectiveNode(level, authored, registry)
        view = {
          id: r.id,
          ...(r.name !== undefined ? { name: r.name } : {}),
          ...(r.enabled !== undefined ? { enabled: r.enabled } : {}),
          transform: r.transform,
          components: [...r.components],
        }
      } else {
        view = bakeOverrides(authored, owner.overrides)
      }
      out.push({ view, authored, owner, siblings, index, slot, parent, depth, path })

      /**
       * What a placement shows under a piece (ADR 0135): the prefab's children minus the removed, plus the
       * ones this placement added, in this placement's order. `childrenFor` is the same function the loader
       * bakes with, so the editor and the game agree by construction.
       *
       * An **added** child is pushed with no `owner` and with its `addedChildren` array as its siblings, so
       * `own()` accepts it and every structural operation works on it unchanged — it is an ordinary
       * authored node that happens to live in an override record.
       */
      let shown = 0
      const showChildren = (source: Node, placement: Node): void => {
        const over = placement.overrides?.[source.id]
        const added = over?.addedChildren
        const kids = childrenFor(source, over, placement.overrides) ?? []
        kids.forEach((kid, k) => {
          const at = added?.indexOf(kid) ?? -1
          if (at >= 0) push(kid, undefined, added, at, k, self, depth + 1, `${path}+${k}`)
          else push(kid, placement, undefined, k, k, self, depth + 1, `${path}#${k}`)
        })
        shown = kids.length
      }
      const ref = owner === undefined ? authored.prefab : undefined
      if (ref !== undefined) {
        // Inherited: the prefab's own child objects, so a write can reach the definition.
        const root = level.prefabs?.[ref]
        if (root !== undefined) showChildren(root, authored)
      } else if (owner !== undefined) {
        showChildren(authored, owner)
      }
      if (owner === undefined) {
        const own = authored.children
        // Under a placement, what ADR 0130 kept on the placement itself is shown after the rest.
        if (own !== undefined) own.forEach((kid, k) => push(kid, undefined, own, k, shown + k, self, depth + 1, `${path}/${k}`))
      }
    }
    roots.forEach((n, index) => push(n, undefined, roots, index, index, -1, 0, String(index)))
    return out
  }

  const node = (i: number): DocNode | undefined => nodes()[i]
  /**
   * Whether a `nodeRef` on `n` may name `o` (stage C4): an own node names own nodes, and a placement's piece its own
   * placement's pieces or the level's — a reference authored inside a prefab must not dangle in its other levels.
   */
  const reaches = (n: DocNode, o: DocNode): boolean => (n.owner === undefined ? o.owner === undefined : o.owner === n.owner || o.owner === undefined)

  /**
   * Compiled sequences, keyed by what they say rather than by object: the Inspector patches a component's
   * params in place, so an identity key would hand back a sequence as it was before the edit. Bounded, since
   * every edit of a sequence makes a new key.
   */
  const compiled = new Map<string, CompiledSequence>()
  const sequencesOn = (components: readonly ComponentData[]): CompiledSequence[] =>
    components
      .filter((c) => c.type === SEQUENCE && c.enabled !== false)
      .map((c) => {
        const data = sequenceOf(c)
        const key = JSON.stringify(data)
        let hit = compiled.get(key)
        if (hit === undefined) {
          if (compiled.size > 512) compiled.clear()
          hit = compileSequence(data)
          compiled.set(key, hit)
        }
        return hit
      })

  /**
   * Own nodes only, for the structural operations.
   *
   * In prefab mode the root is refused as well: it *is* the document, so deleting or duplicating it would
   * either empty the file or turn it into two prefabs in one.
   */
  const own = (i: number): DocNode | undefined => {
    if (mode === 'prefab' && i === 0) return undefined
    const n = node(i)
    return n?.owner === undefined ? n : undefined
  }
  /** An own node by id. Ids are unique per tree, and an inserted op clones its node, so identity is the id. */
  /**
   * Where the children a node shows are kept (ADR 0151) — **the one door every structural edit goes through**.
   *
   * A plain list, for an object of the level (its `children`) and for the level itself (its forest). Or a
   * **record**, for a placement and for each of its pieces: the prefab's children there, minus what this
   * placement removed, plus what it added under that piece, in the order it recorded (`childrenFor`, ADR 0135).
   * Create, paste, duplicate, move, reorder and delete each say what they do to the children a node *shows*,
   * once; `insertOps`, `removeOps` and `reorderOps` turn that into what is stored, for every kind of node.
   *
   * This replaces a branch per kind in every one of those, which is where each session found another case
   * missing (ADR 0151).
   */
  type ListHost = { readonly kind: 'list'; readonly parentId: string | null; readonly list: readonly Node[] }
  type RecordHost = {
    readonly kind: 'record'
    readonly placement: Node
    /** The record's key: the piece's id, or the prefab root's for the placement itself. */
    readonly key: string
    /** The prefab's node whose children are inherited here. */
    readonly source: Node
    /**
     * Children ADR 0130 kept on the placement's own node. Shown after the rest, and moved into the record by
     * the first edit that has to order them — one storage (ADR 0151) — until the migration takes the rest.
     */
    readonly legacy: readonly Node[]
  }
  type ChildHost = ListHost | RecordHost

  /** The host of `parent`'s children; `null` is the level's top (the root's children, in a prefab). */
  const hostOf = (parent: number | null): ChildHost | null => {
    if (parent === null) {
      if (mode !== 'prefab') return { kind: 'list', parentId: null, list: roots }
      const root = roots[0]
      return root === undefined ? null : { kind: 'list', parentId: root.id, list: root.children ?? [] }
    }
    const p = node(parent)
    if (p === undefined) return null
    if (p.owner !== undefined) return { kind: 'record', placement: p.owner, key: p.authored.id, source: p.authored, legacy: [] }
    const def = p.authored.prefab === undefined ? undefined : level.prefabs?.[p.authored.prefab]
    // A placement whose prefab file is missing keeps what it has, where it has it, until the file is back.
    if (def === undefined) return { kind: 'list', parentId: p.authored.id, list: p.authored.children ?? [] }
    return { kind: 'record', placement: p.authored, key: def.id, source: def, legacy: p.authored.children ?? [] }
  }

  /** The host of the list node `i` is shown in. */
  const hostAround = (i: number): ChildHost | null => {
    const n = node(i)
    return n === undefined ? null : hostOf(n.parent < 0 ? null : n.parent)
  }

  const sameHost = (a: ChildHost, b: ChildHost): boolean =>
    a.kind === 'list' ? b.kind === 'list' && a.parentId === b.parentId : b.kind === 'record' && a.placement === b.placement && a.key === b.key

  const recordOf = (h: RecordHost): NodeOverride | undefined => h.placement.overrides?.[h.key]
  const isRemovedPiece = (placement: Node, id: string): boolean => placement.overrides?.[id]?.removedNodes?.includes(id) === true
  /** The prefab's children a record host still shows. */
  const inheritedIn = (h: RecordHost): string[] => (h.source.children ?? []).filter((k) => !isRemovedPiece(h.placement, k.id)).map((k) => k.id)
  const addedIn = (h: RecordHost): string[] => (recordOf(h)?.addedChildren ?? []).map((k) => k.id)

  /** The ids a host shows, in order. */
  const shownIn = (h: ChildHost): string[] =>
    h.kind === 'list'
      ? h.list.map((k) => k.id)
      : [...(childrenFor(h.source, recordOf(h), h.placement.overrides) ?? []).map((k) => k.id), ...h.legacy.map((k) => k.id)]

  /**
   * The order a record keeps: none when what is shown is the natural order — inherited, then added — or the
   * whole list when it is not. `childOrder` is a preference, so recording it only when needed keeps a
   * placement following its prefab's order everywhere it has not said otherwise.
   */
  const orderOps = (h: RecordHost, desired: readonly string[], natural: readonly string[]): Op[] => {
    const had = recordOf(h)?.childOrder
    if (desired.join('\u0000') === natural.join('\u0000')) return had === undefined ? [] : [{ kind: 'setOverrideChildOrder', owner: h.placement.id, node: h.key, order: null }]
    return [{ kind: 'setOverrideChildOrder', owner: h.placement.id, node: h.key, order: [...desired] }]
  }

  const END = Number.MAX_SAFE_INTEGER

  /** ADR 0130's children, moved into the record, same ids — what an edit that orders them has to do first. */
  const migrateOps = (h: RecordHost): Op[] =>
    h.legacy.flatMap((kid): Op[] => [
      { kind: 'removeNode', id: kid.id },
      { kind: 'insertOverrideChild', owner: h.placement.id, node: h.key, index: END, child: structuredClone(kid) },
    ])

  /** Show `child` at `at` among what `h` shows. */
  const insertOps = (h: ChildHost, child: Node, at: number): Op[] => {
    if (h.kind === 'list') return [{ kind: 'insertNode', parent: h.parentId, index: Math.max(0, Math.min(h.list.length, at)), node: child }]
    const desired = shownIn(h)
    desired.splice(Math.max(0, Math.min(desired.length, at)), 0, child.id)
    const natural = [...inheritedIn(h), ...addedIn(h), ...h.legacy.map((k) => k.id), child.id]
    return [...migrateOps(h), { kind: 'insertOverrideChild', owner: h.placement.id, node: h.key, index: END, child }, ...orderOps(h, desired, natural)]
  }

  /** Stop showing `id` under `h`: a piece is recorded as removed (ADR 0133), anything else is deleted. */
  const removeOps = (h: ChildHost, id: string): Op[] => {
    if (h.kind === 'list') return [{ kind: 'removeNode', id }]
    const inherited = (h.source.children ?? []).some((k) => k.id === id)
    const gone: Op = inherited ? { kind: 'setOverrideNodeRemoved', owner: h.placement.id, node: id, removed: true } : { kind: 'removeNode', id }
    if (recordOf(h)?.childOrder?.includes(id) !== true) return [gone]
    const desired = shownIn(h).filter((x) => x !== id)
    const natural = [...inheritedIn(h), ...addedIn(h), ...h.legacy.map((k) => k.id)].filter((x) => x !== id)
    return [gone, ...orderOps(h, desired, natural)]
  }

  /** Show `id` at `at` among its siblings — `at` as a drop between two rows gives it, before the move. */
  const reorderOps = (h: ChildHost, id: string, at: number): Op[] => {
    const shown = shownIn(h)
    const from = shown.indexOf(id)
    if (from < 0) return []
    const to = moveTarget(shown.length, from, at)
    if (to === from) return []
    if (h.kind === 'list') return [{ kind: 'moveNode', id, parent: h.parentId, index: to }]
    shown.splice(from, 1)
    shown.splice(to, 0, id)
    return [...migrateOps(h), ...orderOps(h, shown, [...inheritedIn(h), ...addedIn(h), ...h.legacy.map((k) => k.id)])]
  }

  /** A piece's index, by the placement showing it. */
  const indexOfPiece = (owner: string, id: string): number => nodes().findIndex((x) => x.owner?.id === owner && x.authored.id === id)

  /**
   * The prefab ops that give one prefab node the children this placement shows under it — what Apply does
   * with a record's structure (ADR 0151). Each child the placement added goes in with fresh ids, a prefab's
   * being its own, then every child is put in the order shown here. A placement among them is skipped: a
   * prefab holds none (ADR 0023).
   */
  const childrenToPrefab = (placement: Node, key: string, target: Node): Op[] => {
    const over = placement.overrides?.[key]
    const added = over?.addedChildren ?? []
    if (added.length === 0 && over?.childOrder === undefined) return []
    const ops: Op[] = []
    const renamed = new Map<string, string>()
    let at = target.children?.length ?? 0
    for (const kid of added) {
      if (kid.prefab !== undefined) continue
      const copy = structuredClone(kid)
      reidSubtree(copy)
      renamed.set(kid.id, copy.id)
      ops.push({ kind: 'insertNode', parent: target.id, index: at++, node: copy })
    }
    if (over?.childOrder !== undefined) {
      const there = new Set([...(target.children ?? []).map((k) => k.id), ...renamed.values()])
      const order = (childrenFor(target, over, placement.overrides) ?? []).map((k) => renamed.get(k.id) ?? k.id).filter((id) => there.has(id))
      order.forEach((id, k) => ops.push({ kind: 'moveNode', id, parent: target.id, index: k }))
    }
    return ops
  }

  const indexOfId =(id: string): number => nodes().findIndex((n) => n.owner === undefined && n.authored.id === id)
  const refOf = (n: DocNode): NodeRef => (n.owner === undefined ? (table_ === undefined ? { id: n.authored.id } : { table: table_, id: n.authored.id }) : { owner: n.owner.id, node: n.authored.id })

  /** This placement's override record for an inherited node, as it is. Writes go through ops (`ops.ts` tidies). */
  /**
   * Where the override record that speaks for `n` lives: a piece's on the placement that owns it, keyed by the
   * piece; a placement's **own inherited root** on the placement itself, keyed by the prefab root's id — where
   * `writeTarget` has written it since ADR 0098. Without the second case a change to a root component was
   * saved but counted, applied and reverted by nothing.
   */
  const recordKey = (n: DocNode): { readonly holder: Node; readonly node: string } | null => {
    if (n.owner !== undefined) return { holder: n.owner, node: n.authored.id }
    const root = n.authored.prefab === undefined ? undefined : level.prefabs?.[n.authored.prefab]
    return root === undefined ? null : { holder: n.authored, node: root.id }
  }

  const overrideFor = (n: DocNode): NodeOverride | undefined => {
    const k = recordKey(n)
    return k === null ? undefined : k.holder.overrides?.[k.node]
  }

  /** The prefab-side node `n` shows: the piece itself, or a placement's prefab root. */
  const definitionOf = (n: DocNode): Node | undefined =>
    n.owner !== undefined ? n.authored : n.authored.prefab === undefined ? undefined : level.prefabs?.[n.authored.prefab]

  /**
   * One past the last node of `i`'s subtree. In a depth-first walk a subtree is the contiguous run of deeper
   * nodes right after its root, which is what makes the cycle check a scan rather than a recursion.
   */
  const subtreeEnd = (i: number): number => {
    const all = nodes()
    const depth = all[i]?.depth ?? 0
    let j = i + 1
    while (j < all.length && (all[j]?.depth ?? 0) > depth) j++
    return j
  }

  const canReparent = (from: number, parent: number | null): boolean => {
    // A **piece** may be dragged out of its placement (ADR 0133): it is resolved into a node of this level
    // at the destination and removed from the placement it came from, in one batch. What it may not do is
    // move *within* the prefab, which the destination test below refuses along with everything else.
    const n = node(from)
    if (n === undefined) return false
    if (n.owner === undefined && own(from) === undefined) return false // a prefab document's root
    // A prefab has one root: nothing goes beside it, or the file — which writes only its root — loses it.
    if (parent === null) return mode !== 'prefab'
    if (parent === from) return false
    // Anything that shows children takes one: a piece too (ADR 0135), into its placement's record.
    if (hostOf(parent) === null) return false
    return !(parent > from && parent < subtreeEnd(from))
  }

  /** The nearest `MaterialOverride` at or above this node — what resurfaces the whole subtree. */
  const inheritedMaterial = (i: number): string | undefined => {
    const all = nodes()
    for (let at: number | undefined = i; at !== undefined && at >= 0; at = all[at]?.parent) {
      const mo = all[at]?.view.components.find((c) => c.type === MATERIAL_OVERRIDE && c.enabled !== false)
      if (mo !== undefined) return stringParam(mo, 'material', '')
    }
    return undefined
  }

  /** Every `nodeRef` parameter a component declares. */
  const refKeys = (type: string): string[] => {
    const def = registry.get(type)
    return def === undefined ? [] : Object.entries(def.params).filter(([, spec]) => spec.kind === 'nodeRef').map(([key]) => key)
  }

  /**
   * Re-mint every node id in a subtree and re-point any reference that named one of them.
   *
   * Without this, duplicating a subtree gives you a copy whose references still point at the original — the
   * copy looks right and behaves as the original's shadow, which is the worst kind of wrong. Unity remaps the
   * same way on duplicate.
   */
  const reidSubtree = (root: Node): void => {
    const map = new Map<string, string>()
    const rename = (x: Node): void => {
      const fresh = freshId()
      map.set(x.id, fresh)
      x.id = fresh
      // What a placement added under its pieces is part of the copy too (ADR 0151).
      for (const kids of childListsOf(x)) for (const kid of kids) rename(kid)
    }
    rename(root)

    const retarget = (c: ComponentData): void => {
      for (const key of refKeys(c.type)) {
        const was = c.params[key]
        if (typeof was !== 'string') continue
        const to = map.get(was)
        if (to !== undefined) c.params[key] = to
      }
      // A step's target names a child by id, the same as a `nodeRef` does (ADR 0137).
      retargetSequenceParams(c, (id) => map.get(id))
    }
    const repoint = (x: Node): void => {
      for (const c of x.components) retarget(c)
      // An override patches a component that lives in the prefab, so its *type* has to be looked up there
      // before its reference parameters are known.
      const inherited = x.prefab === undefined ? undefined : level.prefabs?.[x.prefab]
      for (const over of Object.values(x.overrides ?? {})) {
        // An order names the added children, which have new ids now; the prefab's own keep theirs.
        if (over.childOrder !== undefined) over.childOrder = over.childOrder.map((id) => map.get(id) ?? id)
        for (const c of over.added ?? []) retarget(c)
        for (const [cid, seq] of Object.entries(over.sequences ?? {})) over.sequences![cid] = retargetSequenceOverride(seq, (id) => map.get(id))
        for (const [cid, patch] of Object.entries(over.params ?? {})) {
          const type = inherited === undefined ? undefined : typeOfComponent(inherited, cid)
          if (type === undefined) continue
          for (const key of refKeys(type)) {
            const was = patch[key]
            if (typeof was !== 'string') continue
            const to = map.get(was)
            if (to !== undefined) patch[key] = to
          }
        }
      }
      for (const kids of childListsOf(x)) for (const kid of kids) repoint(kid)
    }
    repoint(root)
  }

  /** Display name: the typed name if there is one, else what the node is made of. */
  const labelAt = (i: number): string => {
    const n = node(i)
    if (n === undefined) return ''
    if (n.view.name !== undefined && n.view.name !== '') return n.view.name
    if (n.authored.prefab !== undefined) return n.authored.prefab
    const collider = n.view.components.find((c) => c.type === COLLIDER)
    if (collider !== undefined) return String((collider.params.shape as { kind?: string } | undefined)?.kind ?? 'node')
    return n.view.components[0]?.type ?? 'node'
  }

  const enabledOf = (c: ComponentData): boolean => c.enabled !== false

  /** Set some of a component's parameters, on the definition or as an override (`ops.ts` patches an added component in place). */
  /**
   * Where a write to one component has to land (ADR 0098).
   *
   * Three cases, not two, and the third is the one that was missing. A placement's visible component list is
   * the prefab **root's** layered with its own (`effectiveNode`), but the placement has no `owner` — it *is*
   * one — so a write to an inherited root component was aimed at the placement itself, where that component
   * does not exist. `setParams` threw `no component 'c0' on node '<id>'`; remove and enable had a guard and
   * silently did nothing.
   *
   * The override record is keyed by node id and `bakeOverrides` looks up the root's own id, so an override on
   * the placement keyed by the root's id reaches it. No new op, no schema change.
   */
  type WriteTarget = { readonly kind: 'own'; readonly id: string } | { readonly kind: 'override'; readonly holder: Node; readonly node: string }

  const writeTarget = (n: DocNode, componentId: string): WriteTarget | null => {
    // An inherited child: the override goes on the placement that owns it, keyed by the child.
    if (n.owner !== undefined) return { kind: 'override', holder: n.owner, node: n.authored.id }
    // Its own component: edit it.
    if (n.authored.components.some((c) => c.id === componentId)) return { kind: 'own', id: n.authored.id }
    // Inherited from this placement's own prefab root.
    const root = n.authored.prefab === undefined ? undefined : level.prefabs?.[n.authored.prefab]
    return root === undefined ? null : { kind: 'override', holder: n.authored, node: root.id }
  }

  /** The override record a `WriteTarget` writes into, if there is one yet. */
  const recordAt = (t: WriteTarget): NodeOverride | undefined => (t.kind === 'own' ? undefined : t.holder.overrides?.[t.node])

  /**
   * The ops one node's parameter write comes to. Split out of `setParams` so a multi-selection edit can
   * concatenate several nodes' worth and commit them **once** — one undo entry, one broadcast (ADR 0112).
   */
  const paramOpsFor = (i: number, componentId: string, patch: Record<string, unknown>): Op[] => {
    const n = node(i)
    if (n === undefined) return []
    const target = n.view.components.find((x) => x.id === componentId)
    if (target === undefined) return []
    // Per component id, not once: the built-in branch below touches several, and on a placement some may be
    // its own while others came from the prefab root.
    const paramsOp = (cid: string, p: Record<string, unknown>): Op | null => {
      const t = writeTarget(n, cid)
      if (t === null) return null
      return t.kind === 'own'
        ? { kind: 'setParams', id: t.id, componentId: cid, patch: p }
        : { kind: 'setOverrideParams', owner: t.holder.id, node: t.node, componentId: cid, patch: p }
    }
    const ops: (Op | null)[] = [paramsOp(componentId, patch)]
    // A built-in shape picked (ADR 0090): scale is the size, so every collider on the node becomes the unit
    // shape of that built-in. Same batch, one undo.
    if (target.type === RENDERER && isBuiltinModel(patch.model)) {
      const unit = unitColliderFor(patch.model)
      for (const c of n.view.components) if (c.type === COLLIDER) ops.push(paramsOp(c.id, { shape: unit }))
    }
    return ops.filter((o): o is Op => o !== null)
  }

  const patchParams = (i: number, componentId: string, patch: Record<string, unknown>): void => {
    const ops = paramOpsFor(i, componentId, patch)
    if (ops.length > 0) commit(ops)
  }

  /** The op that makes one sequence show `stages`, wherever its data lives (ADR 0139). */
  const sequenceOpFor = (i: number, componentId: string, stages: readonly Stage[]): Op | null => {
    const n = node(i)
    if (n === undefined) return null
    const t = writeTarget(n, componentId)
    if (t === null) return null
    if (t.kind === 'own') return { kind: 'setParams', id: t.id, componentId, patch: { stages } }
    const over = recordAt(t)
    // Added on this placement: it is the placement's own, and is written whole.
    if (over?.added?.some((c) => c.id === componentId) === true) {
      return { kind: 'setOverrideParams', owner: t.holder.id, node: t.node, componentId, patch: { stages } }
    }
    // What the placement would show with no sequence record: the prefab's, under any params patch it holds.
    const prefab = definitionOf(n)?.components.find((c) => c.id === componentId)
    const base = readStages(over?.params?.[componentId]?.stages ?? prefab?.params.stages)
    return { kind: 'setOverrideSequence', owner: t.holder.id, node: t.node, componentId, override: diffStages(base, stages) ?? null }
  }

  const setSequencesStages = (i: number, changes: readonly { readonly componentId: string; readonly stages: readonly Stage[] }[]): void => {
    const ops = changes.map((c) => sequenceOpFor(i, c.componentId, c.stages)).filter((o): o is Op => o !== null)
    if (ops.length > 0) commit(ops)
  }

  const setSequenceStages = (i: number, componentId: string, stages: readonly Stage[]): void => setSequencesStages(i, [{ componentId, stages }])

  /**
   * One parameter patch across several nodes, as a single commit (ADR 0112).
   *
   * `targets` pairs a node index with the id of *its own* component, because component ids are minted per
   * component (`freshId`): two cubes' colliders are the same type and never the same id. The Inspector pairs
   * them up by type and ordinal and hands the result here.
   */
  const patchParamsAcross = <T extends { at: number; componentId: string }>(targets: readonly T[], patch: Record<string, unknown> | ((target: T) => Record<string, unknown>)): void => {
    const ops: Op[] = []
    for (const t of targets) ops.push(...paramOpsFor(t.at, t.componentId, typeof patch === 'function' ? patch(t) : patch))
    if (ops.length > 0) commit(ops)
  }

  const builtinOf = (i: number): BuiltinModel | null => {
    const n = node(i)
    if (n === undefined) return null
    const model = modelOf(n.view.components)
    return isBuiltinModel(model) ? model : null
  }

  const canAdd = (i: number, type: string): boolean => {
    const n = node(i)
    if (n === undefined || !registry.has(type)) return false
    const def = registry.get(type)
    // A player component is the game's, declared in its `ModeDescriptor` and never authored in a level
    // (ADR 0059). Both Add Component menus read this, so neither offers a death reaction for a staircase.
    if (def?.attachesTo === 'player') return false
    if (def?.singleton !== true) return true
    return !n.view.components.some((c) => c.type === type)
  }

  const addComponent = (i: number, type: string): string | null => {
    const n = node(i)
    if (n === undefined || !canAdd(i, type)) return null
    const fresh: ComponentData = { id: freshId(), type, params: { ...registry.defaults(type) } }
    // A collider joining a node that draws a built-in shape is the unit shape of that built-in (ADR 0090).
    const builtin = type === COLLIDER ? builtinOf(i) : null
    if (builtin !== null) fresh.params.shape = unitColliderFor(builtin)
    /**
     * On a piece, in its record; on a placement, in the record of its prefab's root (ADR 0151) — not in the
     * placement's own `components`, where Revert and Apply never looked for it.
     */
    const def = n.owner === undefined && n.authored.prefab !== undefined ? level.prefabs?.[n.authored.prefab] : undefined
    if (n.owner !== undefined) commit([{ kind: 'addOverrideComponent', owner: n.owner.id, node: n.authored.id, component: fresh }])
    else if (def !== undefined) commit([{ kind: 'addOverrideComponent', owner: n.authored.id, node: def.id, component: fresh }])
    else commit([{ kind: 'addComponent', id: n.authored.id, component: fresh }])
    return fresh.id
  }

  const moveComponent = (i: number, componentId: string, delta: number): void => {
    const n = node(i)
    if (n === undefined || n.owner !== undefined) return
    // Deliberately **not** given the third case the other writers got (ADR 0098): reordering belongs to the
    // prefab's own list and there is no override that expresses it. An inherited component simply is not in
    // `authored.components`, so the index lookup below refuses it — the same way it refuses for a child.
    const list = n.authored.components
    const from = list.findIndex((c) => c.id === componentId)
    const to = from + delta
    if (from < 0 || to < 0 || to >= list.length) return
    commit([{ kind: 'moveComponent', id: n.authored.id, componentId, to }])
  }

  const removeComponent = (i: number, componentId: string): void => {
    const n = node(i)
    if (n === undefined) return
    const t = writeTarget(n, componentId)
    if (t === null) return
    if (t.kind === 'own') {
      commit([{ kind: 'removeComponent', id: t.id, componentId }])
      return
    }
    const owner = t.holder.id
    const nodeId = t.node
    const over = recordAt(t)
    // Removing something this placement added is an undo, not a removal recorded against the prefab.
    if (over?.added?.some((c) => c.id === componentId) === true) {
      commit([{ kind: 'removeOverrideComponent', owner, node: nodeId, componentId }])
      return
    }
    const ops: Op[] = []
    const params = over?.params?.[componentId]
    if (params !== undefined && Object.keys(params).length > 0) ops.push({ kind: 'setOverrideParams', owner, node: nodeId, componentId, patch: {}, unset: Object.keys(params) })
    if (over?.enabled?.[componentId] !== undefined) ops.push({ kind: 'setOverrideEnabled', owner, node: nodeId, componentId, enabled: null })
    if (over?.sequences?.[componentId] !== undefined) ops.push({ kind: 'setOverrideSequence', owner, node: nodeId, componentId, override: null })
    ops.push({ kind: 'setOverrideRemoved', owner, node: nodeId, componentId, removed: true })
    commit(ops)
  }

  /**
   * What one node's record says, as the Inspector and the menus list it. `withChildren` false leaves out what
   * the placement added under it: counting a placement's changes, those are `placementAdded`'s (ADR 0130), and
   * counted twice the menu says two objects for one.
   */
  const describeRecord = (i: number, withChildren: boolean): string[] => {
    const n = node(i)
    const over = n === undefined ? undefined : overrideFor(n)
    if (over === undefined || n === undefined) return []
    const out: string[] = []
    const typeOf = (id: string): string => n.view.components.find((c) => c.id === id)?.type ?? id
    // Every field the record says something in, from the one list (ADR 0151): this named seven of eleven,
    // so a piece switched off, reordered or given a child here counted as matching its prefab.
    for (const field of overrideFieldsSet(over)) {
      switch (field) {
        case 'transform':
        case 'name':
          out.push(field)
          break
        case 'params':
          for (const id of Object.keys(over.params ?? {})) out.push(typeOf(id))
          break
        case 'enabled':
          for (const id of Object.keys(over.enabled ?? {})) out.push(`${typeOf(id)} (off)`)
          break
        case 'sequences':
          for (const id of Object.keys(over.sequences ?? {})) out.push(`${typeOf(id)} (stages)`)
          break
        case 'added':
          for (const c of over.added ?? []) out.push(`${c.type} (added)`)
          break
        case 'removed':
          for (const id of over.removed ?? []) out.push(`${id} (removed)`)
          break
        case 'nodeEnabled':
          out.push(over.nodeEnabled === false ? 'switched off' : 'switched on')
          break
        case 'addedChildren': {
          if (!withChildren) break
          const count = over.addedChildren?.length ?? 0
          out.push(`${count} child${count === 1 ? '' : 'ren'} added`)
          break
        }
        case 'childOrder':
          out.push('order of its children')
          break
        case 'removedNodes':
          out.push('removed')
          break
      }
    }
    return out
  }

  /** The placement at `i` and every piece of it whose record says anything at all — what Apply carries. */
  const recordedIn = (i: number): number[] => {
    const all = nodes()
    const root = all[i]
    if (root === undefined || root.owner !== undefined || root.authored.prefab === undefined) return []
    const out: number[] = []
    for (let j = i; j < subtreeEnd(i); j++) {
      const x = all[j]
      if (x === undefined || (j !== i && x.owner?.id !== root.authored.id)) continue
      if (overrideFieldsSet(overrideFor(x)).length > 0) out.push(j)
    }
    return out
  }

  const self: Doc = {
    mode,
    registry,
    onOps: null,
    refAt: (i) => {
      const n = node(i)
      return n === undefined ? null : refOf(n)
    },
    indexOfRef: (ref) => {
      const all = nodes()
      const at =
        'owner' in ref
          ? all.findIndex((n) => n.owner?.id === ref.owner && n.authored.id === ref.node)
          : ref.table !== table_
            ? -1
            : all.findIndex((n) => n.owner === undefined && n.authored.id === ref.id)
      return at < 0 ? null : at
    },
    reading,
    count: () => nodes().length,
    kindOf: (i) => (node(i)?.owner === undefined ? 'own' : 'inherited'),
    transformOf: (i) => node(i)?.view.transform ?? { position: vec3(0, 0, 0) },
    setTransform: (i, t) => {
      const n = node(i)
      if (n === undefined) return
      if (n.owner === undefined) commit([{ kind: 'setTransform', id: n.authored.id, transform: t }])
      else commit([{ kind: 'setOverrideTransform', owner: n.owner.id, node: n.authored.id, transform: t }])
    },
    /**
     * One mesh per enabled `Collider`, at its own offset — which is what makes several colliders on one node
     * worth having. A model replaces them all, since it is the whole object's appearance and the colliders are
     * only how it collides.
     *
     * The Mesh Renderer is what makes any of it visible: without one this draws nothing (ADR 0153).
     */
    meshSpecs: (i) => {
      const n = node(i)
      if (n === undefined) return []
      const renderer = n.view.components.find((c) => c.type === RENDERER && enabledOf(c))
      if (renderer === undefined) return []
      const material = inheritedMaterial(i) ?? stringParam(renderer, 'material', '')
      const surfaced = material === '' ? undefined : material
      const model = modelOf(n.view.components)
      if (model !== '') {
        return [{ collider: { kind: 'box', halfExtents: vec3(0.5, 0.5, 0.5) }, transform: { position: vec3(0, 0, 0) }, name: n.view.name, model, material: surfaced }]
      }
      return n.view.components
        .filter((c) => c.type === COLLIDER && enabledOf(c))
        .map((c) => ({
          collider: (c.params.shape ?? { kind: 'box', halfExtents: vec3(0.5, 0.5, 0.5) }) as ColliderDesc,
          transform: { position: vec3Param(c, 'center', ZERO) },
          name: n.view.name,
          model: undefined,
          material: surfaced,
        }))
    },
    lightSpec: (i) => {
      const n = node(i)
      if (n === undefined) return undefined
      const c = n.view.components.find((x) => x.type === LIGHT && enabledOf(x))
      if (c === undefined) return undefined
      const kind = stringParam(c, 'kind', 'point')
      return {
        kind: kind === 'spot' || kind === 'directional' || kind === 'ambient' || kind === 'hemisphere' ? kind : 'point',
        color: stringParam(c, 'color', '#ffffff'),
        groundColor: stringParam(c, 'groundColor', '#808080'),
        intensity: numberParam(c, 'intensity', 4),
        range: numberParam(c, 'range', 12),
        decay: numberParam(c, 'decay', 2),
        angleDeg: numberParam(c, 'angle', 40),
        penumbra: numberParam(c, 'penumbra', 0.3),
        castShadow: boolParam(c, 'castShadow', false),
      }
    },
    placeNamed: (name, position) => {
      if (mode !== 'prefab') return -1
      const fresh = primitiveNode(isPrimitiveKind(name) ? name : 'box', position, name)
      const host = roots[0]
      if (host === undefined) return -1
      commit([{ kind: 'insertNode', parent: host.id, index: host.children?.length ?? 0, node: fresh }])
      return indexOfId(fresh.id)
    },
    placePrefab: (assetId, root, position) => {
      // Refused here, not only in the palette: a level a game cannot load must not be producible by any door.
      // A shared component the game lacks never reaches this line — the host adopts it into the game and
      // rebuilds the document first (ADR 0077); what is refused is another game's private component.
      if (unknownComponentTypes(root, registry).length > 0) return -1
      if (mode === 'prefab') {
        // A prefab holds nodes, never prefabs, so placing one here appends its children — re-minted, so two
        // placements of the same prefab are two sets of nodes.
        const host = roots[0]
        if (host === undefined) return -1
        const ops: Op[] = []
        let at = host.children?.length ?? 0
        let last: Node | undefined
        for (const kid of root.children ?? []) {
          const copy = structuredClone(kid)
          reidSubtree(copy)
          copy.transform = { ...copy.transform, position: vec3(position.x + copy.transform.position.x, position.y + copy.transform.position.y, position.z + copy.transform.position.z) }
          ops.push({ kind: 'insertNode', parent: host.id, index: at++, node: copy })
          last = copy
        }
        commit(ops)
        return last === undefined ? -1 : indexOfId(last.id)
      }
      /**
        * The definition is put in the resolution map so this document can read the placement's inherited
        * nodes at once — **not** as an op and never written to the level: the server resolves it from the file
        * on its own side.
        *
        * **Only when this document cannot resolve it yet**, as a paste does. One it already has is the one the
        * room keeps current — a collaborator's edit to the prefab arrives there — and the server keeps it too
        * (`hydratePrefabs` skips an id the level carries). Replacing it with the caller's copy, which is the
        * Project panel's, put every placement of the prefab back to that copy on this screen alone.
        */
      if (level.prefabs?.[assetId] === undefined) {
        ;(level.prefabs ??= {})[assetId] = structuredClone(root)
      }
      const placed: Node = { id: freshId(), transform: { position }, components: [], prefab: assetId }
      commit([{ kind: 'insertNode', parent: null, index: roots.length, node: placed }])
      return indexOfId(placed.id)
    },
    placeEmpty: (position, parent) => {
      const fresh: Node = { id: freshId(), name: 'empty', transform: { position }, components: [] }
      // Last under `parent`, wherever its children are kept (ADR 0151): a piece's and a placement's in the record.
      const host = hostOf(parent)
      if (host === null) return -1
      commit(insertOps(host, fresh, END))
      return indexOfId(fresh.id)
    },
    placePrimitive: (kind, position, parent) => {
      const fresh = primitiveNode(kind, position)
      // The same door `placeEmpty` uses (ADR 0151).
      const host = hostOf(parent)
      if (host === null) return -1
      commit(insertOps(host, fresh, END))
      return indexOfId(fresh.id)
    },
    builtinOf,
    placeModel: (assetId, position) => {
      const fresh = solidNode({ kind: 'box', halfExtents: vec3(0.5, 0.5, 0.5) }, { position }, undefined, assetId)
      const host = mode === 'prefab' ? roots[0] : undefined
      if (mode === 'prefab' && host === undefined) return -1
      commit([{ kind: 'insertNode', parent: host?.id ?? null, index: host === undefined ? roots.length : (host.children?.length ?? 0), node: fresh }])
      return indexOfId(fresh.id)
    },
    // Removing takes the subtree with it: children are placed relative to this node and have nowhere to be
    // without it.
    remove: (i) => {
      const n = node(i)
      // `own`, not `n`: it is what refuses a prefab document's root, which is the file itself.
      if (n === undefined || (n.owner === undefined && own(i) === undefined)) return
      /**
       * Out of what its parent shows (ADR 0151). A piece of a prefab is removed **on this placement only**
       * (ADR 0133) — Unity's removed GameObject: the prefab keeps it and every other placement keeps it.
       */
      const host = hostAround(i)
      if (host !== null) commit(removeOps(host, n.authored.id))
    },
    // A clone of a placement references the same table entry. Cloning the *definition* would quietly break
    // the very link the reference exists to provide. Children come along; ids are re-minted.
    /**
     * A copy beside the original, whatever it is (ADR 0151). A prefab's piece copies as what it looks like — a
     * plain object (ADR 0131) — and lands beside it in this placement's record, since its siblings there are
     * shown from the prefab.
     */
    duplicate: (i) => {
      const n = node(i)
      if (n === undefined || (n.owner === undefined && own(i) === undefined)) return i
      const host = hostAround(i)
      if (host === null) return i
      const copy = structuredClone(n.owner === undefined ? n.authored : n.view)
      reidSubtree(copy)
      commit(insertOps(host, copy, n.slot + 1))
      return indexOfId(copy.id)
    },
    label: labelAt,
    nameOf: (i) => node(i)?.view.name ?? '',
    setName: (i, name) => {
      const n = node(i)
      if (n === undefined) return
      // Empty means "no name here" on an inherited node, which still differs from inheriting the prefab's; on
      // an own node it means no name at all.
      if (n.owner !== undefined) commit([{ kind: 'setOverrideName', owner: n.owner.id, node: n.authored.id, name }])
      else commit([{ kind: 'setName', id: n.authored.id, name: name === '' ? null : name }])
    },
    // Order is not cosmetic (checkpoint progression, the replicated movement-base index — ADR 0021), and an
    // inherited node's order belongs to the prefab.
    move: (from, to) => {
      /**
       * **Reordering a piece is recorded on the placement** (ADR 0135), not on the prefab: the whole list of
       * that parent's children in this placement's order, so the other placements keep theirs. The same door
       * as a drop among siblings (ADR 0151).
       */
      const n = node(from)
      const host = hostAround(from)
      if (n === undefined || host === null || (n.owner === undefined && own(from) === undefined)) return from
      commit(reorderOps(host, n.authored.id, to))
      return n.owner === undefined ? indexOfId(n.authored.id) : indexOfPiece(n.owner.id, n.authored.id)
    },
    depthOf: (i) => node(i)?.depth ?? 0,
    parentOf: (i) => {
      const parent = node(i)?.parent
      return parent === undefined || parent < 0 ? null : parent
    },
    siblingIndexOf: (i) => node(i)?.slot ?? 0,
    pathOf: (i) => node(i)?.path ?? '',
    // Inherited nodes count as contents too: they are what one twist in the Hierarchy opens, alongside the
    // placement's own children.
    // What the tree shows under it, counted off the tree (ADR 0151): a prefab's child count plus the own
    // children missed what a placement removed and what it added under a piece.
    childCount: (i) => nodes().reduce((count, x) => (x.parent === i ? count + 1 : count), 0),
    canReparent,
    reparent: (from, parent, atIndex, transform) => {
      if (!canReparent(from, parent)) return from
      const moving = node(from)
      const src = hostAround(from)
      const dst = hostOf(parent)
      if (moving === undefined || src === null || dst === null) return from
      const id = moving.authored.id
      /**
       * Among its own siblings it is a reorder, whatever it is — a piece stays a piece (ADR 0135), recorded as
       * this placement's order. Its transform is left alone: the parent did not change.
       */
      if (sameHost(src, dst)) {
        commit(reorderOps(src, id, atIndex))
        return moving.owner === undefined ? indexOfId(id) : indexOfPiece(moving.owner.id, id)
      }
      /**
       * A **piece** going anywhere else becomes a copy of what it looked like, with fresh ids — a prefab's are
       * its own — and the placement records it gone (ADR 0133). One batch, so one Ctrl+Z.
       */
      if (moving.owner !== undefined) {
        const landed = structuredClone(moving.view)
        reidSubtree(landed)
        if (transform !== undefined) landed.transform = transform
        commit([...insertOps(dst, landed, atIndex), ...removeOps(src, id)])
        return indexOfId(landed.id)
      }
      /**
       * Between two plain lists, one `moveNode`, and the re-expressed transform in the same batch (ADR 0113):
       * undo puts the transform back before the node moves home.
       */
      if (src.kind === 'list' && dst.kind === 'list') {
        const ops: Op[] = [{ kind: 'moveNode', id, parent: dst.parentId, index: Math.max(0, Math.min(dst.list.length, atIndex)) }]
        if (transform !== undefined) ops.push({ kind: 'setTransform', id, transform })
        commit(ops)
        return indexOfId(id)
      }
      // Into or out of a record: out, then in — the same node with the same ids, so references keep naming it.
      const landed = structuredClone(moving.authored)
      if (transform !== undefined) landed.transform = transform
      commit([...removeOps(src, id), ...insertOps(dst, landed, atIndex)])
      return indexOfId(id)
    },
    assetIds: () => {
      const ids = new Set<string>()
      const add = (components: readonly ComponentData[]): void => {
        for (const c of components) {
          if (c.type === RENDERER) {
            const model = stringParam(c, 'model', '')
            // A built-in shape is geometry, not a file: nothing to fetch (ADR 0090).
            if (model !== '' && !isBuiltinModel(model)) ids.add(model)
          }
          if (c.type === RENDERER || c.type === MATERIAL_OVERRIDE) {
            const material = stringParam(c, 'material', '')
            if (material !== '') ids.add(material)
          }
        }
      }
      // Every node the document can show, plus the definitions behind them — a prefab's own materials count
      // even where a placement has not been walked yet.
      for (const n of nodes()) add(n.view.components)
      const walk = (n: Node): void => {
        add(n.components)
        for (const kid of n.children ?? []) walk(kid)
      }
      for (const root of Object.values(level.prefabs ?? {})) walk(root)
      return [...ids]
    },

    components: (i) => {
      const n = node(i)
      if (n === undefined) return []
      const over = overrideFor(n)
      const addedIds = new Set((over?.added ?? []).map((c) => c.id))
      // A placement's root shows its prefab root's components beside its own: those are inherited too (ADR 0098).
      const ownIds = new Set(n.owner === undefined ? n.authored.components.map((c) => c.id) : [])
      return n.view.components.map((c) => {
        const patch = over?.params?.[c.id]
        const overridden = patch === undefined ? [] : Object.keys(patch)
        if (over?.enabled?.[c.id] !== undefined) overridden.push('enabled')
        return {
          id: c.id,
          type: c.type,
          params: c.params,
          enabled: enabledOf(c),
          inherited: !addedIds.has(c.id) && (n.owner !== undefined || !ownIds.has(c.id)),
          added: addedIds.has(c.id),
          overridden,
        }
      })
    },
    canAdd,
    addComponent,
    removeComponent,
    setParams: patchParams,
    setSequenceStages,
    setSequencesStages,
    sequenceOverrideOf: (i, componentId) => {
      const n = node(i)
      return n === undefined ? undefined : overrideFor(n)?.sequences?.[componentId]
    },
    routesAt: (i) => {
      const all = nodes()
      const n = all[i]
      if (n === undefined) return []
      const out: SequenceRoute[] = []
      const collect = (holder: number, key: string): void => {
        for (const c of all[holder]?.view.components ?? []) {
          if (c.type !== SEQUENCE || c.enabled === false) continue
          const data = sequenceOf(c)
          const steps = routeSteps(data.stages, key)
          if (steps.length > 0) out.push({ holder, componentId: c.id, axes: data.axes, steps })
        }
      }
      collect(i, SELF)
      if (n.parent >= 0) collect(n.parent, n.authored.id)
      return out
    },
    stepTargetOf: (i, target) => {
      const all = nodes()
      if (all[i] === undefined) return null
      if (target === SELF) return i
      for (let j = i + 1; j < all.length; j++) {
        const kid = all[j]!
        if (kid.depth <= all[i]!.depth) break
        if (kid.parent === i && kid.authored.id === target) return j
      }
      return null
    },
    childTargets: (i) => {
      const all = nodes()
      const out: { id: string; label: string }[] = []
      for (let j = i + 1; j < all.length; j++) {
        const kid = all[j]!
        if (kid.depth <= (all[i]?.depth ?? -1)) break
        if (kid.parent === i) out.push({ id: kid.authored.id, label: labelAt(j) })
      }
      return out
    },
    setParamsAcross: patchParamsAcross,
    moveComponent,
    setComponentEnabled: (i, componentId, on) => {
      const n = node(i)
      if (n === undefined) return
      const t = writeTarget(n, componentId)
      if (t === null) return
      commit([
        t.kind === 'own'
          ? { kind: 'setComponentEnabled', id: t.id, componentId, enabled: on }
          : { kind: 'setOverrideEnabled', owner: t.holder.id, node: t.node, componentId, enabled: on },
      ])
    },

    nodeChoices: (i) => {
      const n = node(i)
      if (n === undefined) return []
      return nodes()
        .map((o, at) => ({ o, at }))
        .filter(({ o }) => reaches(n, o))
        .map(({ o, at }) => ({ id: o.authored.id, label: labelAt(at) }))
    },
    refTo: (i, j) => {
      const n = node(i)
      const o = node(j)
      return n === undefined || o === undefined || !reaches(n, o) ? null : o.authored.id
    },
    refTarget: (i, id) => {
      const n = node(i)
      if (n === undefined) return null
      const all = nodes()
      const own = n.owner === undefined ? -1 : all.findIndex((o) => o.owner === n.owner && o.authored.id === id)
      const at = own >= 0 ? own : all.findIndex((o) => o.owner === undefined && o.authored.id === id)
      return at >= 0 ? at : null
    },
    overridesOf: (i) => describeRecord(i, true),
    revert: (i, field) => {
      const n = node(i)
      const k = n === undefined ? null : recordKey(n)
      if (n === undefined || k === null) return
      const current = overrideFor(n)
      if (current === undefined) return
      // The record as it will be: everything, or one field, or one component's every trace, gone.
      let next: NodeOverride | null = structuredClone(current)
      if (field === undefined) next = null
      else if (field === 'transform' || field === 'name') delete next[field]
      else {
        delete next.params?.[field]
        delete next.enabled?.[field]
        delete next.sequences?.[field]
        if (next.added !== undefined) next.added = next.added.filter((c) => c.id !== field)
        if (next.removed !== undefined) next.removed = next.removed.filter((id) => id !== field)
      }
      commit([{ kind: 'setNodeOverride', owner: k.holder.id, node: k.node, override: next }])
    },
    /**
     * Promote this placement's overrides into the shared prefab, then drop them.
     *
     * Every other placement of that prefab changes, which is the point — and why this is a deliberate action
     * rather than something an edit does on its own.
     */
    overrideOpsFor: (i) => {
      const n = node(i)
      const k = n === undefined ? null : recordKey(n)
      const assetId = n?.owner?.prefab ?? n?.authored.prefab
      const target = n === undefined ? undefined : definitionOf(n)
      if (n === undefined || k === null || assetId === undefined || target === undefined) return null
      const over = overrideFor(n)
      if (over === undefined) return null
      // Plain ops, with no table scope: they go to the prefab's own document, whose forest is its one root.
      // Addressed by the prefab-side id: the piece's own, or the prefab root's for a placement's root.
      const id = k.node
      const ops: Op[] = []
      if (over.transform !== undefined) ops.push({ kind: 'setTransform', id, transform: over.transform })
      if (over.name !== undefined) ops.push({ kind: 'setName', id, name: over.name === '' ? null : over.name })
      for (const [componentId, patch] of Object.entries(over.params ?? {})) {
        if (target.components.some((x) => x.id === componentId)) ops.push({ kind: 'setParams', id, componentId, patch })
      }
      for (const [componentId, on] of Object.entries(over.enabled ?? {})) {
        if (target.components.some((x) => x.id === componentId)) ops.push({ kind: 'setComponentEnabled', id, componentId, enabled: on })
      }
      for (const componentId of over.removed ?? []) {
        if (target.components.some((x) => x.id === componentId)) ops.push({ kind: 'removeComponent', id, componentId })
      }
      for (const c of over.added ?? []) ops.push({ kind: 'addComponent', id, component: structuredClone(c) })
      if (over.nodeEnabled !== undefined) ops.push({ kind: 'setNodeEnabled', id, enabled: over.nodeEnabled })
      // A sequence's differences go as the stages this placement shows: the prefab is to match this copy.
      for (const componentId of Object.keys(over.sequences ?? {})) {
        const shown = n.view.components.find((x) => x.id === componentId)
        if (shown !== undefined && target.components.some((x) => x.id === componentId)) {
          ops.push({ kind: 'setParams', id, componentId, patch: { stages: structuredClone(shown.params.stages) } })
        }
      }
      ops.push(...childrenToPrefab(k.holder, k.node, target))
      return { assetId, ops }
    },

    placementOverrides: (i) => {
      const root = node(i)
      if (root?.authored.prefab === undefined) return []
      const all = nodes()
      // The placement's own inherited root first: its component changes live on the placement itself.
      const own = describeRecord(i, false)
      const out: { index: number; fields: string[] }[] = own.length > 0 ? [{ index: i, fields: own }] : []
      for (let j = i + 1; j < subtreeEnd(i); j++) {
        const piece = all[j]
        // Owned by *this* placement: a nested placement's pieces are that placement's business.
        if (piece?.owner?.id !== root.authored.id) continue
        const fields = describeRecord(j, false)
        if (fields.length > 0) out.push({ index: j, fields })
      }
      return out
    },

    placementRemoved: (i) => {
      const root = node(i)
      if (root?.authored.prefab === undefined) return []
      /**
       * Read off the **override records**, not the resolved tree: a removed piece is not in the tree, so it
       * has no index to ask about. Its record is keyed by its own prefab node id and names itself.
       */
      const out: string[] = []
      for (const [id, over] of Object.entries(root.authored.overrides ?? {})) {
        if (over.removedNodes?.includes(id) === true) out.push(id)
      }
      return out
    },

    placementAdded: (i) => {
      const root = node(i)
      if (root?.authored.prefab === undefined) return []
      const all = nodes()
      const out: number[] = []
      for (let j = i + 1; j < subtreeEnd(i); j++) {
        const kid = all[j]
        if (kid === undefined || kid.owner !== undefined) continue
        /**
         * The **root** of an added subtree, at any depth (ADR 0135): a node this document authored whose
         * parent is a piece, or the placement itself. Its own children ride inside it and are not entries.
         *
         * ADR 0130 could only find the placement's direct children, because that was the only place one
         * could be. Now they hang off any piece, and this is the same question asked of the whole subtree.
         */
        const above: DocNode | undefined = kid.parent === i ? root : all[kid.parent]
        if (above === undefined || (above !== root && above.owner === undefined)) continue
        // A placement inside a prefab needs that prefab's definition resolved in the prefab's own room, and
        // nothing does that yet — so it is not offered rather than half-working.
        if (kid.authored.prefab !== undefined) continue
        out.push(j)
      }
      return out
    },

    revertPlacement: (i) => {
      const root = node(i)
      const placement = root === undefined || root.owner !== undefined ? undefined : root.authored
      if (placement?.prefab === undefined) return
      /**
       * Looking like the prefab (ADR 0151): every record cleared — which takes what was added under a piece
       * with it, and brings back what was removed, since a removal is kept on the removed piece's own record —
       * and whatever ADR 0130 kept on the placement's own node taken off it. One batch, one undo.
       *
       * It used to clear the records and then remove the added children one by one, which failed as soon as a
       * piece had both: the record had already taken its children.
       */
      const ops: Op[] = Object.keys(placement.overrides ?? {}).map((key): Op => ({ kind: 'setNodeOverride', owner: placement.id, node: key, override: null }))
      for (const kid of placement.children ?? []) ops.push({ kind: 'removeNode', id: kid.id })
      for (const c of placement.components) ops.push({ kind: 'removeComponent', id: placement.id, componentId: c.id })
      if (ops.length > 0) commit(ops)
    },

    placementOverrideOps: (i) => {
      const root = node(i)
      const assetId = root?.authored.prefab
      if (root === undefined || assetId === undefined) return null
      /**
       * A piece this placement did without is deleted from the prefab (ADR 0133), which is what Apply means
       * everywhere else: make the prefab match this copy. The far-reaching one — every placement in every level
       * loses it — and Ctrl+Z is the way back. First, so the orders below are the ones left after it.
       */
      const ops: Op[] = self.placementRemoved(i).map((id): Op => ({ kind: 'removeNode', id }))
      // Every record: its node's fields, then its added children and their order (`childrenToPrefab`).
      for (const index of recordedIn(i)) {
        const piece = self.overrideOpsFor(index)
        // Same prefab by construction — the filter in `placementOverrides` already said so.
        if (piece !== null) ops.push(...piece.ops)
      }
      /**
       * What ADR 0130 kept on the placement's own node becomes children of the prefab's root, re-ided — a
       * prefab's ids are its own — and unconverted: a child of the placement and one of the prefab's root are
       * in the same frame. A placement among them is skipped, since a prefab holds none (ADR 0023).
       */
      const definition = level.prefabs?.[assetId]
      let at = definition?.children?.length ?? 0
      for (const kid of root.authored.children ?? []) {
        if (definition === undefined || kid.prefab !== undefined) continue
        const copy = structuredClone(kid)
        reidSubtree(copy)
        ops.push({ kind: 'insertNode', parent: definition.id, index: at++, node: copy })
      }
      return ops.length === 0 ? null : { assetId, ops }
    },

    posesAt: (timeMs, opts) => {
      const all = nodes()
      const withSequences = opts?.sequences === true
      // The preview starts at 0 on both clocks, as a screen does that has just loaded the level.
      const clocks = { shared: timeMs, local: timeMs }
      /** Each node's own rotation including its sequences' turn, and its own scale: what its children accumulate. */
      const ownRot: Quat[] = []
      const ownScale: Vec3[] = []
      /** The product of every ancestor's rotation and scale, built downward. */
      const chainRot: Quat[] = []
      const chainScale: Vec3[] = []
      const shownAt: boolean[] = []
      /** Each node's own sequences, for its children to find the steps aimed at them. */
      const ownSequences: CompiledSequence[][] = []
      const out: PreviewPose[] = []
      for (let i = 0; i < all.length; i += 1) {
        const n = all[i]!
        const t = n.view.transform
        const rest = t.rotation ?? vec3(0, 0, 0)

        const p = n.parent
        // A parent precedes its children in a depth-first list, so its own contribution is already computed.
        const pr = p >= 0 ? (chainRot[p] ?? quat()) : quat()
        const ps = p >= 0 ? (chainScale[p] ?? vec3(1, 1, 1)) : vec3(1, 1, 1)
        const parentRot = p >= 0 ? mulQuat(pr, ownRot[p] ?? quat()) : quat()
        const parentScale =
          p >= 0
            ? (() => {
                const s = ownScale[p] ?? vec3(1, 1, 1)
                return vec3(ps.x * s.x, ps.y * s.y, ps.z * s.z)
              })()
            : vec3(1, 1, 1)
        chainRot[i] = parentRot
        chainScale[i] = parentScale

        // Its own sequences' steps aimed at itself, and its parent's aimed at it by id — the loader's rule, so
        // the preview moves exactly what the game will (ADR 0141).
        const mine = withSequences ? sequencesOn(n.view.components) : []
        ownSequences[i] = mine
        const aimed = [
          ...mine.filter((c) => c.tracks.has(SELF)).map((c) => ({ c, key: SELF })),
          ...(withSequences && p >= 0 ? (ownSequences[p] ?? []) : []).filter((c) => c.tracks.has(n.authored.id)).map((c) => ({ c, key: n.authored.id })),
        ]
        const seq =
          aimed.length === 0
            ? UNMOVED
            : combineSequences(
                aimed.map(({ c, key }) => ({ pose: sampleSequence(c, clocks).get(key) ?? AT_REST_POSE, axes: c.sequence.axes })),
                { parentRot, parentScale, ownRotation: rest },
              )
        const placed = eulerToQuat(rest)
        ownRot[i] = aimed.length === 0 ? placed : mulQuat(placed, seq.rotation)
        const authoredScale = t.scale ?? vec3(1, 1, 1)
        ownScale[i] = vec3(authoredScale.x * seq.scale.x, authoredScale.y * seq.scale.y, authoredScale.z * seq.scale.z)
        shownAt[i] = seq.enabled !== false && (p >= 0 ? (shownAt[p] ?? true) : true)

        out.push({
          position: { x: t.position.x + seq.position.x, y: t.position.y + seq.position.y, z: t.position.z + seq.position.z },
          rotation: rest,
          turn: seq.rotation,
          scale: ownScale[i]!,
          opacity: seq.opacity,
          shown: shownAt[i]!,
        })
      }
      return out
    },

    poseOf: (i, timeMs, opts) => {
      // One walk, not a second implementation of it: the loader composes the whole tree top-down, and a pose
      // climbed up to separately is a pose that can drift from it (ADR 0106's lesson).
      const found = self.posesAt(timeMs, opts)[i]
      if (found !== undefined) return found
      return { position: vec3(0, 0, 0), rotation: vec3(0, 0, 0), turn: quat(), scale: vec3(1, 1, 1), opacity: 1, shown: true }
    },
    movesAt: (i) => {
      const n = node(i)
      if (n === undefined) return false
      if (sequencesOn(n.view.components).some((c) => c.tracks.has(SELF))) return true
      const parent = n.parent >= 0 ? node(n.parent) : undefined
      return parent !== undefined && sequencesOn(parent.view.components).some((c) => c.tracks.has(n.authored.id))
    },
    fadesAt: (i) => {
      const n = node(i)
      if (n === undefined) return false
      if (sequencesOn(n.view.components).some((c) => channelsOf(c, SELF).opacity)) return true
      const parent = n.parent >= 0 ? node(n.parent) : undefined
      return parent !== undefined && sequencesOn(parent.view.components).some((c) => channelsOf(c, n.authored.id).opacity)
    },

    /**
     * Carries the resolved definitions beside the references, so a placement pasted into a level that has
     * never referenced that prefab can resolve it without waiting for the asset library.
     *
     * The references themselves travel unchanged: an asset id means the same prefab in every level (ADR 0091),
     * which is what makes copying a placement between levels *share* the prefab instead of duplicating it.
     */
    /**
     * The subtree on the clipboard.
     *
     * **A prefab's piece copies as what it looks like** (ADR 0131). An inherited node belongs to the prefab
     * and cannot be edited here, but a *copy* of it is a plain object like any other, so the clipboard takes
     * its resolved view — overrides baked in, since that is the thing on screen that was copied. Before this
     * it returned `null` and `copySelected` dropped it, so Ctrl+C on a prefab piece silently did nothing.
     *
     * `view` is already the whole resolved subtree: `bakeOverrides` recurses. Ids are not re-minted here
     * because `paste` does it, the same as for an own node.
     */
    copy: (i) => {
      const n = own(i) ?? node(i)
      if (n === undefined) return null
      const source = n.owner === undefined ? n.authored : n.view
      const prefabs: Record<string, Node> = {}
      forEachNode([source], (x) => {
        if (x.prefab === undefined) return
        const found = level.prefabs?.[x.prefab]
        if (found !== undefined) prefabs[x.prefab] = structuredClone(found)
      })
      return { node: structuredClone(source), prefabs }
    },
    paste: (item, parent) => {
      const fresh = structuredClone(item.node)
      /**
       * Re-point every reference at this document's table, interning what is missing, and re-mint every node
       * id so two pastes of one clipboard are two distinct nodes rather than a tree with duplicate ids.
       *
       * A key already present with an identical definition is reused (`freeTableId` does that comparison),
       * which keeps pasting a prefab back into its own level from filling the table with copies.
       */
      /**
       * References are kept exactly as they were — an asset id addresses the same prefab everywhere — and a
       * definition the clipboard carried is put in the resolution map when this document cannot resolve it
       * yet. That is not an op and is never written to the level (`prefabs.ts`).
       *
       * A reference this document cannot resolve at all is **kept**, not dropped: it is inert until the
       * prefab file is there, the same way a missing prefab behaves anywhere else (ADR 0091).
       */
      forEachNode([fresh], (x) => {
        if (x.prefab === undefined || level.prefabs?.[x.prefab] !== undefined) return
        const carried = item.prefabs[x.prefab]
        if (carried === undefined) return
        ;(level.prefabs ??= {})[x.prefab] = structuredClone(carried)
      })
      reidSubtree(fresh)
      // Refused here as in `placePrefab`: a level this game cannot load must not be producible by any door
      // (ADR 0076). A pasted placement brings the prefab's components with it.
      for (const carried of Object.values(item.prefabs)) if (unknownComponentTypes(carried, registry).length > 0) return -1
      // A prefab holds no prefabs, so a placement pasted into one would be a reference this schema forbids.
      if (mode === 'prefab' && fresh.prefab !== undefined) return -1

      // Last under `parent`, wherever its children are kept — a piece's in its record (ADR 0151).
      const host = hostOf(parent)
      if (host === null) return -1
      commit(insertOps(host, fresh, END))
      return indexOfId(fresh.id)
    },
    refOf: (i) => node(i)?.authored.prefab ?? null,
    definitionOf: (i) => {
      const n = own(i)
      if (n === undefined || n.authored.prefab !== undefined || mode === 'prefab') return null
      // The node's contents, at the origin: where the prefab sits is each placement's business.
      return {
        id: 'root',
        ...(n.authored.name !== undefined ? { name: n.authored.name } : {}),
        transform: { position: vec3(0, 0, 0) },
        components: structuredClone(n.authored.components),
        ...(n.authored.children !== undefined ? { children: structuredClone(n.authored.children) } : {}),
      }
    },
    linkToPrefab: (i, assetId, root) => {
      const n = own(i)
      if (n === undefined || n.authored.prefab !== undefined || mode === 'prefab') return false
      // Resolved for this document so the inherited nodes read at once; not an op, and never written to the level.
      ;(level.prefabs ??= {})[assetId] = root
      const { children: _kids, ...rest } = n.authored
      const placement: Node = { ...rest, components: [], prefab: assetId }
      commit([{ kind: 'replaceNode', id: n.authored.id, node: placement }])
      return true
    },
    unlinkPrefab: (id) => {
      if (mode === 'prefab') return 0
      const ops: Op[] = []
      const walk = (nodes: readonly Node[]): void => {
        for (const n of nodes) {
          // `unlinkedNode` needs the registry for two things this package cannot know: which components are
          // singletons, and which parameters are node references that must follow a re-id.
          if (n.prefab === id) ops.push({ kind: 'replaceNode', id: n.id, node: unlinkedNode(level, n, id, { types: registry, freshId, refKeysOf: refKeys }) })
          for (const kids of childListsOf(n)) walk(kids)
        }
      }
      walk(level.nodes)
      if (ops.length > 0) commit(ops)
      return ops.length
    },
    unlinkNode: (i) => {
      const n = node(i)
      const id = n?.authored.prefab
      // Only a placement, and only one this document owns: an inherited node is part of a prefab's own
      // definition, and there is nothing in this level to rewrite for it.
      if (n === undefined || id === undefined || n.owner !== undefined) return false
      const next = unlinkedNode(level, n.authored, id, { types: registry, freshId, refKeysOf: refKeys })
      if (next === n.authored) return false
      commit([{ kind: 'replaceNode', id: n.authored.id, node: next }])
      return true
    },
    nodeEnabled: (i) => node(i)?.view.enabled !== false,
    setNodeEnabled: (i, on) => {
      const n = node(i)
      if (n === undefined) return
      commit([
        n.owner === undefined
          ? { kind: 'setNodeEnabled', id: n.authored.id, enabled: on }
          : { kind: 'setOverrideNodeEnabled', owner: n.owner.id, node: n.authored.id, enabled: on },
      ])
    },
    disabledByAncestor: (i) => {
      // Walked rather than stored: the flag cascades by *omission* — a disabled node's children are never
      // reached — so nothing writes a derived value onto them and switching a parent back on restores
      // whatever the children said (ADR 0099).
      const all = nodes()
      let at = all[i]?.parent ?? -1
      while (at >= 0) {
        if (all[at]?.view.enabled === false) return true
        at = all[at]?.parent ?? -1
      }
      return false
    },
    prefabAt: (id) => level.prefabs?.[id],
    refCount: (id) => {
      let count = 0
      forEachNode(roots, (x) => {
        if (x.prefab === id) count++
      })
      return count
    },
    asLevel: () => level,
    environment: () => level.config.environment,
    setEnvironment: (env) => {
      // Prefab mode edits a throwaway wrapper level, so its config is not saved anywhere. Refusing here beats
      // writing a sun into a file that has no place to keep it.
      if (mode === 'prefab') return
      commit([{ kind: 'setEnvironment', environment: env }])
    },
    netBounds: () => (mode === 'prefab' ? undefined : level.config.netBounds),
    setNetBounds: (metres) => {
      if (mode === 'prefab') return
      commit([{ kind: 'setNetBounds', netBounds: metres }])
    },
    cameraSeeThrough: () => mode !== 'prefab' && level.config.cameraSeeThrough === true,
    setCameraSeeThrough: (on) => {
      if (mode === 'prefab') return
      commit([{ kind: 'setCameraSeeThrough', seeThrough: on }])
    },
    modeRef: () => (mode === 'prefab' ? undefined : level.config.mode),
    setMode: (name) => {
      if (mode === 'prefab') return // a prefab belongs to no game, for the same reason it has no sun
      commit([{ kind: 'setMode', mode: name === null ? null : { name } }])
    },
    toJSON: opts.json,
    // Not an op: the id follows the file name at save, and a prefab's root name is its file's. Live, the server
    // sets the level's id before every write (ADR 0089).
    setId: (id) => {
      level.id = id
      if (mode === 'prefab' && roots[0] !== undefined) roots[0].name = id
    },
  }
  return self
}

export const levelDoc = (level: Level, registry: Registry = DEFAULT_REGISTRY): Doc =>
  docOver(level, { mode: 'level', registry, json: () => level })

/**
 * A prefab, edited as a document of one root node.
 *
 * Wrapped in a throwaway level so there is one implementation instead of two: a prefab is a node tree, and a
 * level is a node tree with a table.
 *
 * Its config is **empty**, and that is now the honest answer: a prefab belongs to no game, so it declares no
 * game's settings. It used to have to spell out `physical-fall` and a distant `fallY` purely to stop parkour's
 * kill plane from deleting the test character — a wrapper working around a rule it had no business carrying
 * (ADR 0052).
 */
export const prefabDoc = (root: Node, registry: Registry = DEFAULT_REGISTRY, opts: { table?: string } = {}): Doc =>
  docOver(
    { id: root.name ?? root.id, config: {}, nodes: [root] },
    { mode: 'prefab', registry, json: () => root, ...(opts.table !== undefined ? { table: opts.table } : {}) },
  )

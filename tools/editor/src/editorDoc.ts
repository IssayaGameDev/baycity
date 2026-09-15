import {
  bakeOverrides,
  boolParam,
  effectiveNode,
  numberParam,
  poseAt,
  vec3Param,
  stringParam,
  COLLIDER,
  LIGHT,
  MATERIAL_OVERRIDE,
  TRACK,
  MESH,
  RENDERER,
  type Behavior,
  type ClipSource,
  type ColliderDesc,
  type ComponentData,
  type Keyframe,
  type LoopMode,
  type Node,
  type Level,
  type NodeOverride,
  type Pose,
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
} from '@mp/content'
import { DEFAULT_REGISTRY, type Registry } from '@mp/components'
import type { LightDesc } from '@mp/render-three'
import { vec3, type Vec3 } from '@mp/core'

import { sortedKeys } from './trackEdit'

/**
 * Editor document abstraction, over a **node tree** (PLAN-component-system, stage C1).
 *
 * One node type replaced `Piece` and `PrefabInstance`, and the whole instance-versus-piece split went with
 * it. What is left is a single distinction that is about *ownership* rather than about kind: a node is either
 * **own** (this document authored it, so edits write straight to it) or **inherited** (it belongs to a prefab
 * this placement references, so edits become overrides on the placement). Everything a node has — collider,
 * visual, motion, gameplay rule — is a component in a list, added and removed like Unity's.
 *
 * **Nodes are addressed by depth-first index**, recomputed per call. A cache would have to be invalidated by
 * every mutation, including one made through the level object rather than through this doc, and the day it
 * missed, an index would silently address the wrong node. Tens of nodes, so the walk costs nothing worth that
 * risk. Indices shift when the tree changes, which is safe because every structural edit rebuilds the meshes,
 * the physics world and the panels; the mutating calls return where the node landed.
 *
 * Order per node: the node, then what it inherits from its prefab, then its own children. Inherited first
 * because they are what the object *is*; a child is something placed on it.
 */
export type Mode = 'level' | 'prefab'

/**
 * Whether this document owns the node or inherits it from a prefab.
 *
 * The operations that differ are structural: an inherited node cannot be deleted, re-ordered, re-parented or
 * copied through the placement, because its position belongs to the prefab. Its *contents* are fully
 * editable — as overrides.
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
  const walk = (n: Node): void => {
    for (const c of n.components) seen.add(c.type)
    for (const kid of n.children ?? []) walk(kid)
  }
  walk(root)
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
  const walk = (n: unknown): void => {
    if (!isObj(n)) return
    if (Array.isArray(n['components'])) for (const c of n['components']) if (isObj(c) && typeof c['type'] === 'string') seen.add(c['type'])
    if (Array.isArray(n['children'])) for (const kid of n['children']) walk(kid)
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
  reparent: (from: number, parent: number | null, at: number) => number
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

  // ---- keyframes ----------------------------------------------------------------------------------
  /**
   * Every keyframe parameter on this node — what a timeline can edit.
   *
   * Addressed by **component and parameter name**, not as "the node's Track". A `keys` parameter is a
   * declaration like any other, so the timeline is the editor for that *kind of parameter* rather than for
   * one privileged component type. `Track` is the only component that declares one today.
   */
  keyEditors: (i: number) => readonly KeyEditor[]
  /** The keys of one such parameter, or `null` when the component is no longer there. */
  keysOf: (i: number, editor: KeyEditor) => readonly Keyframe[] | null
  /** Replace them. Sorted on the way in, so the strip and the evaluator agree on order. */
  setKeys: (i: number, editor: KeyEditor, keys: readonly Keyframe[]) => void
  /** The node's local pose at a track time — what a scrub draws, and what the gizmo writes into a key. */
  poseOf: (i: number, timeMs: number) => Pose

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
   * Which game this level is for (ADR 0052). `undefined` for an unassigned level, and always for a prefab —
   * a prefab belongs to no game.
   */
  modeRef: () => ModeRef | undefined
  /** Reassign the level to a game, or to none. */
  setMode: (name: string | null) => void
  /** Save writes under a file name; the id follows it, or the two silently diverge. */
  setId: (id: string) => void
}

/**
 * Which keyframe parameter a timeline is editing: a component on a node, and one of its `keys` parameters.
 *
 * Two names rather than one, because a component may in principle declare more than one keyframe parameter,
 * and because a component id alone would not say which of them the strip has open.
 */
export interface KeyEditor {
  readonly componentId: string
  /** The component's registry type, for the panel's heading. */
  readonly type: string
  readonly param: string
  /**
   * The sibling asset parameter that may hold these keys as a clip, or `null` when the declaration names none
   * (ADR 0050).
   *
   * Read off the `keys` declaration rather than assumed to be called `clip`, so the panel still addresses a
   * parameter and not a component it knows the shape of — which is the whole point of ADR 0037.
   */
  readonly clipParam: string | null
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
/** A built-in shape as a node (ADR 0090): unit collider, the `Mesh`, an unsurfaced `Renderer`, the preset scale. */
const primitiveNode = (kind: PrimitiveKind, position: Vec3, name: string = kind): Node => {
  const preset = PRIMITIVE_PRESETS[kind]
  const one = preset.scale.x === 1 && preset.scale.y === 1 && preset.scale.z === 1
  return {
    id: freshId(),
    name,
    transform: { position, ...(one ? {} : { scale: { ...preset.scale } }) },
    components: [component(COLLIDER, { shape: unitColliderFor(preset.model), center: ZERO }), component(MESH, { model: preset.model }), component(RENDERER, { material: '' })],
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
 * `model` given adds a `Mesh` between the collider and the renderer, in that reading order: what it collides
 * as, what it looks like, that it draws. Omitted, the `Renderer` alone draws the collider shape (ADR 0039).
 */
const solidNode = (shape: ColliderDesc, transform: Transform, name?: string, model?: string): Node => ({
  id: freshId(),
  ...(name !== undefined ? { name } : {}),
  transform,
  components: [
    component(COLLIDER, { shape, center: ZERO }),
    ...(model !== undefined ? [component(MESH, { model })] : []),
    component(RENDERER, { material: '' }),
  ],
})

/**
 * The `Behavior` a `Track` component describes, for posing a node at a track time.
 *
 * Inline keys first, then the clip the component names — the same precedence the loader applies, and it has
 * to be the same or the editor would draw a mover the game plays differently (ADR 0050).
 */
const behaviorOf = (c: ComponentData | undefined, clips: ClipSource | undefined): Behavior => {
  if (c === undefined) return { kind: 'static' }
  const inline = c.params.keys
  const clip = c.params.clip
  const keys =
    Array.isArray(inline) && inline.length > 0
      ? (inline as readonly Keyframe[])
      : typeof clip === 'string' && clip !== ''
        ? (clips?.keys(clip) ?? [])
        : []
  if (keys.length === 0) return { kind: 'static' }
  return {
    kind: 'track',
    keys,
    loop: stringParam(c, 'loop', 'loop') as LoopMode,
    phaseMs: Number(c.params.phaseMs ?? 0),
  }
}

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
  index: number
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
  opts: { mode: Mode; registry: Registry; clips?: ClipSource; json: () => Level | Node; table?: string },
): Doc => {
  const { mode, registry, clips } = opts
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
    if (r.ops.length === 0) return
    self.onOps?.({ ops: r.ops.map(stamp), inverses: r.inverses.map(stamp) })
  }

  const nodes = (): DocNode[] => {
    const out: DocNode[] = []
    const push = (authored: Node, owner: Node | undefined, siblings: Node[] | undefined, index: number, parent: number, depth: number, path: string): void => {
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
      out.push({ view, authored, owner, siblings, index, parent, depth, path })

      const ref = owner === undefined ? authored.prefab : undefined
      if (ref !== undefined) {
        // Inherited: the prefab's own child objects, so a write can reach the definition.
        const root = level.prefabs?.[ref]
        ;(root?.children ?? []).forEach((kid, k) => push(kid, authored, undefined, k, self, depth + 1, `${path}#${k}`))
      } else if (owner !== undefined) {
        ;(authored.children ?? []).forEach((kid, k) => push(kid, owner, undefined, k, self, depth + 1, `${path}#${k}`))
      }
      if (owner === undefined) {
        const own = authored.children
        if (own !== undefined) own.forEach((kid, k) => push(kid, undefined, own, k, self, depth + 1, `${path}/${k}`))
      }
    }
    roots.forEach((n, index) => push(n, undefined, roots, index, -1, 0, String(index)))
    return out
  }

  const node = (i: number): DocNode | undefined => nodes()[i]
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
  const indexOfId = (id: string): number => nodes().findIndex((n) => n.owner === undefined && n.authored.id === id)
  const refOf = (n: DocNode): NodeRef => (n.owner === undefined ? (table_ === undefined ? { id: n.authored.id } : { table: table_, id: n.authored.id }) : { owner: n.owner.id, node: n.authored.id })

  /** The parent an insert names for the children of `host`: `null` for the level forest, else the node's id. */
  const parentIdOf = (host: Node[]): string | null => {
    if (host === roots) return null
    const owner = nodes().find((n) => n.owner === undefined && n.authored.children === host)
    return owner?.authored.id ?? null
  }

  /** This placement's override record for an inherited node, as it is. Writes go through ops (`ops.ts` tidies). */
  const overrideFor = (n: DocNode): NodeOverride | undefined => n.owner?.overrides?.[n.authored.id]

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
    if (own(from) === undefined) return false
    if (parent === null) return true
    if (parent === from || own(parent) === undefined) return false
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
      for (const kid of x.children ?? []) rename(kid)
    }
    rename(root)

    const retarget = (c: ComponentData): void => {
      for (const key of refKeys(c.type)) {
        const was = c.params[key]
        if (typeof was !== 'string') continue
        const to = map.get(was)
        if (to !== undefined) c.params[key] = to
      }
    }
    const repoint = (x: Node): void => {
      for (const c of x.components) retarget(c)
      // An override patches a component that lives in the prefab, so its *type* has to be looked up there
      // before its reference parameters are known.
      const inherited = x.prefab === undefined ? undefined : level.prefabs?.[x.prefab]
      for (const over of Object.values(x.overrides ?? {})) {
        for (const c of over.added ?? []) retarget(c)
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
      for (const kid of x.children ?? []) repoint(kid)
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
  const trackComponent = (n: DocNode): ComponentData | undefined => n.view.components.find((c) => c.type === TRACK && enabledOf(c))

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

  const patchParams = (i: number, componentId: string, patch: Record<string, unknown>): void => {
    const n = node(i)
    if (n === undefined) return
    const target = n.view.components.find((x) => x.id === componentId)
    if (target === undefined) return
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
    if (target.type === MESH && isBuiltinModel(patch.model)) {
      const unit = unitColliderFor(patch.model)
      for (const c of n.view.components) if (c.type === COLLIDER) ops.push(paramsOp(c.id, { shape: unit }))
    }
    const real = ops.filter((o): o is Op => o !== null)
    if (real.length > 0) commit(real)
  }

  const builtinOf = (i: number): BuiltinModel | null => {
    const n = node(i)
    if (n === undefined) return null
    const mesh = n.view.components.find((c) => c.type === MESH && enabledOf(c))
    const model = mesh === undefined ? '' : stringParam(mesh, 'model', '')
    return isBuiltinModel(model) ? model : null
  }

  /** Keyframe parameters on a node, in component order then declaration order. */
  const keyEditors = (i: number): KeyEditor[] => {
    const n = node(i)
    if (n === undefined) return []
    const out: KeyEditor[] = []
    for (const c of n.view.components) {
      if (c.enabled === false) continue
      const def = registry.get(c.type)
      if (def === undefined) continue
      for (const [param, spec] of Object.entries(def.params))
        if (spec.kind === 'keys') out.push({ componentId: c.id, type: c.type, param, clipParam: spec.clip ?? null })
    }
    return out
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
    if (n.owner === undefined) commit([{ kind: 'addComponent', id: n.authored.id, component: fresh }])
    else commit([{ kind: 'addOverrideComponent', owner: n.owner.id, node: n.authored.id, component: fresh }])
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
    ops.push({ kind: 'setOverrideRemoved', owner, node: nodeId, componentId, removed: true })
    commit(ops)
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
     * worth having. A `Mesh` replaces them all with a single model, since the model is the whole object's
     * appearance and the colliders are only how it collides.
     *
     * A `Renderer` is what makes any of it visible: without one this draws nothing, the way a `MeshFilter`
     * with no `MeshRenderer` shows nothing (ADR 0039).
     */
    meshSpecs: (i) => {
      const n = node(i)
      if (n === undefined) return []
      const renderer = n.view.components.find((c) => c.type === RENDERER && enabledOf(c))
      if (renderer === undefined) return []
      const material = inheritedMaterial(i) ?? stringParam(renderer, 'material', '')
      const surfaced = material === '' ? undefined : material
      const mesh = n.view.components.find((c) => c.type === MESH && enabledOf(c))
      const model = mesh === undefined ? '' : stringParam(mesh, 'model', '')
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
        * on its own side, and the save strips whatever was resolved (`prefabs.ts`).
        */
      ;(level.prefabs ??= {})[assetId] = root
      const placed: Node = { id: freshId(), transform: { position }, components: [], prefab: assetId }
      commit([{ kind: 'insertNode', parent: null, index: roots.length, node: placed }])
      return indexOfId(placed.id)
    },
    placeEmpty: (position, parent) => {
      const fresh: Node = { id: freshId(), name: 'empty', transform: { position }, components: [] }
      let host: Node | undefined
      if (parent !== null) {
        host = own(parent)?.authored
        // An inherited node's children belong to the prefab, so there is nowhere here to put one.
        if (host === undefined) return -1
      } else if (mode === 'prefab') {
        host = roots[0]
        if (host === undefined) return -1
      }
      commit([{ kind: 'insertNode', parent: host?.id ?? null, index: host === undefined ? roots.length : (host.children?.length ?? 0), node: fresh }])
      return indexOfId(fresh.id)
    },
    placePrimitive: (kind, position, parent) => {
      const fresh = primitiveNode(kind, position)
      let host: Node | undefined
      if (parent !== null) {
        host = own(parent)?.authored
        if (host === undefined) return -1
      } else if (mode === 'prefab') {
        host = roots[0]
        if (host === undefined) return -1
      }
      commit([{ kind: 'insertNode', parent: host?.id ?? null, index: host === undefined ? roots.length : (host.children?.length ?? 0), node: fresh }])
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
    // without it. An inherited node cannot go — it would have to go from every placement of the prefab.
    remove: (i) => {
      const n = own(i)
      if (n?.siblings === undefined) return
      commit([{ kind: 'removeNode', id: n.authored.id }])
    },
    // A clone of a placement references the same table entry. Cloning the *definition* would quietly break
    // the very link the reference exists to provide. Children come along; ids are re-minted.
    duplicate: (i) => {
      const n = own(i)
      if (n?.siblings === undefined) return i
      const copy = structuredClone(n.authored)
      reidSubtree(copy)
      commit([{ kind: 'insertNode', parent: parentIdOf(n.siblings), index: n.index + 1, node: copy }])
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
      const n = own(from)
      if (n?.siblings === undefined) return from
      const at = moveTarget(n.siblings.length, n.index, to)
      if (at === n.index) return from
      commit([{ kind: 'moveNode', id: n.authored.id, parent: parentIdOf(n.siblings), index: at }])
      return indexOfId(n.authored.id)
    },
    depthOf: (i) => node(i)?.depth ?? 0,
    parentOf: (i) => {
      const parent = node(i)?.parent
      return parent === undefined || parent < 0 ? null : parent
    },
    siblingIndexOf: (i) => node(i)?.index ?? 0,
    pathOf: (i) => node(i)?.path ?? '',
    // Inherited nodes count as contents too: they are what one twist in the Hierarchy opens, alongside the
    // placement's own children.
    childCount: (i) => {
      const n = node(i)
      if (n === undefined) return 0
      const ref = n.owner === undefined ? n.authored.prefab : undefined
      const inherited = ref === undefined ? 0 : (level.prefabs?.[ref]?.children ?? []).length
      return inherited + (n.authored.children?.length ?? 0)
    },
    canReparent,
    reparent: (from, parent, atIndex) => {
      const n = own(from)
      if (n?.siblings === undefined || !canReparent(from, parent)) return from
      const target = parent === null ? undefined : own(parent)!.authored
      const host = target === undefined ? roots : (target.children ?? [])
      const sameList = host === n.siblings
      const insertAt = Math.max(0, Math.min(sameList ? host.length - 1 : host.length, sameList && atIndex > n.index ? atIndex - 1 : atIndex))
      commit([{ kind: 'moveNode', id: n.authored.id, parent: target?.id ?? null, index: insertAt }])
      return indexOfId(n.authored.id)
    },
    assetIds: () => {
      const ids = new Set<string>()
      const add = (components: readonly ComponentData[]): void => {
        for (const c of components) {
          if (c.type === MESH) {
            const model = stringParam(c, 'model', '')
            // A built-in shape is geometry, not a file: nothing to fetch (ADR 0090).
            if (model !== '' && !isBuiltinModel(model)) ids.add(model)
          } else if (c.type === RENDERER || c.type === MATERIAL_OVERRIDE) {
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
      return n.view.components.map((c) => {
        const patch = over?.params?.[c.id]
        const overridden = patch === undefined ? [] : Object.keys(patch)
        if (over?.enabled?.[c.id] !== undefined) overridden.push('enabled')
        return {
          id: c.id,
          type: c.type,
          params: c.params,
          enabled: enabledOf(c),
          inherited: n.owner !== undefined && !addedIds.has(c.id),
          added: addedIds.has(c.id),
          overridden,
        }
      })
    },
    canAdd,
    addComponent,
    removeComponent,
    setParams: patchParams,
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
      const all = nodes()
      const visible = (o: DocNode): boolean => (n.owner === undefined ? o.owner === undefined : o.owner === n.owner || o.owner === undefined)
      return all
        .map((o, at) => ({ o, at }))
        .filter(({ o }) => visible(o))
        .map(({ o, at }) => ({ id: o.authored.id, label: labelAt(at) }))
    },
    overridesOf: (i) => {
      const n = node(i)
      const over = n === undefined ? undefined : overrideFor(n)
      if (over === undefined || n === undefined) return []
      const out: string[] = []
      if (over.transform !== undefined) out.push('transform')
      if (over.name !== undefined) out.push('name')
      const typeOf = (id: string): string => n.view.components.find((c) => c.id === id)?.type ?? id
      for (const id of Object.keys(over.params ?? {})) out.push(typeOf(id))
      for (const id of Object.keys(over.enabled ?? {})) out.push(`${typeOf(id)} (off)`)
      for (const c of over.added ?? []) out.push(`${c.type} (added)`)
      for (const id of over.removed ?? []) out.push(`${id} (removed)`)
      return out
    },
    revert: (i, field) => {
      const n = node(i)
      if (n?.owner === undefined) return
      const current = overrideFor(n)
      if (current === undefined) return
      // The record as it will be: everything, or one field, or one component's every trace, gone.
      let next: NodeOverride | null = structuredClone(current)
      if (field === undefined) next = null
      else if (field === 'transform' || field === 'name') delete next[field]
      else {
        delete next.params?.[field]
        delete next.enabled?.[field]
        if (next.added !== undefined) next.added = next.added.filter((c) => c.id !== field)
        if (next.removed !== undefined) next.removed = next.removed.filter((id) => id !== field)
      }
      commit([{ kind: 'setNodeOverride', owner: n.owner.id, node: n.authored.id, override: next }])
    },
    /**
     * Promote this placement's overrides into the shared prefab, then drop them.
     *
     * Every other placement of that prefab changes, which is the point — and why this is a deliberate action
     * rather than something an edit does on its own.
     */
    overrideOpsFor: (i) => {
      const n = node(i)
      if (n?.owner?.prefab === undefined) return null
      const over = overrideFor(n)
      if (over === undefined) return null
      // Plain ops, with no table scope: they go to the prefab's own document, whose forest is its one root.
      const id = n.authored.id
      const target = n.authored
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
      return { assetId: n.owner.prefab, ops }
    },

    keyEditors,
    keysOf: (i, editor) => {
      const c = node(i)?.view.components.find((x) => x.id === editor.componentId)
      const keys = c?.params[editor.param]
      return Array.isArray(keys) ? (keys as readonly Keyframe[]) : c === undefined ? null : []
    },
    setKeys: (i, editor, keys) => patchParams(i, editor.componentId, { [editor.param]: sortedKeys(keys) }),
    poseOf: (i, timeMs) => {
      const n = node(i)
      if (n === undefined) return { position: vec3(0, 0, 0), rotation: vec3(0, 0, 0) }
      return poseAt(behaviorOf(trackComponent(n), clips), n.view.transform, timeMs)
    },

    /**
     * Carries the resolved definitions beside the references, so a placement pasted into a level that has
     * never referenced that prefab can resolve it without waiting for the asset library.
     *
     * The references themselves travel unchanged: an asset id means the same prefab in every level (ADR 0091),
     * which is what makes copying a placement between levels *share* the prefab instead of duplicating it.
     */
    copy: (i) => {
      const n = own(i)
      if (n === undefined) return null
      const prefabs: Record<string, Node> = {}
      const collect = (x: Node): void => {
        if (x.prefab !== undefined) {
          const found = level.prefabs?.[x.prefab]
          if (found !== undefined) prefabs[x.prefab] = structuredClone(found)
        }
        for (const kid of x.children ?? []) collect(kid)
      }
      collect(n.authored)
      return { node: structuredClone(n.authored), prefabs }
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
      const resolve = (x: Node): void => {
        if (x.prefab !== undefined && level.prefabs?.[x.prefab] === undefined) {
          const carried = item.prefabs[x.prefab]
          if (carried !== undefined) (level.prefabs ??= {})[x.prefab] = structuredClone(carried)
        }
        for (const kid of x.children ?? []) resolve(kid)
      }
      resolve(fresh)
      reidSubtree(fresh)
      // Refused here as in `placePrefab`: a level this game cannot load must not be producible by any door
      // (ADR 0076). A pasted placement brings the prefab's components with it.
      for (const carried of Object.values(item.prefabs)) if (unknownComponentTypes(carried, registry).length > 0) return -1
      // A prefab holds no prefabs, so a placement pasted into one would be a reference this schema forbids.
      if (mode === 'prefab' && fresh.prefab !== undefined) return -1

      let host: Node | undefined
      if (parent === null) {
        if (mode === 'prefab') {
          host = roots[0]
          if (host === undefined) return -1
        }
      } else {
        host = own(parent)?.authored
        if (host === undefined) return -1
      }
      commit([{ kind: 'insertNode', parent: host?.id ?? null, index: host === undefined ? roots.length : (host.children?.length ?? 0), node: fresh }])
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
      // Resolved for this document so the inherited nodes read at once; not an op, never written (`prefabs.ts`).
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
          if (n.children !== undefined) walk(n.children)
        }
      }
      walk(level.nodes)
      if (ops.length > 0) commit(ops)
      return ops.length
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
      const walk = (x: Node): void => {
        if (x.prefab === id) count++
        for (const kid of x.children ?? []) walk(kid)
      }
      for (const n of roots) walk(n)
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

export const levelDoc = (level: Level, registry: Registry = DEFAULT_REGISTRY, clips?: ClipSource): Doc =>
  docOver(level, { mode: 'level', registry, ...(clips !== undefined ? { clips } : {}), json: () => level })

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
export const prefabDoc = (root: Node, registry: Registry = DEFAULT_REGISTRY, clips?: ClipSource, opts: { table?: string } = {}): Doc =>
  docOver(
    { id: root.name ?? root.id, config: {}, nodes: [root] },
    { mode: 'prefab', registry, ...(clips !== undefined ? { clips } : {}), json: () => root, ...(opts.table !== undefined ? { table: opts.table } : {}) },
  )

import {
  bakeOverrides,
  boolParam,
  effectiveNode,
  freeTableKey,
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
  type ColliderDesc,
  type ComponentData,
  type Keyframe,
  type LoopMode,
  type Node,
  type Level,
  type NodeOverride,
  type Pose,
  type EnvironmentConfig,
  type Transform,
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

export interface Doc {
  readonly mode: Mode
  /** Every component type this build knows, for the add menu. */
  readonly registry: Registry
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
  palette: () => string[]
  /** Place a palette entry. `-1` when the name is not in the library or this document's table. */
  place: (name: string, position: Vec3) => number
  /**
   * Place a model asset: a node with the mesh as its `Visual` and an authored box as its `Collider`. Visual is
   * not collision (ADR 0014), so a detailed prop collides as a shape somebody can see and resize.
   */
  placeModel: (assetId: string, position: Vec3) => number
  /**
   * Place a prefab that came from a file, **interned as a copy** into the table, so the level stays
   * self-contained: moving or deleting the prefab file afterwards can never leave the level without geometry.
   *
   * `name` is the file's name and becomes the table key — not any id stored inside the file, which is
   * routinely stale (`AlternatingDanger` shipped carrying `"id": "FastElevator"`, commit 0fc0b9f).
   */
  placePrefab: (root: Node, name: string, position: Vec3) => number
  /**
   * A node with only a transform — Unity's Create Empty.
   *
   * `parent` is a node to put it under, or `null` for the top level (the prefab's root, in prefab mode). It is
   * the only thing here that makes a *grouping handle*: everything else places geometry, so before this the
   * only way to get one was to place something and delete its components.
   */
  placeEmpty: (position: Vec3, parent: number | null) => number
  /** What a palette entry would place, without placing it — what a Project tile previews. */
  prefabForPalette: (name: string) => Node | undefined
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
  /** Push this placement's overrides into the shared prefab, so every placement gets them and this one is clean. */
  applyToPrefab: (i: number) => void

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
  /** The prefab key this node references, or `null`. */
  refOf: (i: number) => string | null
  /** Turn a plain node into a shared table entry and reference it. The new key, or `null`. */
  extract: (i: number) => string | null
  /** The shared definition behind a key — the object to edit so every placement follows. */
  prefabAt: (id: string) => Node | undefined
  /** How many placements reference `id`: what "edit this and 3 things move" is counting. */
  refCount: (id: string) => number
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
  /** The component's registry type, for the strip's heading. */
  readonly type: string
  readonly param: string
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
const PRIMITIVES: Record<string, () => ColliderDesc> = {
  box: () => ({ kind: 'box', halfExtents: vec3(1, 0.5, 1) }),
  platform: () => ({ kind: 'box', halfExtents: vec3(1.5, 0.15, 1.5) }),
  wall: () => ({ kind: 'box', halfExtents: vec3(1.5, 1, 0.15) }),
  ball: () => ({ kind: 'ball', radius: 0.5 }),
  capsule: () => ({ kind: 'capsule', halfHeight: 0.5, radius: 0.4 }),
}

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

/** The `Behavior` a `Track` component describes, for posing a node at a track time. */
const behaviorOf = (c: ComponentData | undefined): Behavior => {
  if (c === undefined) return { kind: 'static' }
  const keys = c.params.keys
  if (!Array.isArray(keys) || keys.length === 0) return { kind: 'static' }
  return {
    kind: 'track',
    keys: keys as readonly Keyframe[],
    loop: stringParam(c, 'loop', 'loop') as LoopMode,
    phaseMs: Number(c.params.phaseMs ?? 0),
  }
}

/**
 * Splice `arr`'s item at `from` so it lands *before* the original index `to`. `to` is expressed against the
 * array as it was, which is what a drop between two rows naturally gives you — hence the shift when moving
 * downward, where removing the item first pulls every later index back by one.
 */
const moveWithin = <T>(arr: T[], from: number, to: number): number => {
  if (from < 0 || from >= arr.length || from === to) return from
  const [item] = arr.splice(from, 1)
  const at = Math.max(0, Math.min(arr.length, to > from ? to - 1 : to))
  arr.splice(at, 0, item as T)
  return at
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
const docOver = (level: Level, opts: { mode: Mode; library: Record<string, Node>; registry: Registry; json: () => Level | Node }): Doc => {
  const { mode, library, registry } = opts
  const roots = level.nodes

  const nodes = (): DocNode[] => {
    const out: DocNode[] = []
    const push = (authored: Node, owner: Node | undefined, siblings: Node[] | undefined, index: number, parent: number, depth: number, path: string): void => {
      const self = out.length
      // A placement resolves against its prefab; an inherited node only needs its own patch applied. Both
      // land on the same shape, so nothing downstream asks which it was.
      let view: Node
      if (owner === undefined) {
        const r = effectiveNode(level, authored, registry)
        view = { id: r.id, ...(r.name !== undefined ? { name: r.name } : {}), transform: r.transform, components: [...r.components] }
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
  const indexOf = (authored: Node): number => nodes().findIndex((n) => n.authored === authored)

  const table = (): Record<string, Node> => (level.prefabs ??= {})
  /** Put `root` in the table under a free key (reusing an identical entry) and return that key. */
  const intern = (root: Node): string => {
    const t = table()
    const key = freeTableKey(t, root.name ?? root.id, root)
    t[key] ??= root
    return key
  }

  /** This placement's override record for an inherited node, created if asked for. */
  const overrideFor = (n: DocNode, create: boolean): NodeOverride | undefined => {
    const owner = n.owner
    if (owner === undefined) return undefined
    if (!create) return owner.overrides?.[n.authored.id]
    const map = (owner.overrides ??= {})
    return (map[n.authored.id] ??= {})
  }

  /** Remove an override with nothing left in it, and the map with it, so the JSON accumulates no husks. */
  const tidyOverride = (n: DocNode): void => {
    const owner = n.owner
    if (owner?.overrides === undefined) return
    const over = owner.overrides[n.authored.id]
    if (over !== undefined) {
      for (const k of ['params', 'enabled'] as const) {
        const sub = over[k]
        if (sub !== undefined && Object.keys(sub).length === 0) delete over[k]
      }
      for (const k of ['added', 'removed'] as const) {
        const arr = over[k]
        if (arr !== undefined && arr.length === 0) delete over[k]
      }
      if (Object.keys(over).length === 0) delete owner.overrides[n.authored.id]
    }
    if (Object.keys(owner.overrides).length === 0) delete owner.overrides
  }

  /** Drop a `children: []` left behind by a move, so the JSON accumulates no empty arrays. */
  const tidyChildren = (parent: Node | undefined): void => {
    if (parent?.children !== undefined && parent.children.length === 0) delete parent.children
  }

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

  /** Set some of a component's parameters, on the definition or as an override. */
  const patchParams = (i: number, componentId: string, patch: Record<string, unknown>): void => {
    const n = node(i)
    if (n === undefined) return
    if (n.owner === undefined) {
      const c = n.authored.components.find((x) => x.id === componentId)
      if (c !== undefined) c.params = { ...c.params, ...patch }
      return
    }
    const over = overrideFor(n, true)!
    // A component this placement added is the placement's own, so it is patched in place rather than through
    // a second layer that would shadow it.
    const added = over.added?.find((x) => x.id === componentId)
    if (added !== undefined) {
      added.params = { ...added.params, ...patch }
      return
    }
    const params = (over.params ??= {})
    params[componentId] = { ...params[componentId], ...patch }
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
      for (const [param, spec] of Object.entries(def.params)) if (spec.kind === 'keys') out.push({ componentId: c.id, type: c.type, param })
    }
    return out
  }

  const canAdd = (i: number, type: string): boolean => {
    const n = node(i)
    if (n === undefined || !registry.has(type)) return false
    if (registry.get(type)?.singleton !== true) return true
    return !n.view.components.some((c) => c.type === type)
  }

  const addComponent = (i: number, type: string): string | null => {
    const n = node(i)
    if (n === undefined || !canAdd(i, type)) return null
    const fresh: ComponentData = { id: freshId(), type, params: { ...registry.defaults(type) } }
    if (n.owner === undefined) {
      n.authored.components.push(fresh)
      return fresh.id
    }
    const over = overrideFor(n, true)!
    ;(over.added ??= []).push(fresh)
    return fresh.id
  }

  const moveComponent = (i: number, componentId: string, delta: number): void => {
    const n = node(i)
    if (n === undefined || n.owner !== undefined) return
    const list = n.authored.components
    const from = list.findIndex((c) => c.id === componentId)
    const to = from + delta
    if (from < 0 || to < 0 || to >= list.length) return
    const [moved] = list.splice(from, 1)
    list.splice(to, 0, moved as ComponentData)
  }

  const removeComponent = (i: number, componentId: string): void => {
    const n = node(i)
    if (n === undefined) return
    if (n.owner === undefined) {
      const at = n.authored.components.findIndex((c) => c.id === componentId)
      if (at >= 0) n.authored.components.splice(at, 1)
      return
    }
    const over = overrideFor(n, true)!
    // Removing something this placement added is an undo, not a removal recorded against the prefab.
    const at = over.added?.findIndex((c) => c.id === componentId) ?? -1
    if (at >= 0) {
      over.added!.splice(at, 1)
    } else {
      ;(over.removed ??= []).push(componentId)
      delete over.params?.[componentId]
      delete over.enabled?.[componentId]
    }
    tidyOverride(n)
  }

  return {
    mode,
    registry,
    count: () => nodes().length,
    kindOf: (i) => (node(i)?.owner === undefined ? 'own' : 'inherited'),
    transformOf: (i) => node(i)?.view.transform ?? { position: vec3(0, 0, 0) },
    setTransform: (i, t) => {
      const n = node(i)
      if (n === undefined) return
      if (n.owner === undefined) n.authored.transform = t
      else overrideFor(n, true)!.transform = t
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
    /**
     * In level mode, only what *this level* defines: prefab **files** are placed from the Project explorer by
     * asset id, and listing them here as well is what made one prefab appear twice. In prefab mode, primitives.
     */
    palette: () => (mode === 'prefab' ? Object.keys(PRIMITIVES) : Object.keys(level.prefabs ?? {})),
    place: (name, position) => {
      if (mode === 'prefab') {
        const make = PRIMITIVES[name] ?? PRIMITIVES['box']!
        const fresh = solidNode(make(), { position }, name)
        const host = roots[0]
        if (host === undefined) return -1
        ;(host.children ??= []).push(fresh)
        return indexOf(fresh)
      }
      let key: string
      if (level.prefabs?.[name] !== undefined) key = name
      else {
        const source = library[name]
        // A palette offering a name the library no longer has is a bug, not a crash: the file may have been
        // deleted between the panel drawing and the click landing.
        if (source === undefined) return -1
        key = intern({ ...structuredClone(source), name })
      }
      const placed: Node = { id: freshId(), transform: { position }, components: [], prefab: key }
      roots.push(placed)
      return indexOf(placed)
    },
    placePrefab: (root, name, position) => {
      if (mode === 'prefab') {
        // A prefab holds nodes, never prefabs, so placing one here appends its children.
        const host = roots[0]
        if (host === undefined) return -1
        let last: Node | undefined
        for (const kid of root.children ?? []) {
          const copy = structuredClone(kid)
          copy.id = freshId()
          copy.transform = { ...copy.transform, position: vec3(position.x + copy.transform.position.x, position.y + copy.transform.position.y, position.z + copy.transform.position.z) }
          ;(host.children ??= []).push(copy)
          last = copy
        }
        return last === undefined ? -1 : indexOf(last)
      }
      const key = intern({ ...structuredClone(root), name })
      const placed: Node = { id: freshId(), transform: { position }, components: [], prefab: key }
      roots.push(placed)
      return indexOf(placed)
    },
    placeEmpty: (position, parent) => {
      const fresh: Node = { id: freshId(), name: 'empty', transform: { position }, components: [] }
      if (parent !== null) {
        const host = own(parent)?.authored
        // An inherited node's children belong to the prefab, so there is nowhere here to put one.
        if (host === undefined) return -1
        ;(host.children ??= []).push(fresh)
      } else if (mode === 'prefab') {
        const host = roots[0]
        if (host === undefined) return -1
        ;(host.children ??= []).push(fresh)
      } else roots.push(fresh)
      return indexOf(fresh)
    },
    placeModel: (assetId, position) => {
      const fresh = solidNode({ kind: 'box', halfExtents: vec3(0.5, 0.5, 0.5) }, { position }, undefined, assetId)
      if (mode === 'prefab') {
        const host = roots[0]
        if (host === undefined) return -1
        ;(host.children ??= []).push(fresh)
      } else roots.push(fresh)
      return indexOf(fresh)
    },
    prefabForPalette: (name) => {
      if (mode === 'prefab') {
        const make = PRIMITIVES[name]
        return make === undefined ? undefined : { id: name, name, transform: { position: vec3(0, 0, 0) }, components: [], children: [solidNode(make(), { position: vec3(0, 0, 0) }, name)] }
      }
      return level.prefabs?.[name] ?? library[name]
    },
    // Removing takes the subtree with it: children are placed relative to this node and have nowhere to be
    // without it. An inherited node cannot go — it would have to go from every placement of the prefab.
    remove: (i) => {
      const n = own(i)
      if (n?.siblings === undefined) return
      n.siblings.splice(n.index, 1)
      const parent = node(n.parent)?.authored
      tidyChildren(parent)
    },
    // A clone of a placement references the same table entry. Cloning the *definition* would quietly break
    // the very link the reference exists to provide. Children come along; ids are re-minted.
    duplicate: (i) => {
      const n = own(i)
      if (n?.siblings === undefined) return i
      const copy = structuredClone(n.authored)
      reidSubtree(copy)
      n.siblings.splice(n.index + 1, 0, copy)
      return indexOf(copy)
    },
    label: labelAt,
    nameOf: (i) => node(i)?.view.name ?? '',
    setName: (i, name) => {
      const n = node(i)
      if (n === undefined) return
      if (n.owner !== undefined) {
        // Empty means "no name here", which still differs from inheriting the prefab's.
        overrideFor(n, true)!.name = name
        return
      }
      if (name === '') delete n.authored.name
      else n.authored.name = name
    },
    // Order is not cosmetic (checkpoint progression, the replicated movement-base index — ADR 0021), and an
    // inherited node's order belongs to the prefab.
    move: (from, to) => {
      const n = own(from)
      if (n?.siblings === undefined) return from
      moveWithin(n.siblings, n.index, to)
      return indexOf(n.authored)
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
      const host = parent === null ? roots : (own(parent)!.authored.children ??= [])
      const sameList = host === n.siblings
      const previousParent = node(n.parent)?.authored
      n.siblings.splice(n.index, 1)
      const insertAt = Math.max(0, Math.min(host.length, sameList && atIndex > n.index ? atIndex - 1 : atIndex))
      host.splice(insertAt, 0, n.authored)
      if (!sameList) tidyChildren(previousParent)
      return indexOf(n.authored)
    },
    assetIds: () => {
      const ids = new Set<string>()
      const add = (components: readonly ComponentData[]): void => {
        for (const c of components) {
          if (c.type === MESH) {
            const model = stringParam(c, 'model', '')
            if (model !== '') ids.add(model)
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
      const over = overrideFor(n, false)
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
      if (n.owner === undefined) {
        const c = n.authored.components.find((x) => x.id === componentId)
        if (c === undefined) return
        if (on) delete c.enabled
        else c.enabled = false
        return
      }
      const over = overrideFor(n, true)!
      const added = over.added?.find((x) => x.id === componentId)
      if (added !== undefined) {
        if (on) delete added.enabled
        else added.enabled = false
        return
      }
      ;(over.enabled ??= {})[componentId] = on
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
      const over = n === undefined ? undefined : overrideFor(n, false)
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
      if (n === undefined) return
      const over = overrideFor(n, false)
      if (over === undefined) return
      if (field === undefined) {
        for (const k of Object.keys(over)) delete (over as Record<string, unknown>)[k]
      } else if (field === 'transform' || field === 'name') {
        delete over[field]
      } else {
        delete over.params?.[field]
        delete over.enabled?.[field]
        const at = over.added?.findIndex((c) => c.id === field) ?? -1
        if (at >= 0) over.added!.splice(at, 1)
        const r = over.removed?.indexOf(field) ?? -1
        if (r >= 0) over.removed!.splice(r, 1)
      }
      tidyOverride(n)
    },
    /**
     * Promote this placement's overrides into the shared prefab, then drop them.
     *
     * Every other placement of that prefab changes, which is the point — and why this is a deliberate action
     * rather than something an edit does on its own.
     */
    applyToPrefab: (i) => {
      const n = node(i)
      if (n === undefined) return
      const over = overrideFor(n, false)
      if (over === undefined) return
      const target = n.authored
      if (over.transform !== undefined) target.transform = over.transform
      if (over.name !== undefined) {
        if (over.name === '') delete target.name
        else target.name = over.name
      }
      for (const [id, patch] of Object.entries(over.params ?? {})) {
        const c = target.components.find((x) => x.id === id)
        if (c !== undefined) c.params = { ...c.params, ...patch }
      }
      for (const [id, on] of Object.entries(over.enabled ?? {})) {
        const c = target.components.find((x) => x.id === id)
        if (c === undefined) continue
        if (on) delete c.enabled
        else c.enabled = false
      }
      for (const id of over.removed ?? []) {
        const at = target.components.findIndex((x) => x.id === id)
        if (at >= 0) target.components.splice(at, 1)
      }
      for (const c of over.added ?? []) target.components.push(structuredClone(c))
      for (const k of Object.keys(over)) delete (over as Record<string, unknown>)[k]
      tidyOverride(n)
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
      return poseAt(behaviorOf(trackComponent(n)), n.view.transform, timeMs)
    },

    /** Takes the *resolved* definitions rather than the keys alone, including nested children's. */
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
      const remap = (x: Node): void => {
        if (x.prefab !== undefined) {
          const carried = item.prefabs[x.prefab]
          if (carried !== undefined) x.prefab = intern(structuredClone(carried))
          else if (!(x.prefab in table())) delete x.prefab
        }
        for (const kid of x.children ?? []) remap(kid)
      }
      remap(fresh)
      reidSubtree(fresh)
      // A prefab holds no prefabs, so a placement pasted into one would be a reference this schema forbids.
      if (mode === 'prefab' && fresh.prefab !== undefined) return -1

      if (parent === null) {
        if (mode === 'prefab') {
          const host = roots[0]
          if (host === undefined) return -1
          ;(host.children ??= []).push(fresh)
        } else roots.push(fresh)
      } else {
        const host = own(parent)?.authored
        if (host === undefined) return -1
        ;(host.children ??= []).push(fresh)
      }
      return indexOf(fresh)
    },
    refOf: (i) => node(i)?.authored.prefab ?? null,
    extract: (i) => {
      const n = own(i)
      if (n === undefined || n.authored.prefab !== undefined || mode === 'prefab') return null
      // The definition is the node's contents; the placement keeps its transform and points at them.
      const definition: Node = {
        id: 'root',
        ...(n.authored.name !== undefined ? { name: n.authored.name } : {}),
        transform: { position: vec3(0, 0, 0) },
        components: structuredClone(n.authored.components),
        ...(n.authored.children !== undefined ? { children: structuredClone(n.authored.children) } : {}),
      }
      const key = intern(definition)
      n.authored.components = []
      delete n.authored.children
      n.authored.prefab = key
      return key
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
      level.config = { ...level.config, environment: env }
    },
    toJSON: opts.json,
    setId: (id) => {
      level.id = id
      if (mode === 'prefab' && roots[0] !== undefined) roots[0].name = id
    },
  }
}

export const levelDoc = (level: Level, library: Record<string, Node>, registry: Registry = DEFAULT_REGISTRY): Doc =>
  docOver(level, { mode: 'level', library, registry, json: () => level })

/**
 * A prefab, edited as a document of one root node.
 *
 * Wrapped in a throwaway level so there is one implementation instead of two: a prefab is a node tree, and a
 * level is a node tree with a table. `physical-fall` and a distant `fallY` keep the wrapper from killing the
 * test character while previewing a prefab in mid-air.
 */
export const prefabDoc = (root: Node, registry: Registry = DEFAULT_REGISTRY): Doc =>
  docOver(
    { id: root.name ?? root.id, config: { fallBehavior: 'physical-fall', fallY: -999 }, nodes: [root] },
    { mode: 'prefab', library: {}, registry, json: () => root },
  )

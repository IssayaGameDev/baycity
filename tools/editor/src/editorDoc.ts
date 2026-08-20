import {
  effectivePieces,
  freeTableId,
  overriddenFields,
  instancesOf,
  resolvePrefab,
  visualMaterial,
  poseAt,
  visualModel,
  walkInstances,
  type Behavior,
  type ColliderDesc,
  type InstanceVisit,
  type Level,
  type Piece,
  type PieceOverride,
  type Pose,
  type Prefab,
  type PrefabInstance,
  type Transform,
  type TriggerKind,
} from '@mp/content'
import { vec3, type Vec3 } from '@mp/core'

/**
 * What a new bumper is worth. A jump leaves the ground at about 18.2 m/s for its 3 m, so this throws roughly
 * twice as high — a trampoline rather than a soft catch. See `Trigger` in `@mp/content`.
 */
export const DEFAULT_BUMPER_POWER = 26

/**
 * A fresh piece id. Eight hex characters from `crypto`, the same shape the asset importer mints: short enough
 * to read in a diff, long enough that two never collide inside one prefab.
 */
const freshPieceId = (): string => {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

import { sortedKeys, type TrackEdit } from './trackEdit'

/**
 * Editor document abstraction. A **level** is placed prefab instances; a **prefab** is a flat list
 * of pieces (collider + visual + trigger + optional behavior). Both are edited with the same
 * machinery (select / gizmo / place / duplicate / delete / inspector), so this hides the difference
 * behind one interface over "items" (instances or pieces).
 *
 * Placing puts the prefab in `Level.prefabs` and **references it by id**. That reference is what
 * makes a prefab a prefab: `prefabAt(id)` hands back the one shared definition, editing it moves
 * every instance, and `refCount` says how many are watching. Placing the same thing twice shares one
 * entry instead of duplicating it. Inline definitions still load — older files are full of them —
 * and `extract` converts one into a shared entry in place.
 *
 * **Items are addressed by depth-first index.** A level's instances nest to any depth, and the index is a
 * position in that flattened walk — the same order the loader numbers movement bases in. Indices shift
 * whenever the tree changes, which is safe because every structural edit already rebuilds the meshes, the
 * physics world and the panels; nothing holds an index across a mutation except `selected`, and the
 * mutating call returns where the item landed so the caller can re-resolve it. Prefabs stay flat, so
 * there an index is just the piece's position.
 */
export type Mode = 'level' | 'prefab'
export type TriggerChoice = 'none' | TriggerKind

/** One mesh to draw under an item's group (transform is local to that group). */
export interface MeshSpec {
  collider: ColliderDesc
  transform: Transform
  /**
   * The piece's authored name. Carried so a level-mode piece row can read "left rail" instead of "box";
   * it replaces a `· style` suffix, which was the only thing distinguishing three boxes before.
   */
  name: string | undefined
  /** Model asset id — drawn instead of the collider's shape. */
  model: string | undefined
  /** Material asset id — absent means unsurfaced, which the viewport greyboxes. */
  material: string | undefined
}

/**
 * Per-item editable properties beyond the transform. `material` means the piece's own material in prefab
 * mode and the instance's **override** in level mode — the same question ("what is this made of")
 * answered at the level each mode owns. `trigger` belongs to a piece's collider, so it is editable
 * only in prefab mode; `pieceLevel` says which of the two we are.
 */
export interface ItemProps {
  pieceLevel: boolean
  trigger: TriggerChoice
  /**
   * A bumper's launch speed in m/s. Carried alongside `trigger` rather than inside it because the Inspector
   * edits a flat bag of values; it is only written back when the chosen trigger is a bumper (ADR 0032).
   */
  bumperPower: number
  /** Material asset id, or `''` for none: the piece's own, or the instance-wide override. */
  material: string
}

/**
 * What a copy holds (ADR 0030): a detached subtree, plus **the prefab definitions it references**.
 *
 * Carrying the definitions is what makes paste work at all. An instance can name a prefab by id, and that id
 * resolves against the *level's* table — so an instance alone would paste into another level as a dangling
 * reference, and even in the same level it would break if the table entry were deleted in between. With the
 * definitions along for the ride, a paste is self-contained: any id the clipboard names is interned into the
 * destination if it is not already there.
 *
 * The two kinds do not interchange, and cannot: a level holds instances and a prefab holds pieces. Pasting
 * across that boundary is refused rather than guessed at.
 */
export type ClipItem =
  | { readonly kind: 'instance'; readonly instance: PrefabInstance; readonly prefabs: Record<string, Prefab> }
  | { readonly kind: 'piece'; readonly piece: Piece }

export interface Doc {
  readonly mode: Mode
  count: () => number
  /**
   * What node `i` is (ADR 0033). A level holds both: placements, and the pieces of the prefabs they reference.
   * In prefab mode every node is a piece.
   *
   * Callers need it because the two differ in what they can do, not in what they are: a piece has no children,
   * cannot be re-parented, re-ordered, deleted or copied through a placement, and edits to it land on the
   * shared prefab.
   */
  kindOf: (i: number) => 'instance' | 'piece'
  transformOf: (i: number) => Transform
  meshSpecs: (i: number) => MeshSpec[]
  palette: () => string[]
  /** Place a palette entry. `-1` when the name is not in the library or this level's table. */
  place: (name: string, position: Vec3) => number
  /**
   * Place a model asset: a one-piece prefab whose visual is the mesh and whose collider is an authored box.
   * Visual is not collision (ADR 0014), so a detailed prop collides as a shape somebody can see and resize
   * rather than as its own triangles.
   */
  placeModel: (assetId: string, position: Vec3) => number
  /**
   * Place a prefab that came from a file. The prefab is **interned as a copy** into `Level.prefabs`, so the
   * level stays self-contained: moving or deleting the prefab *file* afterwards can never leave the level
   * without geometry.
   *
   * `name` is the file's name, and it becomes the table id — **not** the `id` stored inside the file, which is
   * whatever the prefab happened to be called when it was saved and is routinely stale (`AlternatingDanger`
   * shipped carrying `"id": "FastElevator"`). Same rule `place` already followed for the palette.
   */
  placePrefab: (prefab: Prefab, name: string, position: Vec3) => number
  /**
   * The prefab a palette entry would place, without placing it — what a Project tile previews. Resolved
   * through the same sources as `place`, so a tile cannot show something other than what it will put down.
   */
  prefabForPalette: (name: string) => Prefab | undefined
  remove: (i: number) => void
  duplicate: (i: number) => number
  /** Display name: the typed name if there is one, else what the item is (prefab id / collider kind). */
  label: (i: number) => string
  /** The *typed* name, empty when none — so the field can show the fallback as a placeholder. */
  nameOf: (i: number) => string
  /** Set or, given `''`, remove the name. Removing reverts the display to the fallback. */
  setName: (i: number, name: string) => void
  /**
   * Reorder within the item's own sibling list: put it *before* what was sibling index `to`. Order is not
   * cosmetic — checkpoint progression follows it, and so does the movement-base index a rider replicates
   * (ADR 0021). Returns the item's new depth-first index.
   */
  move: (from: number, to: number) => number
  /** 0 for a top-level instance (always 0 in prefab mode, which is flat). */
  depthOf: (i: number) => number
  /** Depth-first index of the item's parent, or `null` at the top level. */
  parentOf: (i: number) => number | null
  /** Position within its own sibling list. */
  siblingIndexOf: (i: number) => number
  /**
   * Sibling indices from the root, joined — `"0/2/1"`. A key for per-row UI state (which rows are
   * collapsed) that survives edits elsewhere in the tree, unlike a depth-first index, which every
   * insertion above it shifts.
   */
  pathOf: (i: number) => string
  childCount: (i: number) => number
  /**
   * Whether `from` may become a child of `parent` (`null` = top level). False for itself and for anything
   * inside its own subtree — a node cannot be its own ancestor, and the transform chain would not
   * terminate.
   */
  canReparent: (from: number, parent: number | null) => boolean
  /**
   * Make `from` a child of `parent` (`null` = top level) at sibling position `at`. The item keeps its
   * *local* transform, so it lands at that offset from its new parent — dragging in the hierarchy changes
   * what a placement is relative to, which is the point of parenting it. Returns its new depth-first
   * index, or `from` unchanged if the move is illegal.
   */
  reparent: (from: number, parent: number | null, at: number) => number
  /** Assets every item in the document references — what to preload before drawing it. */
  assetIds: () => string[]
  props: (i: number) => ItemProps
  setProps: (i: number, p: ItemProps) => void
  /**
   * Replace a node's local transform. Absent `rotation`/`scale` are **removed**, which is how a clean file
   * stays clean.
   *
   * A setter rather than mutating what `transformOf` hands back, because for an overridden piece the two are
   * different objects: reading gives the prefab's value, writing creates the placement's own (ADR 0033).
   */
  setTransform: (i: number, t: Transform) => void
  /**
   * Which fields this placement overrides on the piece at `i`, in a stable order. Empty for an instance, for a
   * piece in prefab mode, and for a piece nobody has touched.
   */
  overridesOf: (i: number) => string[]
  /** Drop one override field, or all of them, so the piece goes back to what the prefab says. */
  revert: (i: number, field?: string) => void
  /** Push this placement's overrides into the shared prefab, so every instance gets them and this one is clean. */
  applyToPrefab: (i: number) => void
  /** The item's keyframe track, or `null` when it is static. */
  trackOf: (i: number) => TrackEdit | null
  /** Replace the track. `null` removes the behavior, which is what "does not move" is. */
  setTrack: (i: number, track: TrackEdit | null) => void
  /**
   * The item's local pose at a track time — what a scrub draws, and what the gizmo writes into a key. The
   * authored transform for a static item, so a caller never has to ask which kind it is holding.
   */
  poseOf: (i: number, timeMs: number) => Pose
  /**
   * A detached copy of the item and everything under it, or `null`. Nothing is mutated — the returned value
   * shares no object with the document, so it stays valid after the original is deleted.
   */
  copy: (i: number) => ClipItem | null
  /**
   * Paste a clipboard item. `parent` is `null` for the top level, or an index to paste *into*. Returns the new
   * depth-first index, or `-1` when the item is the wrong kind for this document.
   */
  paste: (item: ClipItem, parent: number | null) => number
  /** The prefab id this item references, or `null` for an inline definition / a piece. */
  refOf: (i: number) => string | null
  /** Turn an inline instance into a shared table entry and reference it. The new id, or `null`. */
  extract: (i: number) => string | null
  /** The shared definition behind an id — the object to edit so every instance follows. */
  prefabAt: (id: string) => Prefab | undefined
  /** How many instances reference `id`: what "edit this and 3 things move" is counting. */
  refCount: (id: string) => number
  /** A Level to instantiate for marker/trigger gizmos + physics (prefab → wrapped at origin). */
  asLevel: () => Level
  toJSON: () => Level | Prefab
  /** Save writes under a file name; the id follows it, or the two silently diverge. */
  setId: (id: string) => void
}

// Primitive pieces for prefab mode. Only shapes the physics loader supports (no cylinder).
const PRIMITIVES: Record<string, () => Piece> = {
  box: () => ({ collider: { kind: 'box', halfExtents: vec3(1, 0.5, 1) }, transform: { position: vec3(0, 0, 0) } }),
  platform: () => ({ collider: { kind: 'box', halfExtents: vec3(1.5, 0.15, 1.5) }, transform: { position: vec3(0, 0, 0) } }),
  wall: () => ({ collider: { kind: 'box', halfExtents: vec3(1.5, 1, 0.15) }, transform: { position: vec3(0, 0, 0) } }),
  ball: () => ({ collider: { kind: 'ball', radius: 0.5 }, transform: { position: vec3(0, 0, 0) } }),
  capsule: () => ({ collider: { kind: 'capsule', halfHeight: 0.5, radius: 0.4 }, transform: { position: vec3(0, 0, 0) } }),
}

/**
 * The behavior as the timeline edits it, or `null` when the item does not move.
 *
 * `static` and "no behavior key at all" collapse to one `null`: they mean the same thing to the loader, and
 * offering two ways to say it in the UI would be a distinction without a difference.
 */
const readTrack = (b: Behavior | undefined): TrackEdit | null =>
  b === undefined || b.kind !== 'track' ? null : { keys: b.keys, loop: b.loop ?? 'loop', phaseMs: b.phaseMs ?? 0 }

/**
 * A track as JSON, with defaults left out. `loop: 'loop'` and `phaseMs: 0` are what an absent field already
 * means, so writing them would put noise in every authored file and carry no information.
 */
const writeTrack = (t: TrackEdit): Behavior => ({
  kind: 'track',
  keys: sortedKeys(t.keys),
  ...(t.loop !== 'loop' ? { loop: t.loop } : {}),
  ...(t.phaseMs !== 0 ? { phaseMs: t.phaseMs } : {}),
})

/**
 * Splice `arr`'s item at `from` so it lands *before* the original index `to`. `to` is expressed against
 * the array as it was, which is what a drop between two rows naturally gives you — hence the shift when
 * moving downward, where removing the item first pulls every later index back by one.
 */
/**
 * Write the editable properties of a piece. Shared, because a piece is reachable from both documents since
 * ADR 0033: directly in prefab mode, and through the placement that references it in level mode.
 */
const writePieceProps = (pc: Piece, p: ItemProps): void => {
  // The visual is rebuilt from the fields rather than patched, so clearing the last one removes the key
  // instead of leaving `{ kind: 'primitive' }` behind.
  const model = visualModel(pc.visual)
  const material = p.material === '' ? undefined : p.material
  if (model !== undefined) pc.visual = { kind: 'model', asset: model, ...(material !== undefined ? { material } : {}) }
  else if (material !== undefined) pc.visual = { kind: 'primitive', material }
  else delete pc.visual
  if (p.trigger === 'none') delete pc.trigger
  else if (p.trigger === 'bumper') pc.trigger = { kind: 'bumper', power: p.bumperPower }
  else pc.trigger = { kind: p.trigger }
}

const moveWithin = <T>(arr: T[], from: number, to: number): number => {
  if (from < 0 || from >= arr.length || from === to) return from
  const [item] = arr.splice(from, 1)
  const at = Math.max(0, Math.min(arr.length, to > from ? to - 1 : to))
  arr.splice(at, 0, item as T)
  return at
}

/**
 * One addressable thing in a level: a placed **instance**, or one **piece** of the prefab it references
 * (ADR 0033).
 *
 * Pieces used to be invisible to this layer — the doc addressed instances, an instance reported all of its
 * prefab's pieces as its own meshes, and the Hierarchy synthesized piece rows it could not select. But the
 * piece is the object: it carries the collider, the visual, the material and the trigger. The instance carries
 * only a transform. So both are nodes, and everything that reads the document reads one list.
 *
 * A piece belongs to the **shared prefab**, so editing one through a placement edits every placement of it.
 * That is the truthful reading of the current schema, and per-instance overrides are the next stage.
 */
interface LevelNode {
  kind: 'instance' | 'piece'
  /** The placement this node is, or the one a piece hangs under. */
  visit: InstanceVisit
  /** Node index of the parent — the owning instance for a piece; `-1` at the top level. */
  parent: number
  depth: number
  /** Sibling path (`"0/2"`, or `"0/2#1"` for a piece): UI state that survives edits elsewhere. */
  path: string
  /**
   * The piece **as this placement sees it** (overrides applied) and its index in the prefab. `-1` on an
   * instance node.
   *
   * Reading is always the effective piece; writing goes through the setters, which decide between the shared
   * prefab and this placement's override. Keeping the two apart is the whole of ADR 0033.
   */
  piece: Piece | undefined
  /** The prefab's own object, for the writes that are meant to change every instance. */
  shared: Piece | undefined
  pieceIndex: number
}

export const levelDoc = (level: Level, library: Record<string, Prefab>): Doc => {
  /**
   * Depth-first flatten, recomputed per call rather than cached. A cache has to be invalidated by every
   * mutation, including one made *through* the level object rather than through this doc — and the day it
   * misses, an index silently addresses the wrong node. Tens of instances, so the walk costs nothing worth
   * that risk.
   *
   * Order per instance: the instance, then its pieces, then its child instances. Pieces first because they are
   * what the object *is*; a child is something placed on it.
   */
  const nodes = (): LevelNode[] => {
    const out: LevelNode[] = []
    const walk = (siblings: PrefabInstance[], parentInst: PrefabInstance | null, parentNode: number, depth: number, base: string): void => {
      siblings.forEach((inst, index) => {
        const self = out.length
        const path = base === '' ? String(index) : `${base}/${index}`
        const visit: InstanceVisit = { inst, parent: parentInst, siblings, index, depth }
        out.push({ kind: 'instance', visit, parent: parentNode, depth, path, piece: undefined, shared: undefined, pieceIndex: -1 })
        const shared = resolvePrefab(level, inst).pieces
        effectivePieces(level, inst).forEach((piece, p) => {
          out.push({ kind: 'piece', visit, parent: self, depth: depth + 1, path: `${path}#${p}`, piece, shared: shared[p], pieceIndex: p })
        })
        if (inst.children !== undefined) walk(inst.children, inst, self, depth + 1, path)
      })
    }
    walk(level.instances, null, -1, 0, '')
    return out
  }
  const node = (i: number): LevelNode | undefined => nodes()[i]
  /** The instance node `i` is, or the one a piece belongs to. `undefined` for an index that is not there. */
  const at = (i: number): InstanceVisit | undefined => node(i)?.visit
  /** Instance nodes only, for the structural operations that address placements. */
  const instanceNode = (i: number): LevelNode | undefined => {
    const n = node(i)
    return n?.kind === 'instance' ? n : undefined
  }
  const indexOfInstance = (inst: PrefabInstance): number => nodes().findIndex((n) => n.kind === 'instance' && n.visit.inst === inst)

  // Created on first use, so a level with nothing placed yet stays clean JSON.
  const table = (): Record<string, Prefab> => (level.prefabs ??= {})
  const refAt = (i: number): string | null => {
    const p = at(i)?.inst.prefab
    return typeof p === 'string' ? p : null
  }
  /** Put `prefab` in the table under a free id (reusing an identical entry) and return that id. */
  const intern = (prefab: Prefab): string => {
    const t = table()
    const id = freeTableId(t, prefab)
    t[id] ??= prefab
    return id
  }
  /**
   * One past the last node of `i`'s subtree. In a depth-first walk a subtree is the contiguous run of
   * deeper nodes right after its root, which is what makes the cycle check below a scan rather than a
   * recursion.
   */
  const subtreeEnd = (i: number): number => {
    const all = nodes()
    const depth = all[i]?.depth ?? 0
    let j = i + 1
    while (j < all.length && (all[j]?.depth ?? 0) > depth) j++
    return j
  }
  /**
   * Only instances can be re-parented, and only under instances. A piece's place is decided by the prefab, not
   * by the placement — dragging one somewhere else would have to mean removing it from every other instance of
   * that prefab, which is not what the gesture looks like it does.
   */
  const canReparent = (from: number, parent: number | null): boolean => {
    if (instanceNode(from) === undefined) return false
    if (parent === null) return true
    if (parent === from || instanceNode(parent) === undefined) return false
    // Its own subtree is exactly the run of deeper nodes after it.
    return !(parent > from && parent < subtreeEnd(from))
  }
  /**
   * This placement's override record for a piece, created if asked for.
   *
   * The piece gains an **id** here if it had none: an override has to name what it applies to, and naming it by
   * array position would re-target the moment somebody inserts a piece above it. Minting on demand is why no
   * content had to migrate — a piece becomes referenceable exactly when something first refers to it.
   */
  const overrideFor = (n: LevelNode, create: boolean): PieceOverride | undefined => {
    const shared = n.shared
    if (shared === undefined) return undefined
    if (shared.id === undefined) {
      if (!create) return undefined
      shared.id = freshPieceId()
    }
    const id = shared.id
    const inst = n.visit.inst
    if (!create) return inst.overrides?.[id]
    const table = (inst.overrides ??= {})
    return (table[id] ??= {})
  }

  /** Remove an override that has nothing left in it, and the map with it, so the JSON does not accumulate husks. */
  const tidyOverride = (n: LevelNode): void => {
    const inst = n.visit.inst
    const id = n.shared?.id
    if (id === undefined || inst.overrides === undefined) return
    const over = inst.overrides[id]
    if (over !== undefined && Object.keys(over).length === 0) delete inst.overrides[id]
    if (Object.keys(inst.overrides).length === 0) delete inst.overrides
  }

  /** Drop a `children: []` left behind by a move, so the JSON does not accumulate empty arrays. */
  const tidy = (parent: PrefabInstance | null): void => {
    if (parent !== null && parent.children !== undefined && parent.children.length === 0) delete parent.children
  }

  return {
    mode: 'level',
    count: () => nodes().length,
    kindOf: (i) => node(i)?.kind ?? 'instance',
    transformOf: (i) => {
      const n = node(i)!
      return n.kind === 'piece' ? n.piece!.transform : n.visit.inst.transform
    },
    /**
     * An instance draws **nothing of its own** — its pieces are nodes now and draw themselves. That is what
     * makes the scene graph match the Hierarchy, and it matches the loader's frame tree, where an instance is a
     * transform and a piece is the thing with a collider.
     */
    meshSpecs: (i) => {
      const n = node(i)
      if (n === undefined || n.kind !== 'piece') return []
      const pc = n.piece!
      return [
        {
          collider: pc.collider,
          transform: { position: vec3(0, 0, 0) }, // the node's own transform positions it
          name: pc.name,
          model: visualModel(pc.visual),
          material: n.visit.inst.material ?? visualMaterial(pc.visual),
        },
      ]
    },
    /**
     * Only what *this level* defines. Prefab **files** are placed from the Project explorer, by asset id, and
     * listing them here as well is what made one prefab appear twice — first beside the code kit, and then
     * beside the folder tree after the kit was deleted. A level's own table entries have nowhere else to
     * appear, so this is what is left.
     */
    palette: () => Object.keys(level.prefabs ?? {}),
    place: (name, position) => {
      let id: string
      if (level.prefabs?.[name] !== undefined) id = name // already this level's own entry
      else {
        const source = library[name]
        // A palette that offers a name the library no longer has is a bug, but not a crash: the file may
        // have been deleted or renamed between the panel drawing and the click landing.
        if (source === undefined) return -1
        const copy = structuredClone(source)
        copy.id = name // a prefab file is known by its file name; the stored id may be stale
        id = intern(copy)
      }
      // Placing lands at the top level, as in Unity; parent it afterwards by dragging.
      const inst: PrefabInstance = { prefab: id, transform: { position } }
      level.instances.push(inst)
      return indexOfInstance(inst)
    },
    placePrefab: (prefab, name, position) => {
      const copy = structuredClone(prefab)
      copy.id = name // a prefab file is known by its file name; the stored id may be stale
      const id = intern(copy)
      const inst: PrefabInstance = { prefab: id, transform: { position } }
      level.instances.push(inst)
      return indexOfInstance(inst)
    },
    placeModel: (assetId, position) => {
      const inst: PrefabInstance = {
        prefab: {
          id: 'model',
          pieces: [
            {
              collider: { kind: 'box', halfExtents: vec3(0.5, 0.5, 0.5) },
              transform: { position: vec3(0, 0, 0) },
              visual: { kind: 'model', asset: assetId },
            },
          ],
        },
        transform: { position },
      }
      level.instances.push(inst)
      return indexOfInstance(inst)
    },
    prefabForPalette: (name) => level.prefabs?.[name] ?? library[name],
    // Removing takes the subtree with it: children are placed relative to this item and have nowhere
    // to be without it.
    remove: (i) => {
      // A piece cannot be removed through a placement: it would have to go from every instance of the prefab.
      const n = instanceNode(i)
      if (n === undefined) return
      n.visit.siblings.splice(n.visit.index, 1)
      tidy(n.visit.parent)
    },
    // A clone of a referencing instance references the same entry. Cloning the *definition* would
    // quietly break the very link the reference exists to provide. Children come along.
    duplicate: (i) => {
      const n = instanceNode(i)
      if (n === undefined) return i
      const copy = structuredClone(n.visit.inst)
      n.visit.siblings.splice(n.visit.index + 1, 0, copy)
      return indexOfInstance(copy)
    },
    label: (i) => {
      const n = node(i)
      if (n === undefined) return ''
      if (n.kind === 'piece') return n.piece!.name ?? n.piece!.collider.kind
      const inst = n.visit.inst
      return inst.name ?? refAt(i) ?? (inst.prefab as Prefab).id
    },
    nameOf: (i) => {
      const n = node(i)
      return (n?.kind === 'piece' ? n.piece!.name : n?.visit.inst.name) ?? ''
    },
    setName: (i, name) => {
      const n = node(i)
      if (n === undefined) return
      if (n.kind === 'piece') {
        const over = overrideFor(n, true)!
        // Empty means "no name here", which still differs from inheriting the prefab's.
        over.name = name
        return
      }
      const inst = n.visit.inst
      if (name === '') delete inst.name
      else inst.name = name
    },
    // Order is not cosmetic (checkpoint progression, the replicated movement-base index — ADR 0021), and a
    // piece's order belongs to the prefab, so only instances reorder here.
    move: (from, to) => {
      const n = instanceNode(from)
      if (n === undefined) return from
      moveWithin(n.visit.siblings, n.visit.index, to)
      return indexOfInstance(n.visit.inst)
    },
    depthOf: (i) => node(i)?.depth ?? 0,
    parentOf: (i) => {
      const parent = node(i)?.parent
      return parent === undefined || parent < 0 ? null : parent
    },
    siblingIndexOf: (i) => {
      const n = node(i)
      return n === undefined ? 0 : n.kind === 'piece' ? n.pieceIndex : n.visit.index
    },
    pathOf: (i) => node(i)?.path ?? '',
    // Pieces count as contents too: they are what one twist in the Hierarchy opens, alongside the children.
    childCount: (i) => {
      const n = node(i)
      if (n === undefined || n.kind === 'piece') return 0
      return (n.visit.inst.children?.length ?? 0) + resolvePrefab(level, n.visit.inst).pieces.length
    },
    canReparent,
    reparent: (from, parent, atIndex) => {
      const v = instanceNode(from)?.visit
      if (v === undefined || !canReparent(from, parent)) return from
      const target = parent === null ? level.instances : (instanceNode(parent)!.visit.inst.children ??= [])
      const sameList = target === v.siblings
      v.siblings.splice(v.index, 1)
      // Within one list this is a plain reorder, so the same downward shift applies as in `moveWithin`.
      const insertAt = Math.max(0, Math.min(target.length, sameList && atIndex > v.index ? atIndex - 1 : atIndex))
      target.splice(insertAt, 0, v.inst)
      if (!sameList) tidy(v.parent)
      return indexOfInstance(v.inst)
    },
    assetIds: () => {
      const ids = new Set<string>()
      for (const v of walkInstances(level)) {
        // The instance's own override counts: it is an asset reference now, where `style` was a name the
        // renderer resolved by itself, so leaving it out of the preload silently greyboxes the override.
        if (v.inst.material !== undefined) ids.add(v.inst.material)
        for (const pc of resolvePrefab(level, v.inst).pieces) {
          const model = visualModel(pc.visual)
          const material = visualMaterial(pc.visual)
          if (model !== undefined) ids.add(model)
          if (material !== undefined) ids.add(material)
        }
      }
      return [...ids]
    },
    /**
     * A piece reports the piece's own properties, and writing them writes the **shared prefab** — so every
     * placement of it follows. An instance reports its one blunt override, the material applied to all of its
     * pieces at once. Per-piece, per-instance overrides are the next stage.
     */
    props: (i) => {
      const n = node(i)
      if (n?.kind === 'piece') {
        const pc = n.piece!
        return {
          pieceLevel: true,
          trigger: pc.trigger?.kind ?? 'none',
          bumperPower: pc.trigger?.kind === 'bumper' ? pc.trigger.power : DEFAULT_BUMPER_POWER,
          material: visualMaterial(pc.visual) ?? '',
        }
      }
      return { pieceLevel: false, trigger: 'none', bumperPower: DEFAULT_BUMPER_POWER, material: n?.visit.inst.material ?? '' }
    },
    setProps: (i, p) => {
      const n = node(i)
      if (n === undefined) return
      if (n.kind === 'piece') {
        // A placement's edit is an override, not a change to the shared definition (ADR 0033). Editing the
        // prefab itself is what "Open" and prefab mode are for.
        const over = overrideFor(n, true)!
        over.material = p.material
        if (p.trigger === 'none') over.trigger = { kind: 'none' }
        else if (p.trigger === 'bumper') over.trigger = { kind: 'bumper', power: p.bumperPower }
        else over.trigger = { kind: p.trigger }
        return
      }
      const inst = n.visit.inst
      if (p.material !== '') inst.material = p.material
      else delete inst.material
    },
    trackOf: (i) => {
      const n = node(i)
      return readTrack(n?.kind === 'piece' ? n.piece!.behavior : n?.visit.inst.behavior)
    },
    setTransform: (i, t) => {
      const n = node(i)
      if (n === undefined) return
      if (n.kind === 'piece') {
        overrideFor(n, true)!.transform = t
        return
      }
      n.visit.inst.transform = t
    },
    overridesOf: (i) => {
      const n = node(i)
      return n === undefined || n.kind !== 'piece' ? [] : overriddenFields(overrideFor(n, false))
    },
    revert: (i, field) => {
      const n = node(i)
      if (n === undefined || n.kind !== 'piece') return
      const over = overrideFor(n, false)
      if (over === undefined) return
      if (field === undefined) for (const k of Object.keys(over)) delete (over as Record<string, unknown>)[k]
      else delete (over as Record<string, unknown>)[field]
      tidyOverride(n)
    },
    /**
     * Promote this placement's overrides into the shared prefab, then drop them.
     *
     * Every other instance of that prefab changes, which is the point — and it is why this is a deliberate
     * action rather than something an edit does on its own.
     */
    applyToPrefab: (i) => {
      const n = node(i)
      if (n === undefined || n.kind !== 'piece') return
      const over = overrideFor(n, false)
      const shared = n.shared
      if (over === undefined || shared === undefined) return
      if (over.transform !== undefined) shared.transform = over.transform
      if (over.behavior !== undefined) shared.behavior = over.behavior
      if (over.name !== undefined) {
        if (over.name === '') delete shared.name
        else shared.name = over.name
      }
      if (over.trigger !== undefined) {
        if (over.trigger.kind === 'none') delete shared.trigger
        else shared.trigger = over.trigger
      }
      if (over.material !== undefined) {
        writePieceProps(shared, { pieceLevel: true, trigger: shared.trigger?.kind ?? 'none', bumperPower: DEFAULT_BUMPER_POWER, material: over.material })
      }
      for (const k of Object.keys(over)) delete (over as Record<string, unknown>)[k]
      tidyOverride(n)
    },
    setTrack: (i, track) => {
      const n = node(i)
      if (n === undefined) return
      if (n.kind === 'piece') {
        const over = overrideFor(n, true)!
        // `static` is the override's way of saying "does not move here", which is not the same as saying
        // nothing — that would inherit the prefab's motion.
        over.behavior = track === null ? { kind: 'static' } : writeTrack(track)
        return
      }
      const inst = n.visit.inst
      if (track === null) delete inst.behavior
      else inst.behavior = writeTrack(track)
    },
    poseOf: (i, timeMs) => {
      const n = node(i)!
      const target = n.kind === 'piece' ? n.piece! : n.visit.inst
      return poseAt(target.behavior ?? { kind: 'static' }, target.transform, timeMs)
    },
    /**
     * Copy takes the *resolved* definitions rather than the ids alone: `prefabs` ends up holding an entry for
     * every id reachable from this subtree, including nested children's.
     */
    copy: (i) => {
      // A piece is not independently placeable: copying one would have to mean copying it *into* a prefab.
      const v = instanceNode(i)?.visit
      if (v === undefined) return null
      const prefabs: Record<string, Prefab> = {}
      const collect = (inst: PrefabInstance): void => {
        if (typeof inst.prefab === 'string') {
          const found = table()[inst.prefab]
          if (found !== undefined) prefabs[inst.prefab] = structuredClone(found)
        }
        for (const child of inst.children ?? []) collect(child)
      }
      collect(v.inst)
      return { kind: 'instance', instance: structuredClone(v.inst), prefabs }
    },
    paste: (item, parent) => {
      if (item.kind !== 'instance') return -1
      const inst = structuredClone(item.instance) as PrefabInstance
      // Re-point every reference at this level's table, interning what is missing. An id already present with
      // an identical definition is reused, which is what keeps pasting a prefab back into its own level from
      // filling the table with copies (`freeTableId` does that comparison).
      const remap = (node: PrefabInstance): void => {
        if (typeof node.prefab === 'string') {
          const carried = item.prefabs[node.prefab]
          if (carried !== undefined) node.prefab = intern(structuredClone(carried))
          else if (!(node.prefab in table())) {
            // Nothing carried it and nothing here defines it: the reference cannot be honoured, so the paste
            // becomes an inline empty rather than a level that fails to validate.
            node.prefab = { id: node.prefab, pieces: [] }
          }
        }
        for (const child of node.children ?? []) remap(child)
      }
      remap(inst)

      if (parent === null) {
        level.instances.push(inst)
      } else {
        const host = at(parent)?.inst
        if (host === undefined) return -1
        ;(host.children ??= []).push(inst)
      }
      return indexOfInstance(inst)
    },
    refOf: (i) => (node(i)?.kind === 'piece' ? null : refAt(i)),
    extract: (i) => {
      const inst = instanceNode(i)?.visit.inst
      if (inst === undefined || typeof inst.prefab === 'string') return null
      const id = intern(inst.prefab)
      inst.prefab = id
      return id
    },
    prefabAt: (id) => level.prefabs?.[id],
    refCount: (id) => instancesOf(level, id).length,
    asLevel: () => level,
    toJSON: () => level,
    setId: (id) => void (level.id = id),
  }
}

export const prefabDoc = (prefab: Prefab): Doc => {
  const pieces = prefab.pieces
  return {
    mode: 'prefab',
    count: () => pieces.length,
    kindOf: () => 'piece',
    transformOf: (i) => pieces[i]!.transform,
    meshSpecs: (i) => [
      {
        collider: pieces[i]!.collider,
        transform: { position: vec3(0, 0, 0) },
        name: pieces[i]!.name,
        model: visualModel(pieces[i]!.visual),
        material: visualMaterial(pieces[i]!.visual),
      },
    ],
    palette: () => Object.keys(PRIMITIVES),
    place: (name, position) => {
      const piece = (PRIMITIVES[name] ?? PRIMITIVES['box']!)()
      piece.transform = { position }
      pieces.push(piece)
      return pieces.length - 1
    },
    // A prefab holds pieces, never prefabs (ADR 0014), so placing one here appends its pieces. The name is
    // irrelevant: nothing is interned, so nothing needs an id.
    placePrefab: (prefab, _name, position) => {
      for (const piece of prefab.pieces) {
        const copy = structuredClone(piece)
        copy.transform = { ...copy.transform, position: vec3(position.x + copy.transform.position.x, position.y + copy.transform.position.y, position.z + copy.transform.position.z) }
        pieces.push(copy)
      }
      return pieces.length - 1
    },
    placeModel: (assetId, position) => {
      pieces.push({
        collider: { kind: 'box', halfExtents: vec3(0.5, 0.5, 0.5) },
        transform: { position },
        visual: { kind: 'model', asset: assetId },
      })
      return pieces.length - 1
    },
    // In prefab mode the palette offers primitives; wrapping one as a throwaway prefab lets the same
    // renderer draw its preview.
    prefabForPalette: (name) => {
      const make = PRIMITIVES[name]
      return make === undefined ? undefined : { id: name, pieces: [make()] }
    },
    remove: (i) => void pieces.splice(i, 1),
    duplicate: (i) => {
      pieces.push(structuredClone(pieces[i]!))
      return pieces.length - 1
    },
    label: (i) => {
      const pc = pieces[i]!
      return pc.name ?? `${pc.collider.kind}${pc.trigger !== undefined ? ` (${pc.trigger.kind})` : ''}`
    },
    nameOf: (i) => pieces[i]?.name ?? '',
    setName: (i, name) => {
      const pc = pieces[i]
      if (pc === undefined) return
      if (name === '') delete pc.name
      else pc.name = name
    },
    move: (from, to) => moveWithin(pieces, from, to),
    assetIds: () => {
      const ids = new Set<string>()
      for (const pc of pieces) {
        const model = visualModel(pc.visual)
        const material = visualMaterial(pc.visual)
        if (model !== undefined) ids.add(model)
        if (material !== undefined) ids.add(material)
      }
      return [...ids]
    },
    // A prefab is flat by design (ADR 0014): pieces have no children and cannot be reparented.
    depthOf: () => 0,
    parentOf: () => null,
    siblingIndexOf: (i) => i,
    pathOf: (i) => String(i),
    childCount: () => 0,
    canReparent: () => false,
    reparent: (from) => from,
    setTransform: (i, t) => {
      const pc = pieces[i]
      if (pc !== undefined) pc.transform = t
    },
    // In prefab mode the piece *is* the shared definition, so there is nothing to override and nothing to
    // revert or apply. Overrides exist between a placement and the prefab it references (ADR 0033).
    overridesOf: () => [],
    revert: () => {},
    applyToPrefab: () => {},
    props: (i) => {
      const pc = pieces[i]!
      return {
        pieceLevel: true,
        trigger: pc.trigger?.kind ?? 'none',
        bumperPower: pc.trigger?.kind === 'bumper' ? pc.trigger.power : DEFAULT_BUMPER_POWER,
        material: visualMaterial(pc.visual) ?? '',
      }
    },
    setProps: (i, p) => {
      const pc = pieces[i]
      if (pc !== undefined) writePieceProps(pc, p)
    },
    copy: (i) => {
      const pc = pieces[i]
      return pc === undefined ? null : { kind: 'piece', piece: structuredClone(pc) }
    },
    // Pieces are flat (ADR 0014), so there is nothing to paste *into* and `parent` is ignored.
    paste: (item) => {
      if (item.kind !== 'piece') return -1
      pieces.push(structuredClone(item.piece) as Piece)
      return pieces.length - 1
    },
    trackOf: (i) => readTrack(pieces[i]?.behavior),
    setTrack: (i, track) => {
      const pc = pieces[i]
      if (pc === undefined) return
      if (track === null) delete pc.behavior
      else pc.behavior = writeTrack(track)
    },
    poseOf: (i, timeMs) => {
      const pc = pieces[i]!
      return poseAt(pc.behavior ?? { kind: 'static' }, pc.transform, timeMs)
    },
    refOf: () => null,
    extract: () => null,
    prefabAt: () => undefined,
    refCount: () => 0,
    asLevel: () => ({ id: prefab.id, config: { fallBehavior: 'physical-fall', fallY: -999 }, instances: [{ prefab, transform: { position: vec3(0, 0, 0) } }] }),
    toJSON: () => prefab,
    setId: (id) => void (prefab.id = id),
  }
}

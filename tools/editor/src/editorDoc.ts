import {
  beam,
  checkpointPad,
  curvedBeam,
  freeTableId,
  gapJump,
  goalPad,
  hazardPad,
  instancesOf,
  ledge,
  movingPlatform,
  padChain,
  platform,
  ramp,
  resolvePrefab,
  rotatingBar,
  spawnPad,
  spiralStaircase,
  staircase,
  walkInstances,
  type Behavior,
  type ColliderDesc,
  type InstanceVisit,
  type Level,
  type Piece,
  type Prefab,
  type PrefabInstance,
  type Transform,
} from '@mp/content'
import { vec3, type Vec3 } from '@mp/core'

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
export type BehaviorKind = 'static' | 'move' | 'rotate'
export type TriggerChoice = 'none' | 'checkpoint' | 'goal' | 'hazard'

/** One mesh to draw under an item's group (transform is local to that group). */
export interface MeshSpec {
  collider: ColliderDesc
  transform: Transform
  style: string | undefined
}

/**
 * Per-item editable properties beyond the transform. `style` means the piece's own style in prefab
 * mode and the instance's **override** in level mode — the same question ("what colour is this")
 * answered at the level each mode owns. `trigger` belongs to a piece's collider, so it is editable
 * only in prefab mode; `pieceLevel` says which of the two we are.
 */
export interface ItemProps {
  behavior: BehaviorKind
  distance: number
  periodMs: number
  axis: Vec3
  pieceLevel: boolean
  style: string
  trigger: TriggerChoice
}

export interface Doc {
  readonly mode: Mode
  count: () => number
  transformOf: (i: number) => Transform
  meshSpecs: (i: number) => MeshSpec[]
  palette: () => string[]
  place: (name: string, position: Vec3) => number
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
  props: (i: number) => ItemProps
  setProps: (i: number, p: ItemProps) => void
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

const KIT: Record<string, () => Prefab> = {
  platform: () => platform(),
  ledge: () => ledge(),
  beam: () => beam(),
  ramp: () => ramp(),
  'gap jump': () => gapJump(),
  'moving platform': () => movingPlatform(),
  'rotating bar': () => rotatingBar(),
  staircase: () => staircase(),
  'spiral staircase': () => spiralStaircase(),
  'pad chain': () => padChain(),
  'curved beam': () => curvedBeam(),
  'spawn pad': () => spawnPad(),
  'checkpoint pad': () => checkpointPad(),
  'goal pad': () => goalPad(),
  'hazard pad': () => hazardPad(),
}

/** Every kit maker the palette offers — exported so a test can catch the kit growing past it. */
export const KIT_NAMES: readonly string[] = Object.keys(KIT)

// Primitive pieces for prefab mode. Only shapes the physics loader supports (no cylinder).
const PRIMITIVES: Record<string, () => Piece> = {
  box: () => ({ collider: { kind: 'box', halfExtents: vec3(1, 0.5, 1) }, transform: { position: vec3(0, 0, 0) } }),
  platform: () => ({ collider: { kind: 'box', halfExtents: vec3(1.5, 0.15, 1.5) }, transform: { position: vec3(0, 0, 0) } }),
  wall: () => ({ collider: { kind: 'box', halfExtents: vec3(1.5, 1, 0.15) }, transform: { position: vec3(0, 0, 0) } }),
  ball: () => ({ collider: { kind: 'ball', radius: 0.5 }, transform: { position: vec3(0, 0, 0) } }),
  capsule: () => ({ collider: { kind: 'capsule', halfHeight: 0.5, radius: 0.4 }, transform: { position: vec3(0, 0, 0) } }),
}

const kindOf = (b: Behavior | undefined): BehaviorKind => (b?.kind === 'move' ? 'move' : b?.kind === 'rotate' ? 'rotate' : 'static')
const readBehavior = (b: Behavior | undefined): Pick<ItemProps, 'behavior' | 'distance' | 'periodMs' | 'axis'> => ({
  behavior: kindOf(b),
  distance: b?.kind === 'move' ? b.distance : 3,
  periodMs: b?.kind === 'move' || b?.kind === 'rotate' ? b.periodMs : 4000,
  axis: b?.kind === 'move' || b?.kind === 'rotate' ? { ...b.axis } : vec3(0, 1, 0),
})
const makeBehavior = (p: ItemProps): Behavior | undefined => {
  if (p.behavior === 'move') return { kind: 'move', axis: p.axis, distance: p.distance, periodMs: p.periodMs }
  if (p.behavior === 'rotate') return { kind: 'rotate', axis: p.axis, periodMs: p.periodMs }
  return undefined
}

/**
 * Splice `arr`'s item at `from` so it lands *before* the original index `to`. `to` is expressed against
 * the array as it was, which is what a drop between two rows naturally gives you — hence the shift when
 * moving downward, where removing the item first pulls every later index back by one.
 */
const moveWithin = <T>(arr: T[], from: number, to: number): number => {
  if (from < 0 || from >= arr.length || from === to) return from
  const [item] = arr.splice(from, 1)
  const at = Math.max(0, Math.min(arr.length, to > from ? to - 1 : to))
  arr.splice(at, 0, item as T)
  return at
}

export const levelDoc = (level: Level, library: Record<string, Prefab>): Doc => {
  /**
   * Depth-first flatten, recomputed per call rather than cached. A cache has to be invalidated by every
   * mutation, including one made *through* the level object rather than through this doc — and the day it
   * misses, an index silently addresses the wrong node. Tens of instances, so the walk costs nothing worth
   * that risk.
   */
  const visits = (): InstanceVisit[] => walkInstances(level)
  const at = (i: number): InstanceVisit | undefined => visits()[i]
  const indexOfInstance = (inst: PrefabInstance): number => visits().findIndex((v) => v.inst === inst)

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
    const all = visits()
    const depth = all[i]?.depth ?? 0
    let j = i + 1
    while (j < all.length && (all[j]?.depth ?? 0) > depth) j++
    return j
  }
  const canReparent = (from: number, parent: number | null): boolean => {
    if (at(from) === undefined) return false
    if (parent === null) return true
    if (parent === from || at(parent) === undefined) return false
    // Its own subtree is exactly the run of deeper nodes after it.
    return !(parent > from && parent < subtreeEnd(from))
  }
  /** Drop a `children: []` left behind by a move, so the JSON does not accumulate empty arrays. */
  const tidy = (parent: PrefabInstance | null): void => {
    if (parent !== null && parent.children !== undefined && parent.children.length === 0) delete parent.children
  }

  return {
    mode: 'level',
    count: () => visits().length,
    transformOf: (i) => at(i)!.inst.transform,
    meshSpecs: (i) => {
      const inst = at(i)!.inst
      return resolvePrefab(level, inst).pieces.map((pc) => ({
        collider: pc.collider,
        transform: pc.transform,
        style: inst.style ?? pc.visual?.style,
      }))
    },
    // Kit makers, prefab files on disk, and whatever this level already defines — a prefab authored
    // here is placeable again without a round trip through a file.
    palette: () => [...new Set([...Object.keys(KIT), ...Object.keys(library), ...Object.keys(level.prefabs ?? {})])],
    place: (name, position) => {
      const make = KIT[name]
      let id: string
      if (make !== undefined) id = intern(make())
      else if (level.prefabs?.[name] !== undefined) id = name // already this level's own entry
      else {
        const copy = structuredClone(library[name]!)
        copy.id = name // a prefab file is known by its file name; the stored id may be stale
        id = intern(copy)
      }
      // Placing lands at the top level, as in Unity; parent it afterwards by dragging.
      const inst: PrefabInstance = { prefab: id, transform: { position } }
      level.instances.push(inst)
      return indexOfInstance(inst)
    },
    // Removing takes the subtree with it: children are placed relative to this item and have nowhere
    // to be without it.
    remove: (i) => {
      const v = at(i)
      if (v === undefined) return
      v.siblings.splice(v.index, 1)
      tidy(v.parent)
    },
    // A clone of a referencing instance references the same entry. Cloning the *definition* would
    // quietly break the very link the reference exists to provide. Children come along.
    duplicate: (i) => {
      const v = at(i)
      if (v === undefined) return i
      const copy = structuredClone(v.inst)
      v.siblings.splice(v.index + 1, 0, copy)
      return indexOfInstance(copy)
    },
    label: (i) => {
      const inst = at(i)!.inst
      return inst.name ?? refAt(i) ?? (inst.prefab as Prefab).id
    },
    nameOf: (i) => at(i)?.inst.name ?? '',
    setName: (i, name) => {
      const inst = at(i)?.inst
      if (inst === undefined) return
      if (name === '') delete inst.name
      else inst.name = name
    },
    move: (from, to) => {
      const v = at(from)
      if (v === undefined) return from
      moveWithin(v.siblings, v.index, to)
      return indexOfInstance(v.inst)
    },
    depthOf: (i) => at(i)?.depth ?? 0,
    parentOf: (i) => {
      const parent = at(i)?.parent
      return parent === null || parent === undefined ? null : indexOfInstance(parent)
    },
    siblingIndexOf: (i) => at(i)?.index ?? 0,
    pathOf: (i) => {
      const all = visits()
      const path: number[] = []
      let cur = all[i]
      while (cur !== undefined) {
        path.unshift(cur.index)
        const parent = cur.parent
        cur = parent === null ? undefined : all.find((v) => v.inst === parent)
      }
      return path.join('/')
    },
    childCount: (i) => at(i)?.inst.children?.length ?? 0,
    canReparent,
    reparent: (from, parent, atIndex) => {
      const v = at(from)
      if (v === undefined || !canReparent(from, parent)) return from
      const target = parent === null ? level.instances : (at(parent)!.inst.children ??= [])
      const sameList = target === v.siblings
      v.siblings.splice(v.index, 1)
      // Within one list this is a plain reorder, so the same downward shift applies as in `moveWithin`.
      const insertAt = Math.max(0, Math.min(target.length, sameList && atIndex > v.index ? atIndex - 1 : atIndex))
      target.splice(insertAt, 0, v.inst)
      if (!sameList) tidy(v.parent)
      return indexOfInstance(v.inst)
    },
    props: (i) => ({ ...readBehavior(at(i)!.inst.behavior), pieceLevel: false, style: at(i)!.inst.style ?? '', trigger: 'none' }),
    setProps: (i, p) => {
      const inst = at(i)!.inst
      const b = makeBehavior(p)
      if (b !== undefined) inst.behavior = b
      else delete inst.behavior
      if (p.style !== '') inst.style = p.style
      else delete inst.style
    },
    refOf: refAt,
    extract: (i) => {
      const inst = at(i)?.inst
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
    transformOf: (i) => pieces[i]!.transform,
    meshSpecs: (i) => [{ collider: pieces[i]!.collider, transform: { position: vec3(0, 0, 0) }, style: pieces[i]!.visual?.style }],
    palette: () => Object.keys(PRIMITIVES),
    place: (name, position) => {
      const piece = (PRIMITIVES[name] ?? PRIMITIVES['box']!)()
      piece.transform = { position }
      pieces.push(piece)
      return pieces.length - 1
    },
    remove: (i) => void pieces.splice(i, 1),
    duplicate: (i) => {
      pieces.push(structuredClone(pieces[i]!))
      return pieces.length - 1
    },
    label: (i) => {
      const pc = pieces[i]!
      return pc.name ?? `${pc.collider.kind}${pc.trigger !== undefined ? ` (${pc.trigger})` : ''}`
    },
    nameOf: (i) => pieces[i]?.name ?? '',
    setName: (i, name) => {
      const pc = pieces[i]
      if (pc === undefined) return
      if (name === '') delete pc.name
      else pc.name = name
    },
    move: (from, to) => moveWithin(pieces, from, to),
    // A prefab is flat by design (ADR 0014): pieces have no children and cannot be reparented.
    depthOf: () => 0,
    parentOf: () => null,
    siblingIndexOf: (i) => i,
    pathOf: (i) => String(i),
    childCount: () => 0,
    canReparent: () => false,
    reparent: (from) => from,
    props: (i) => {
      const pc = pieces[i]!
      return { ...readBehavior(pc.behavior), pieceLevel: true, style: pc.visual?.style ?? '', trigger: pc.trigger ?? 'none' }
    },
    setProps: (i, p) => {
      const pc = pieces[i]!
      const b = makeBehavior(p)
      if (b !== undefined) pc.behavior = b
      else delete pc.behavior
      if (p.style !== '') pc.visual = { kind: 'primitive', style: p.style }
      else delete pc.visual
      if (p.trigger === 'none') delete pc.trigger
      else pc.trigger = p.trigger
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

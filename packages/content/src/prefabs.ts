import { effectiveNode, type TypeInfo } from './nodes'
import { refInto, refPathOf } from './refPath'
import { retargetSequenceParams } from './sequenceData'
import { addedIdsOf, childListsOf, forEachNode } from './tree'

import type { ComponentData, Level, Node } from './types'

/**
 * A level references a prefab **by asset id** (ADR 0091), and the definition is resolved from the prefab file
 * before the level is used.
 *
 * `Level.prefabs` stays, but it is no longer part of the file: it is an **in-memory resolution map**, filled by
 * `hydratePrefabs` and removed again by `stripHydrated` on the way back to disk. That keeps one lookup for
 * every reader — `effectiveNode`, the loader, the editor's `Doc`, the op scoping and the hold machinery all
 * still do `level.prefabs[node.prefab]` — while the definition itself lives in exactly one place, so editing a
 * prefab reaches every level that uses it.
 *
 * Before this, placing a prefab file interned a *copy* under a table key made from its name, and editing the
 * file never reached a level. The live content had already drifted: two levels held a placement labelled
 * `FastElevator` whose contents were the `AlternatingDanger` file.
 *
 * **Hydration never clobbers an entry that is already there, and stripping removes only what hydration put
 * in.** That is what lets a level migrated to asset ids and one still carrying its own table coexist with no
 * version field and no detection: an old key resolves from the file's own table, a new id resolves from the
 * prefab asset, and neither loses anything when the level is written back. Without this rule, opening an
 * unmigrated level would drop its table on the first debounced write.
 */
export interface PrefabSource {
  /** The prefab file's root node for this asset id, or `undefined` when there is no such file. */
  root: (assetId: string) => Node | undefined
}

/**
 * Every prefab reference a level's placements make, in first-seen order — added children included (ADR 0151):
 * a placement moved under another placement's piece lives in that record, and missing it here meant its
 * prefab was never resolved when the level was opened again.
 */
export const prefabRefsIn = (level: Level): string[] => {
  const ids = new Set<string>()
  const add = (n: Node): void => {
    if (n.prefab !== undefined) ids.add(n.prefab)
  }
  forEachNode(level.nodes, add)
  // A prefab may not contain a placement (`validate.ts`), so the table itself never adds references. Walked
  // anyway, so a hand-edited file that broke the rule resolves rather than silently drawing nothing.
  forEachNode(Object.values(level.prefabs ?? {}), add)
  return [...ids]
}

/**
 * Fill `level.prefabs` from `source`, in place, for references that are not resolvable already. Reports what it
 * filled — which is what `stripHydrated` must remove — and what it could not find.
 *
 * The definition is assigned **by reference, not copied**: every level hydrated from the same source shares one
 * object, so an edit to a prefab is seen by each of them at once. Idempotent, and it never throws.
 *
 * A missing prefab is not an error (Kodjo's call): the placement keeps its own transform and components and
 * draws nothing, which is what `effectiveNode` already does for an unknown key, so one deleted file leaves a
 * gap in a level rather than stopping everyone from opening it. The `missing` ids are what the editor names in
 * the Hierarchy and what the game logs.
 */
export const hydratePrefabs = (level: Level, source: PrefabSource): { filled: string[]; missing: string[] } => {
  const filled: string[] = []
  const missing: string[] = []
  for (const id of prefabRefsIn(level)) {
    if (level.prefabs?.[id] !== undefined) continue // already resolvable: an unmigrated table, or a second pass
    const root = source.root(id)
    if (root === undefined) {
      missing.push(id)
      continue
    }
    ;(level.prefabs ??= {})[id] = root
    filled.push(id)
  }
  return { filled, missing }
}

/**
 * Drop the entries of a level's own table that **shadow a prefab asset** (ADR 0204), in place, and say which.
 *
 * An entry under an asset's id is a frozen copy of that asset: written to disk by a door that leaked a resolved
 * definition (ADR 0124's three, a duplicated open level), and read instead of the asset from then on, so the
 * placement looks linked and silently stops following its prefab. Run before `hydratePrefabs`, which then fills
 * the id from the asset and reports it, so `stripHydrated` keeps it off disk at the next write.
 *
 * Only ids `hasAsset` knows. An entry with no asset behind it is the level's only definition there, and stays.
 */
export const relinkPrefabs = (level: Level, hasAsset: (assetId: string) => boolean): string[] => {
  const table = level.prefabs
  if (table === undefined) return []
  const dropped = Object.keys(table).filter(hasAsset)
  for (const id of dropped) delete table[id]
  if (Object.keys(table).length === 0) delete level.prefabs
  return dropped
}

/**
 * The level as it goes to disk or on the wire: a shallow copy without the entries hydration added.
 *
 * Only those. A level that still carries its own table keeps it, so this is safe to run on content the
 * migration has not reached. A hydrated level must never cross a process boundary — each side resolves from
 * its own source, and a copy that travelled would stop following the prefab it came from.
 */
export const stripHydrated = <T extends Level>(level: T, filled: Iterable<string>): T => {
  const drop = new Set(filled)
  if (drop.size === 0 || level.prefabs === undefined) return level
  const kept = Object.fromEntries(Object.entries(level.prefabs).filter(([id]) => !drop.has(id)))
  const out = { ...level }
  if (Object.keys(kept).length > 0) out.prefabs = kept
  else delete out.prefabs
  return out
}
/** What unlinking needs that this package cannot know on its own. */
export interface UnlinkDeps {
  /** Which component types are singletons — how a placement's own component layers over the inherited one. */
  readonly types: TypeInfo
  /** A node id nothing in this level uses. Inherited children enter the level's id space and must not collide. */
  readonly freshId: () => string
  /**
   * Every `nodeRef` and `componentRef` a component type declares, as paths (`refPathsOf`: `key`, or `key[].column` in a
   * list's rows, ADR 0222), so a reference between two inherited nodes follows them when they are re-idded
   * (`retargetParams`).
   *
   * Injected because only a component registry knows, and this package has none — which is also why the
   * editor-server cannot do this and the editor must (ADR 0097).
   */
  readonly refKeysOf: (type: string) => readonly string[]
}

/**
 * A reference parameter's value with the node it names re-pointed: a `nodeRef`'s node id, or a `componentRef`'s
 * `{ node, component }` — the component id stays, since a copy's components keep theirs (ADR 0177). A reference into
 * a placement (ADR 0219) follows its placement when `to` maps the whole of it to nothing: a copy's, into the copy.
 * Anything else, or a node `to` does not map, comes back as it was.
 */
export const retargetRef = (value: unknown, to: (id: string) => string | undefined): unknown => {
  const map = (id: string): string | undefined => {
    const whole = to(id)
    if (whole !== undefined) return whole
    const path = refPathOf(id)
    const placement = path === null ? undefined : to(path.placement)
    return path === null || placement === undefined ? undefined : refInto(placement, path.node)
  }
  if (typeof value === 'string') return map(value) ?? value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const node = (value as { node?: unknown }).node
  const moved = typeof node === 'string' ? map(node) : undefined
  return moved === undefined ? value : { ...value, node: moved }
}

/**
 * The references at `paths` in `params` (`refPathsOf`: `key`, or `key[].column` in a list's rows, ADR 0222) re-pointed
 * by `to`, in place, a list's rows copied where one changes. Returns the keys whose value changed.
 */
export const retargetParams = (params: Record<string, unknown>, paths: readonly string[], to: (id: string) => string | undefined): string[] => {
  const changed = new Set<string>()
  for (const path of paths) {
    const cut = path.indexOf('[].')
    if (cut < 0) {
      if (!(path in params)) continue
      const was = params[path]
      const now = retargetRef(was, to)
      if (now !== was) {
        params[path] = now
        changed.add(path)
      }
      continue
    }
    const key = path.slice(0, cut)
    const column = path.slice(cut + 3)
    const rows = params[key]
    if (!Array.isArray(rows)) continue
    let moved = false
    const next = rows.map((r: unknown) => {
      if (typeof r !== 'object' || r === null || !(column in r)) return r
      const was = (r as Record<string, unknown>)[column]
      const now = retargetRef(was, to)
      if (now === was) return r
      moved = true
      return { ...(r as Record<string, unknown>), [column]: now }
    })
    if (moved) {
      params[key] = next
      changed.add(key)
    }
  }
  return [...changed]
}

/**
 * One placement, resolved into a plain node that needs no prefab to explain itself (ADR 0097).
 *
 * Keeps what the placement owns — its id, its transform, its position in the tree — and takes the resolved
 * name, components and children, which is exactly what was being drawn a moment before. Then drops `prefab`
 * and `overrides`, because there is nothing left to override.
 *
 * **The inherited subtree is cloned and re-idded.** Two things force it: `bakeOverrides` returns the prefab's
 * *own* objects when an override changed nothing, so two placements would end up sharing children and editing
 * one would silently edit the other; and the prefab's ids are minted in its own scope, so inlining two
 * placements of one prefab into a level would give it duplicate ids, which `validateLevel` refuses.
 *
 * A node that does not reference `assetId` comes back as-is, by identity.
 */
export const unlinkedNode = (level: Level, node: Node, assetId: string, deps: UnlinkDeps): Node => unlinked(level, node, assetId, deps).node

/** A placement unlinked (`unlinkedNode`), and what a reference into it (ADR 0219) names now. */
export interface Unlinked {
  readonly node: Node
  /**
   * What `<placement>/<inner>` becomes: the placement itself for its prefab's root, a piece's new id, a child the
   * placement added its own id — those were the level's all along. `undefined`: nothing in it had that id.
   */
  readonly into: (inner: string) => string | undefined
}

/** `unlinkedNode`, with where every reference into the placement goes now. `node` is `node` itself when it is not one. */
export const unlinked = (level: Level, node: Node, assetId: string, deps: UnlinkDeps): Unlinked => {
  if (node.prefab !== assetId) return { node, into: () => undefined }
  const resolved = effectiveNode(level, node, deps.types)
  const { prefab: _dropped, overrides: _also, ...own } = node
  // The placement's own children were already its own; only the inherited ones are new to this id space —
  // and among those, what the placement added under its pieces was the level's all along, and keeps its ids
  // so whatever in the level names it still does (ADR 0151).
  const inherited = resolved.children.slice(0, resolved.inheritedCount).map((k) => structuredClone(k))
  const kept = addedIdsOf(node)
  const { repoint, map } = reidForest(inherited, deps, kept)
  // The placement's own components can name the children just re-minted too — a sequence on a prefab's root
  // always does, since its steps target the root's children — so they follow the same map.
  const components = structuredClone(resolved.components) as ComponentData[]
  for (const c of components) repoint(c)
  const rootId = level.prefabs?.[assetId]?.id
  return {
    node: {
      ...own,
      ...(resolved.name === undefined ? {} : { name: resolved.name }),
      components,
      children: [...inherited, ...resolved.children.slice(resolved.inheritedCount)],
    },
    into: (inner) => (inner === rootId ? node.id : (map.get(inner) ?? (kept.has(inner) ? inner : undefined))),
  }
}

/**
 * Re-mint every id across a whole **forest** and re-point any reference that named one of them.
 *
 * The same rule as duplicating a subtree in the editor: without the re-point, the copy's references still
 * name the original, so it looks right and behaves as the original's shadow.
 *
 * The forest, not each root in turn, and that is the bug this was written with. A prefab's root has several
 * children and one of them may reference another; re-idding them one at a time gives each its own map, so the
 * reference is left naming an id that no longer exists anywhere. One map over all of them, then one pass to
 * re-point.
 */
const reidForest = (
  roots: readonly Node[],
  deps: UnlinkDeps,
  keep: ReadonlySet<string> = new Set(),
): { repoint: (c: ComponentData) => void; map: ReadonlyMap<string, string> } => {
  const map = new Map<string, string>()
  const rename = (x: Node): void => {
    // A subtree the level authored is already in its id space: left as it is, everything under it included.
    if (keep.has(x.id)) return
    const fresh = deps.freshId()
    map.set(x.id, fresh)
    x.id = fresh
    for (const kid of x.children ?? []) rename(kid)
  }
  for (const root of roots) rename(root)
  /** One component's references, repointed in place: its reference parameters, and a sequence's step targets. */
  const repoint = (c: ComponentData): void => {
    retargetParams(c.params, deps.refKeysOf(c.type), (id) => map.get(id))
    retargetSequenceParams(c, (id) => map.get(id))
  }
  const retarget = (x: Node): void => {
    for (const c of x.components) repoint(c)
    for (const kid of x.children ?? []) retarget(kid)
  }
  for (const root of roots) retarget(root)
  return { repoint, map }
}

/**
 * Every reference in `level` into a placement `into` knows (ADR 0219), re-pointed in place: `into(placement)` says,
 * for an inner id, where a reference into that placement goes now. Components, what a placement added, and what its
 * records patch — whose type is read off its prefab, a record being keyed by the prefab's node.
 */
export const retargetInto = (
  level: Level,
  refKeysOf: (type: string) => readonly string[],
  into: (placement: string) => ((inner: string) => string | undefined) | undefined,
): void => {
  const to = (id: string): string | undefined => {
    const path = refPathOf(id)
    return path === null ? undefined : into(path.placement)?.(path.node)
  }
  const repoint = (c: ComponentData): void => {
    retargetParams(c.params, refKeysOf(c.type), to)
  }
  forEachNode(level.nodes, (n) => {
    for (const c of n.components) repoint(c)
    const prefab = n.prefab === undefined ? undefined : level.prefabs?.[n.prefab]
    for (const [key, over] of Object.entries(n.overrides ?? {})) {
      for (const c of over.added ?? []) repoint(c)
      const pieces: Node[] = []
      if (prefab !== undefined) forEachNode([prefab], (x) => void (x.id === key && pieces.push(x)))
      for (const [cid, patch] of Object.entries(over.params ?? {})) {
        const type = pieces[0]?.components.find((c) => c.id === cid)?.type
        if (type === undefined) continue
        retargetParams(patch, refKeysOf(type), to)
      }
    }
  })
}

/**
 * Unlink every placement of one prefab, in place, and report how many there were (ADR 0097).
 *
 * What deleting a prefab does to the levels using it: the objects stay exactly where they are and keep what
 * they were drawing, they simply stop being copies of anything. Kodjo's call — the alternative was placements
 * that keep a transform and draw nothing, which is what a missing prefab has always degraded to (ADR 0091)
 * and is the right answer for a file that went missing by accident, not for one somebody chose to delete.
 *
 * Does **not** touch `level.prefabs`: that is the resolution map, rebuilt on every open, and it is
 * `stripHydrated`'s business on the way to disk.
 */
export const unlinkPrefab = (level: Level, assetId: string, deps: UnlinkDeps): number => {
  const done = new Map<string, (inner: string) => string | undefined>()
  const walk = (nodes: Node[]): void => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!
      const next = unlinked(level, node, assetId, deps)
      if (next.node !== node) {
        nodes[i] = next.node
        done.set(node.id, next.into)
      }
      // Every list under it, what a placement added under its pieces included (ADR 0151).
      for (const kids of childListsOf(nodes[i]!)) walk(kids)
    }
  }
  walk(level.nodes)
  // What pointed into them points at what they hold now (ADR 0219).
  if (done.size > 0) retargetInto(level, deps.refKeysOf, (placement) => done.get(placement))
  return done.size
}

import type { Level, Node } from './types'

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

/** Every prefab reference a level's placements make, in first-seen order. */
export const prefabRefsIn = (level: Level): string[] => {
  const ids = new Set<string>()
  const walk = (nodes: readonly Node[]): void => {
    for (const n of nodes) {
      if (n.prefab !== undefined) ids.add(n.prefab)
      if (n.children !== undefined) walk(n.children)
    }
  }
  walk(level.nodes)
  // A prefab may not contain a placement (`validate.ts`), so the table itself never adds references. Walked
  // anyway, so a hand-edited file that broke the rule resolves rather than silently drawing nothing.
  for (const root of Object.values(level.prefabs ?? {})) walk([root])
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

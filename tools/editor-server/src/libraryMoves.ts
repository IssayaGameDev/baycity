import type { AssetEntry } from '../../../packages/content/src/assets'
import { libraryOf, parseQualified } from '../../../packages/content/src/layout'
import { assetsUsedBy, levelsUsing } from '../../../packages/content/src/usage'

/**
 * Whether assets may move into another library, and why not (ADR 0161).
 *
 * A level uses its own game's assets and Shared's. So after a move, whatever uses the assets must still be allowed
 * to, and whatever they use must still be allowed to them:
 *
 * - **Into a game's library**, nothing outside that game may use them: no other game's level (Kodjo's rule: "used by
 *   3 Parkour levels" refuses), and no asset in another library — a Shared asset is anyone's to use, so it may use
 *   only what is in Shared.
 * - **Anywhere**, what they use must be in Shared or in the library they go to, or be moving with them.
 *
 * "Uses" is `usage.ts`'s: directly, or through a prefab or material. Pure.
 */
export interface LibraryWorld {
  /** Every asset. */
  entries: readonly AssetEntry[]
  /** Every level, by qualified name, as it is now. */
  levels: Iterable<readonly [name: string, json: unknown]>
  /** A prefab's, material's or shader's JSON as it is now; `undefined` for anything else. */
  contentsOf: (id: string) => unknown
}

/** `a`, `a and b`, `a, b and 2 more`. */
const listed = (items: readonly string[]): string => {
  if (items.length <= 2) return items.join(' and ')
  return `${items.slice(0, 2).join(', ')} and ${items.length - 2} more`
}

/** A library as a sentence names it. */
export const libraryName = (library: string | null): string => (library === null ? 'Shared' : library)

/**
 * Why `moving` may not go into library `to` (`null` for Shared, a game's name for its own), or `null` when it may.
 * `moving` is every asset being moved: a file, or everything in a folder.
 */
export const moveRefusal = (moving: readonly AssetEntry[], to: string | null, world: LibraryWorld): string | null => {
  const byId = new Map(world.entries.map((e) => [e.id, e]))
  const isAssetId = (s: string): boolean => byId.has(s)
  const moved = new Set(moving.map((e) => e.id))
  const thing = (e: AssetEntry): string => `${libraryName(libraryOf(e.path) ?? null)}'s ${e.kind} ${e.name}`

  if (to !== null) {
    const byLevel = levelsUsing(world.levels, isAssetId, world.contentsOf)
    const levels = new Set<string>()
    for (const id of moved) for (const level of byLevel.get(id) ?? []) if (parseQualified(level)?.game !== to) levels.add(level)
    if (levels.size > 0) {
      const perGame = new Map<string, number>()
      for (const level of levels) {
        const game = parseQualified(level)?.game ?? level
        perGame.set(game, (perGame.get(game) ?? 0) + 1)
      }
      return `used by ${listed([...perGame].sort(([a], [b]) => a.localeCompare(b)).map(([game, n]) => `${n} ${game} level${n === 1 ? '' : 's'}`))}`
    }

    const others = world.entries.filter((e) => !moved.has(e.id) && libraryOf(e.path) !== to)
    const byAsset = levelsUsing(
      others.map((e) => [e.id, world.contentsOf(e.id)] as const),
      isAssetId,
      world.contentsOf,
    )
    const users = new Set<string>()
    for (const id of moved) for (const user of byAsset.get(id) ?? []) users.add(user)
    if (users.size > 0) return `used by ${listed([...users].map((id) => thing(byId.get(id)!)).sort())}`
  }

  const stranded = new Set<string>()
  for (const e of moving) {
    for (const id of assetsUsedBy(world.contentsOf(e.id), isAssetId, world.contentsOf)) {
      const dep = byId.get(id)
      const library = dep === undefined ? null : (libraryOf(dep.path) ?? null)
      if (!moved.has(id) && library !== null && library !== to) stranded.add(id)
    }
  }
  if (stranded.size > 0) {
    const names = [...stranded].map((id) => thing(byId.get(id)!)).sort()
    return `uses ${listed(names)}: move ${stranded.size === 1 ? 'it' : 'them'} too, or into Shared first`
  }
  return null
}

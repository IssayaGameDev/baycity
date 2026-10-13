import { libraryOf, mayUse } from './layout'

/**
 * Which levels use which asset (ADR 0161): what a move between libraries has to check, what a game's build packs,
 * and what "used by" answers.
 *
 * **A reference is found the way Unity finds one: by its id appearing in the file.** An id is 64 random bits written
 * as 16 hex characters (`assetImporter.ts`), so a string equal to a known id is a reference to it, whatever field,
 * setting or table it sits in. That covers what no list of fields could: a game's own components, whose fields the
 * shared code never sees (a step pad's materials, ADR 0082), the level's settings, and the frozen prefab copies a
 * level keeps (ADR 0124). Only values count — a frozen copy's table is keyed by its prefab's id, and a key alone,
 * with no placement naming it, uses nothing.
 *
 * **Through what it uses, too.** A level that places a prefab uses the prefab's materials and models; a material
 * uses its textures and its shader. `contentsOf` hands over a prefab's or a material's JSON to walk next. A level
 * with a frozen copy is followed into the asset file as well as its copy, so it can be counted as using a little
 * more than it draws — never less, which is the direction a refusal and a build can afford to be wrong in.
 *
 * Pure: the server reads the files, the build reads its globs.
 */

/** Every known asset id among the string values in `json`, nested anywhere; keys are not references. */
const idsIn = (json: unknown, isAssetId: (s: string) => boolean, out: Set<string>): void => {
  if (typeof json === 'string') {
    if (isAssetId(json)) out.add(json)
    return
  }
  if (Array.isArray(json)) {
    for (const v of json) idsIn(v, isAssetId, out)
    return
  }
  if (typeof json === 'object' && json !== null) for (const v of Object.values(json)) idsIn(v, isAssetId, out)
}

/**
 * The assets `json` — a level, or any asset's JSON — uses, directly and through each prefab and material among them.
 * `contentsOf(id)` is that asset's JSON when it has any to follow (a prefab, a material), else `undefined`.
 */
export const assetsUsedBy = (json: unknown, isAssetId: (s: string) => boolean, contentsOf: (id: string) => unknown): Set<string> => {
  const used = new Set<string>()
  idsIn(json, isAssetId, used)
  const queue = [...used]
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    const inner = new Set<string>()
    idsIn(contentsOf(id), isAssetId, inner)
    for (const next of inner) {
      if (used.has(next)) continue
      used.add(next)
      queue.push(next)
    }
  }
  return used
}

/**
 * Who uses asset `id` (ADR 0165), directly or through what they use: the levels, by name, and the other assets — a
 * prefab, a material — by id; each sorted. What the asset Inspector's *Used by* lists.
 */
export const usersOf = (
  id: string,
  levels: Iterable<readonly [name: string, json: unknown]>,
  assets: Iterable<readonly [assetId: string, json: unknown]>,
  isAssetId: (s: string) => boolean,
  contentsOf: (id: string) => unknown,
): { levels: string[]; assets: string[] } => {
  const inLevels: string[] = []
  for (const [name, json] of levels) if (assetsUsedBy(json, isAssetId, contentsOf).has(id)) inLevels.push(name)
  const inAssets: string[] = []
  for (const [other, json] of assets) {
    if (other !== id && json !== undefined && assetsUsedBy(json, isAssetId, contentsOf).has(id)) inAssets.push(other)
  }
  return { levels: inLevels.sort(), assets: inAssets.sort() }
}

/**
 * What `json` — something of `user`'s: a game's name for its levels and its library's assets, `null` for Shared's —
 * uses and may not (ADR 0161), as content-relative paths, sorted; directly or through what it uses, as `assetsUsedBy`
 * walks. `pathOf(id)` is a known asset's path. Empty when it keeps to its libraries. The one rule the editor server
 * refuses a write by and `libraries.test.ts` checks the content against (ADR 0218).
 */
export const outOfLibrary = (
  user: string | null,
  json: unknown,
  isAssetId: (s: string) => boolean,
  contentsOf: (id: string) => unknown,
  pathOf: (id: string) => string | undefined,
): string[] =>
  [...assetsUsedBy(json, isAssetId, contentsOf)]
    .map(pathOf)
    .filter((p): p is string => p !== undefined && !mayUse(user, p))
    .sort()

/** Why a write of `user`'s is refused for using `outside` (`outOfLibrary`), or `null` when it uses nothing it may not. */
export const libraryRefusal = (user: string | null, outside: readonly string[]): string | null => {
  if (outside.length === 0) return null
  const named = outside.map((p) => `${libraryOf(p) ?? 'Shared'}'s ${p.slice(p.lastIndexOf('/') + 1)}`)
  const shown = named.length > 3 ? `${named.slice(0, 3).join(', ')} and ${named.length - 3} more` : named.join(', ')
  const rule = user === null ? 'Shared uses only Shared’s assets' : `${user} uses only its own assets and Shared’s`
  return `${rule}, and this uses ${shown}`
}

/** For each asset some level uses, the names of the levels using it, sorted. Assets no level uses are absent. */
export const levelsUsing = (
  levels: Iterable<readonly [name: string, json: unknown]>,
  isAssetId: (s: string) => boolean,
  contentsOf: (id: string) => unknown,
): Map<string, string[]> => {
  const byAsset = new Map<string, string[]>()
  for (const [name, json] of levels) {
    for (const id of assetsUsedBy(json, isAssetId, contentsOf)) byAsset.set(id, [...(byAsset.get(id) ?? []), name])
  }
  for (const names of byAsset.values()) names.sort()
  return byAsset
}

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

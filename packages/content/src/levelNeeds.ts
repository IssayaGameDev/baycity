import type { AssetKind } from './assets'
import { levelFile, levelRefForFile, mayUse, LEVEL_SUFFIX, LEVELS_DIR, type LevelRef } from './layout'
import { assetsUsedBy } from './usage'

/**
 * What a game's page downloads to play one level, and where it finds it (ADR 0169).
 *
 * **Every file stays its own file**, at its path from `content/`, and a level comes with a **list of what it
 * needs**: the level, and every asset it uses through its prefabs and materials (`usage.ts`), each with its kind
 * and its address. The page reads the game's level index, picks a level, reads that level's list, then the files on
 * it — and nothing else. A texture two levels share is one file both lists name, so the browser keeps it once.
 *
 * **The same addresses everywhere**, relative to the game page's own: `content/<game>/levels.json`, then
 * `content/<game>/levels/<name>.needs.json`, then each entry's `url`. A build writes them as files; the local dev
 * server makes them from disk; on the box the editor server answers them live. So the page has one way to load
 * a level, and a build never talks to the editor server.
 *
 * Pure: whoever serves the files hands over what it knows of the assets (`ContentCatalog`).
 */

/** The folder a game's page finds its content under, relative to the page's own address. */
export const PLAY_CONTENT_DIR = 'content'

/** The level a game loads with no `?level=`, when it has one of this name (ADR 0108). */
export const DEFAULT_LEVEL = 'default'

/** A game's playable levels, `default` first and the rest sorted, and the one that loads with no `?level=`. */
export interface LevelIndex {
  levels: string[]
  default: string
}

/** One file a level needs: its asset id and kind, its path from `content/`, and where the page fetches it. */
export interface NeededAsset {
  id: string
  kind: AssetKind
  path: string
  /** Relative to the game page's address. */
  url: string
}

/** Everything one level needs: the level file's address and the assets it uses, sorted by path. */
export interface LevelNeeds {
  level: string
  assets: NeededAsset[]
}

/** The assets whoever serves the content knows: by id, by path, and a prefab's or material's JSON to follow. */
export interface ContentCatalog {
  byId: (id: string) => { kind: AssetKind; path: string } | undefined
  byPath: (path: string) => { id: string } | undefined
  /** The asset's JSON as it is now, when it has any to follow (a prefab, a material), else `undefined`. */
  contentsOf: (id: string) => unknown
}

const NEEDS_SUFFIX = '.needs.json'

/** A game's level index, relative to `PLAY_CONTENT_DIR`. Beside its `levels/` folder, where no level can be. */
export const levelIndexFile = (game: string): string => `${game}/levels.json`

/** A level's list, relative to `PLAY_CONTENT_DIR`: beside the level file, under a suffix no level has. */
export const levelNeedsFile = (ref: LevelRef): string => `${ref.game}/${LEVELS_DIR}/${ref.name}${NEEDS_SUFFIX}`

/** The level a list's path names, or `null` when the path is not a list: `levelRefForFile`'s rule, with the list's suffix. */
export const levelOfNeedsFile = (path: string): LevelRef | null =>
  path.endsWith(NEEDS_SUFFIX) ? levelRefForFile(`${path.slice(0, -NEEDS_SUFFIX.length)}${LEVEL_SUFFIX}`) : null

/** The index over a game's level names: `default` first when there is one, and the default the first level. */
export const levelIndexOf = (names: Iterable<string>): LevelIndex => {
  const all = [...new Set(names)]
  const levels = [...(all.includes(DEFAULT_LEVEL) ? [DEFAULT_LEVEL] : []), ...all.filter((n) => n !== DEFAULT_LEVEL).sort()]
  return { levels, default: levels[0] ?? DEFAULT_LEVEL }
}

/**
 * The list for level `ref`, whose JSON is `level`. `code`: paths the game's own code loads, which no level names
 * (`CODE_ASSETS`). `urlOf`: a path from `content/` → where the page fetches it.
 *
 * Only what the game may use is listed — its own library's and Shared's (`mayUse`, ADR 0161) — so a reference into
 * another game's library draws as it does in the editor: not at all.
 */
export const levelNeeds = (
  ref: LevelRef,
  level: unknown,
  catalog: ContentCatalog,
  code: readonly string[],
  urlOf: (path: string) => string,
): LevelNeeds => {
  const usable = (id: string): boolean => {
    const entry = catalog.byId(id)
    return entry !== undefined && mayUse(ref.game, entry.path)
  }
  const ids = assetsUsedBy(level, usable, (id) => (usable(id) ? catalog.contentsOf(id) : undefined))
  for (const path of code) {
    const id = catalog.byPath(path)?.id
    if (id !== undefined && usable(id)) ids.add(id)
  }
  const assets: NeededAsset[] = []
  for (const id of ids) {
    const entry = catalog.byId(id)
    if (entry !== undefined) assets.push({ id, kind: entry.kind, path: entry.path, url: urlOf(entry.path) })
  }
  assets.sort((a, b) => a.path.localeCompare(b.path))
  return { level: urlOf(levelFile(ref)), assets }
}

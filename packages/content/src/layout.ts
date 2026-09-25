/**
 * Where content lives on disk (ADR 0108).
 *
 * **A game is a folder at the content root.** It holds that game's `game.json`, its `levels/`, and its own asset
 * library, `assets/`, beside the **shared** one at `content/assets/` that every game uses (ADR 0161, amending
 * ADR 0108's single library).
 *
 * ```
 * content/
 *   keyboard/  game.json  levels/default.level.json  assets/…
 *   parkour/   game.json  levels/default.level.json
 *   assets/    materials/ prefabs/ textures/
 * ```
 *
 * Every path here is **relative to `content/`** and forward-slashed. The server prefixes `content/` for lock
 * keys and commits; the editor and the game reach the same files over the API and a build-time glob.
 *
 * One module so the three readers cannot disagree. The layout used to be spelled out at a dozen call sites —
 * a regex in the API router, a `join` in the server, a glob in the game, a template string in two lock-key
 * tables — and `content/levels/` being flat was one of the twelve implicit answers ADR 0052 set out to remove.
 */

/** A game folder's own file: its adopted shared components (ADR 0077) and its settings (ADR 0087). */
export const GAME_FILE = 'game.json'
/** What makes a file a level. A compound suffix, like `.mat.json` and `.prefab.json` (ADR 0026). */
export const LEVEL_SUFFIX = '.level.json'
/** An asset library's folder: the shared one at the content root, and each game's own inside its folder. So no game may take the name. */
export const ASSETS_DIR = 'assets'
/** The levels folder inside a game's. */
export const LEVELS_DIR = 'levels'

/** A level is a game and a name. Neither alone identifies a file: two games may both own a `default`. */
export interface LevelRef {
  game: string
  name: string
}

/**
 * A game or level name: what may be typed into the name field and appear in a URL.
 *
 * The same shape the API router accepted for a flat level name, so nothing that was legal became illegal.
 */
const SEGMENT = /^[\w-]+$/

export const isSegment = (s: string): boolean => SEGMENT.test(s)

/** A game folder's name. `assets` is refused: the shared library already has that folder. */
export const isGameName = (s: string): boolean => isSegment(s) && s !== ASSETS_DIR

/**
 * `<game>/<name>` — a level's identity everywhere outside its own folder: the API route, the lock key, the
 * live document key, the editor's open file.
 *
 * The **game's own `?level=` stays bare** (ADR 0108): a page knows which game it is, so it qualifies the name
 * itself. That is what lets every game own a level called `default`, which a flat folder could not
 * (`packages/game-client/src/levels.ts` carried the apology for it).
 */
export const qualify = (ref: LevelRef): string => `${ref.game}/${ref.name}`

/** Split a qualified name, or `null` if it is not one. Rejects extra segments, empty parts and `assets`. */
export const parseQualified = (qual: string): LevelRef | null => {
  const at = qual.indexOf('/')
  if (at <= 0) return null
  const game = qual.slice(0, at)
  const name = qual.slice(at + 1)
  if (!isGameName(game) || !isSegment(name)) return null
  return { game, name }
}

/** A level's file, relative to `content/`. */
export const levelFile = (ref: LevelRef): string => `${ref.game}/${LEVELS_DIR}/${ref.name}${LEVEL_SUFFIX}`

/** A game's own file, relative to `content/`. */
export const gameFile = (game: string): string => `${game}/${GAME_FILE}`

/**
 * An asset library's folder, relative to `content/` (ADR 0161): the shared one (`null`), or a game's own.
 *
 * **An asset's path starts with its library** — `assets/materials/red.mat.json`, `keyboard/assets/prefabs/pad.prefab.json`
 * — so the path says which library a file is in, and the same name in two libraries is two assets, not one.
 */
export const libraryDir = (game: string | null): string => (game === null ? ASSETS_DIR : `${game}/${ASSETS_DIR}`)

/**
 * The library a content-relative path is in, its own folder included: `null` for the shared one, the game's name
 * for a game's own, `undefined` for a path in no library (a level, a `game.json`, anything else).
 */
export const libraryOf = (path: string): string | null | undefined => {
  const parts = path.split('/')
  if (parts[0] === ASSETS_DIR) return null
  const game = parts[0]
  return parts[1] === ASSETS_DIR && game !== undefined && isGameName(game) ? game : undefined
}

/**
 * Whether something belonging to `user` may use the asset at `path` (ADR 0161). `user` is a game's name for its levels
 * and its own library's assets, `null` for Shared's: a game's things use their own game's and Shared's; Shared's use
 * only Shared's, since any game may use them.
 */
export const mayUse = (user: string | null, path: string): boolean => {
  const library = libraryOf(path)
  return library === null || (library !== undefined && library === user)
}

/** Whether a content-relative path is **inside** a library — a file or folder in it, not the library's own folder. */
export const inLibrary = (path: string): boolean => {
  const library = libraryOf(path)
  if (library === undefined) return false
  const depth = library === null ? 1 : 2
  const parts = path.split('/')
  return parts.length > depth && parts.every((p) => p !== '' && p !== '.' && p !== '..')
}

/**
 * The `LevelRef` a content-relative path names, or `null` when the path is not a level.
 *
 * Strict on purpose: the folder is the game, so a `.level.json` anywhere else — loose at the root, or under
 * `assets/` — is not a level, and is better ignored than loaded as one belonging to no game.
 */
export const levelRefForFile = (rel: string): LevelRef | null => {
  if (!rel.endsWith(LEVEL_SUFFIX)) return null
  const parts = rel.split('/')
  if (parts.length !== 3 || parts[1] !== LEVELS_DIR) return null
  const game = parts[0]
  const file = parts[2]
  if (game === undefined || file === undefined || !isGameName(game)) return null
  const name = file.slice(0, -LEVEL_SUFFIX.length)
  return isSegment(name) ? { game, name } : null
}

/**
 * Where content lives on disk (ADR 0108).
 *
 * **A game is a folder at the content root.** It holds that game's `game.json` and its `levels/`. Assets stay
 * one shared library at `content/assets/`, because they are shared in fact: of twenty assets, nine are used by
 * more than one game and four by exactly one, so a per-game split would duplicate nearly half of them.
 *
 * ```
 * content/
 *   keyboard/  game.json  levels/default.level.json
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
/** The shared asset library's folder, and therefore a name no game may take. */
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

/** An asset's file, relative to `content/`, from its path inside the shared library. */
export const assetFile = (rel: string): string => `${ASSETS_DIR}/${rel}`

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

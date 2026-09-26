import {
  ASSET_KINDS,
  levelIndexFile,
  levelNeedsFile,
  PLAY_CONTENT_DIR,
  validateLevel,
  type AssetKind,
  type Level,
  type LevelIndex,
  type LevelNeeds,
  type NeededAsset,
  type ParamChecker,
} from '@mp/content'

import { levelAssets, type LevelAssets } from './assets'

/**
 * The level a page plays, fetched at boot with only what it uses (ADR 0169).
 *
 * **A game is a folder** (ADR 0108): its levels are `content/<game>/levels/*.level.json`, and `default.level.json`
 * is what loads with no `?level=` — or, when a game has none, its first level, so a game whose `default` was deleted
 * still boots. Which levels there are comes from the game's level index; the level itself, its list and the files
 * on the list come after, all relative to the page's own address (`@mp/content` `levelNeeds.ts`).
 *
 * Nothing is bundled any more. The page used to carry every level of its game, and every asset of its libraries,
 * in its code: every player downloaded all of it, and on the box every asset edit reloaded every open page. A
 * build writes the files beside itself instead, the local dev server serves them from disk, and on the box the
 * editor server answers live — so the same code plays a shipped build, a local game and the staging game.
 */

/** Reads JSON from an absolute URL: `fetch` in the page, a table in the tests. */
export type ReadJson = (url: string) => Promise<unknown>

export const readJson: ReadJson = async (url) => {
  const r = await fetch(url, { headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`)
  return (await r.json()) as unknown
}

/** A level ready to instantiate, with its name and the assets it uses. */
export interface PlayedLevel extends LevelAssets {
  name: string
  level: Level
}

/** The level to play: the one asked for when the game has it, else its default — a typo must not brick the page. */
export const levelNameFor = (game: string, index: LevelIndex, requested: string | null): string => {
  if (index.levels.length === 0) throw new Error(`no ${game} levels`)
  if (requested === null) return index.default
  if (index.levels.includes(requested)) return requested
  console.error(`no ${game} level "${requested}" — have: ${index.levels.join(', ')} — falling back to ${index.default}`)
  return index.default
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string')

const asIndex = (v: unknown, where: string): LevelIndex => {
  const o = (typeof v === 'object' && v !== null ? v : {}) as { levels?: unknown; default?: unknown }
  if (!isStrings(o.levels) || typeof o.default !== 'string') throw new Error(`${where}: not a level index`)
  return { levels: o.levels, default: o.default }
}

const asNeeded = (v: unknown): NeededAsset | null => {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  const { id, kind, path, url } = o
  if (typeof id !== 'string' || typeof path !== 'string' || typeof url !== 'string') return null
  if (typeof kind !== 'string' || !(ASSET_KINDS as readonly string[]).includes(kind)) return null
  return { id, kind: kind as AssetKind, path, url }
}

const asNeeds = (v: unknown, where: string): LevelNeeds => {
  const o = (typeof v === 'object' && v !== null ? v : {}) as { level?: unknown; assets?: unknown }
  if (typeof o.level !== 'string' || !Array.isArray(o.assets)) throw new Error(`${where}: not a level's list`)
  return { level: o.level, assets: o.assets.map(asNeeded).filter((a): a is NeededAsset => a !== null) }
}

/**
 * A level is this game's when it does not claim to be another's. The folder decides on disk (ADR 0108); a file that
 * arrives over HTTP has no folder, and unassigned still passes, because a level made this second must stay playable.
 */
const ours = (game: string, data: unknown): boolean => {
  const named = (data as { config?: { mode?: { name?: unknown } } } | null)?.config?.mode?.name
  return named === undefined || named === game
}

/**
 * `game`'s level `requested` — or its default — with everything it uses, validated against `registry`, so a bad
 * component parameter is a load error rather than a surprise mid-frame. `base` is the page's absolute address.
 *
 * Throws when the index, the list or the level will not load: there is nothing to play. A prefab or material that
 * will not load is an unresolved reference, which greyboxes, as a dangling one always has.
 */
export const loadLevel = async (game: string, requested: string | null, registry: ParamChecker, base: string, read: ReadJson = readJson): Promise<PlayedLevel> => {
  const at = (rel: string): string => new URL(rel, base).href
  const indexAt = at(`${PLAY_CONTENT_DIR}/${levelIndexFile(game)}`)
  const name = levelNameFor(game, asIndex(await read(indexAt), indexAt), requested)
  const needsAt = at(`${PLAY_CONTENT_DIR}/${levelNeedsFile({ game, name })}`)
  const needs = asNeeds(await read(needsAt), needsAt)
  const docs = needs.assets.filter((a) => a.kind === 'prefab' || a.kind === 'material')
  const [raw, ...fetched] = await Promise.all([
    read(at(needs.level)),
    ...docs.map((a) =>
      read(at(a.url)).catch((e: unknown) => {
        console.warn(`${a.path} did not load (${String(e)})`)
        return undefined
      }),
    ),
  ])
  if (!ours(game, raw)) throw new Error(`level "${name}" belongs to another game, not ${game}`)
  const level = validateLevel(raw, registry)
  return { name, level, ...levelAssets(needs, new Map(docs.map((a, i) => [a.id, fetched[i]])), base) }
}

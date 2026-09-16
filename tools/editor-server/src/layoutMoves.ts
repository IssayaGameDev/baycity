import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { gameFile, isGameName, levelFile } from '../../../packages/content/src/layout'

/**
 * Planning and applying the move to the per-game folder layout (ADR 0108). The CLI around this is
 * `migrateLayout.ts`; the split is so the decisions can be tested against a temp tree without running a
 * script that reads `process.argv` and calls `process.exit`.
 */

export interface Move {
  from: string
  to: string
}

export interface LayoutPlan {
  moves: Move[]
  /** Why a file cannot move. A non-empty list means nothing moves at all. */
  refusals: string[]
}

/**
 * What would move, and what cannot. Pure: reads the tree, writes nothing.
 *
 * ```
 * content/games/keyboard.json    ->  content/keyboard/game.json
 * content/levels/keyboard2.json  ->  content/keyboard/levels/keyboard2.level.json
 * ```
 *
 * A level's folder is the game it already declares in `config.mode.name`, so nothing inside any file needs to
 * change. A level declaring **no** game, or one whose game has no data file, is refused and named: there is
 * no folder to put it in, and inventing one is not this script's decision to make.
 */
export const planLayout = (content: string): LayoutPlan => {
  const moves: Move[] = []
  const refusals: string[] = []
  const gamesDir = join(content, 'games')
  const levelsDir = join(content, 'levels')

  /** The games that have a data file, which is the set a level may belong to. */
  const games = new Set(
    existsSync(gamesDir)
      ? readdirSync(gamesDir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => f.slice(0, -'.json'.length))
          .filter(isGameName)
      : [],
  )

  for (const game of [...games].sort()) moves.push({ from: `games/${game}.json`, to: gameFile(game) })

  if (existsSync(levelsDir)) {
    for (const f of readdirSync(levelsDir).sort()) {
      if (!f.endsWith('.json')) continue
      const name = f.slice(0, -'.json'.length)
      let game: string | undefined
      try {
        const raw = JSON.parse(readFileSync(join(levelsDir, f), 'utf8')) as { config?: { mode?: { name?: unknown } } }
        const declared = raw.config?.mode?.name
        game = typeof declared === 'string' && declared !== '' ? declared : undefined
      } catch (e) {
        refusals.push(`levels/${f}: will not parse (${String(e)})`)
        continue
      }
      if (game === undefined) {
        refusals.push(`levels/${f}: declares no game, so there is no folder for it — set config.mode.name first`)
        continue
      }
      if (!isGameName(game)) {
        refusals.push(`levels/${f}: "${game}" is not a usable folder name`)
        continue
      }
      if (!games.has(game)) {
        refusals.push(`levels/${f}: declares "${game}", which has no content/games/${game}.json`)
        continue
      }
      if (!isGameName(name) && !/^[\w-]+$/.test(name)) {
        refusals.push(`levels/${f}: "${name}" is not a usable file name`)
        continue
      }
      moves.push({ from: `levels/${f}`, to: levelFile({ game, name }) })
    }
  }
  return { moves, refusals }
}

/**
 * Apply a plan. Refuses to overwrite anything, and verifies every move byte-for-byte.
 *
 * A rename cannot alter the bytes, which is exactly why this migration is safe — so it is checked out loud
 * rather than trusted: this is Kodjo's authored content, and the check costs one read per file.
 */
export const applyLayout = (content: string, moves: readonly Move[]): void => {
  for (const { from, to } of moves) {
    const src = join(content, from)
    const dst = join(content, to)
    if (existsSync(dst)) throw new Error(`${to} already exists; refusing to overwrite`)
    const before = readFileSync(src)
    mkdirSync(dirname(dst), { recursive: true })
    renameSync(src, dst)
    if (!readFileSync(dst).equals(before)) throw new Error(`${to} changed in the move; stop and restore ${from}`)
  }
}

/** Remove `levels/` and `games/` once empty. A leftover file is left alone, and the folder with it. */
export const tidyOldFolders = (content: string): string[] => {
  const gone: string[] = []
  for (const d of ['levels', 'games']) {
    const full = join(content, d)
    if (existsSync(full) && statSync(full).isDirectory() && readdirSync(full).length === 0) {
      rmdirSync(full)
      gone.push(d)
    }
  }
  return gone
}

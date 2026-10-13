import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { isGameName, kindForPath, levelRefForFile, libraryDir, libraryOf, LEVELS_DIR, META_SUFFIX, outOfLibrary } from '@mp/content'
import { describe, expect, it } from 'vitest'

/**
 * Every game's content keeps to its libraries (ADR 0161): a level uses only its own game's assets and Shared's, and
 * so does anything in its game's library, while Shared's assets use only Shared's — any game may use them. The editor
 * server refuses a write that would break it (ADR 0218); this is the net under that.
 *
 * Read-only over `content/`: sidecars are read, never written, so an asset that has none yet is simply not known here
 * (the importer gives it one; `levels.test.ts` and each game's own checks cover what exists).
 */
describe('every game keeps to its asset libraries', () => {
  const root = 'content'
  const files = (dir: string): string[] =>
    !existsSync(dir) ? [] : readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)).map((f) => `${n}/${f}`) : [n]))

  const games = readdirSync(root).filter((n) => isGameName(n) && existsSync(join(root, n, 'game.json')))
  const libraries = [libraryDir(null), ...games.map((g) => libraryDir(g))]
  /** Every asset with a sidecar, by id: its path from `content/`. */
  const paths = new Map<string, string>()
  for (const library of libraries) {
    for (const f of files(join(root, library))) {
      if (!f.endsWith(META_SUFFIX)) continue
      const path = `${library}/${f.slice(0, -META_SUFFIX.length)}`
      if (kindForPath(path) === undefined) continue
      const meta = JSON.parse(readFileSync(join(root, `${path}${META_SUFFIX}`), 'utf8')) as { id: string }
      paths.set(meta.id, path)
    }
  }
  const isAssetId = (s: string): boolean => paths.has(s)
  const contentsOf = (id: string): unknown => {
    const path = paths.get(id)
    if (path === undefined || !path.endsWith('.json') || !existsSync(join(root, path))) return undefined
    return JSON.parse(readFileSync(join(root, path), 'utf8')) as unknown
  }
  /** What `json` uses that `user` may not, as paths: the rule the editor server refuses a write by (ADR 0218). */
  const outOfBounds = (user: string | null, json: unknown): string[] => outOfLibrary(user, json, isAssetId, contentsOf, (id) => paths.get(id))

  it('knows some assets, so an empty walk cannot pass vacuously', () => {
    expect(paths.size).toBeGreaterThan(0)
  })

  it.each(games)('%s: its levels use only its own assets and Shared’s', (game) => {
    const dir = join(root, game, LEVELS_DIR)
    const levels = existsSync(dir) ? readdirSync(dir).filter((f) => levelRefForFile(`${game}/${LEVELS_DIR}/${f}`) !== null) : []
    const wrong = levels.flatMap((f) => outOfBounds(game, JSON.parse(readFileSync(join(dir, f), 'utf8'))).map((p) => `${f} → ${p}`))
    expect(wrong).toEqual([])
  })

  it('every asset uses only what its library may: Shared’s only Shared’s, a game’s its own and Shared’s', () => {
    const wrong: string[] = []
    for (const [id, path] of paths) for (const p of outOfBounds(libraryOf(path) ?? null, contentsOf(id))) wrong.push(`${path} → ${p}`)
    expect(wrong).toEqual([])
  })
})

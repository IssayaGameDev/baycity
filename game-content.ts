import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import { CODE_ASSETS } from './packages/game-client/src/codeAssets'
import { kindForPath, META_SUFFIX } from './packages/content/src/assets'
import { ASSETS_DIR, GAME_FILE, isGameName, LEVELS_DIR, LEVEL_SUFFIX, libraryDir } from './packages/content/src/layout'
import { assetsUsedBy } from './packages/content/src/usage'
import { contentRoot } from './content-root'

/**
 * What a game carries of `content/` (ADR 0161), as the module `virtual:game-content` that `@mp/game-client` reads.
 *
 * **Its own levels, and assets from its own library and Shared's only** — another game's levels and library are not
 * in it at all. Built (`vite build`), it goes further: **only the assets its levels use**, followed through prefabs
 * and materials (`usage.ts`), its `game.json`, and what the client's own code loads by path (`CODE_ASSETS`). Served
 * (`vite`, the staging game on the box), it keeps the whole of both libraries: a page there reads its level live at
 * boot (ADR 0089), and that level may use an asset placed seconds ago.
 *
 * With no game (the tests), everything: every library and every game's levels.
 *
 * Imported by relative path from each game's `vite.config.ts` and the root `vitest.config.ts`, like `content-root.ts`.
 */

export const GAME_CONTENT_ID = 'virtual:game-content'
const RESOLVED = `\0${GAME_CONTENT_ID}`

/** What goes in: level files and asset files, by their paths from `content/`. */
export interface GameContentFiles {
  levels: string[]
  /** Asset files with a sidecar. */
  assets: string[]
}

const posix = (p: string): string => p.split(sep).join('/')
const filesUnder = (dir: string): string[] =>
  !existsSync(dir) ? [] : readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? filesUnder(join(dir, n)) : [join(dir, n)]))
const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    return undefined // a file that will not parse carries no references; the game's own checks say so
  }
}

/** The games under `root`: folders holding a `game.json`. */
const gamesIn = (root: string): string[] => readdirSync(root).filter((n) => isGameName(n) && existsSync(join(root, n, GAME_FILE))).sort()

/**
 * The files `game` carries: `'library'` for its whole library and Shared's, `'used'` for only what its levels use.
 * `game` `null`: every library and every game's levels. Pure over the files on disk.
 */
export const gameContentFiles = (root: string, game: string | null, pack: 'library' | 'used'): GameContentFiles => {
  const games = game === null ? gamesIn(root) : [game]
  const levels = games.flatMap((g) =>
    filesUnder(join(root, g, LEVELS_DIR))
      .map((f) => posix(relative(root, f)))
      .filter((p) => p.endsWith(LEVEL_SUFFIX) && p.split('/').length === 3),
  )
  const libraries = [libraryDir(null), ...games.map((g) => libraryDir(g))]
  const byId = new Map<string, string>()
  for (const library of libraries) {
    for (const f of filesUnder(join(root, library))) {
      if (!f.endsWith(META_SUFFIX)) continue
      const path = posix(relative(root, f.slice(0, -META_SUFFIX.length)))
      if (kindForPath(path) === undefined || !existsSync(join(root, path))) continue
      const id = (readJson(f) as { id?: unknown } | undefined)?.id
      if (typeof id === 'string') byId.set(id, path)
    }
  }
  if (pack === 'library' || game === null) return { levels, assets: [...byId.values()].sort() }

  const contentsOf = (id: string): unknown => {
    const path = byId.get(id)
    return path !== undefined && path.endsWith('.json') ? readJson(join(root, path)) : undefined
  }
  const isAssetId = (s: string): boolean => byId.has(s)
  const used = new Set<string>()
  for (const file of [...levels, `${game}/${GAME_FILE}`]) for (const id of assetsUsedBy(readJson(join(root, file)), isAssetId, contentsOf)) used.add(id)
  const paths = new Set([...used].map((id) => byId.get(id)!))
  for (const path of CODE_ASSETS) if ([...byId.values()].includes(path)) paths.add(path)
  return { levels, assets: [...paths].sort() }
}

/** The module's source: an import per file, through the `@content` alias, keyed by the path from `content/`. */
export const gameContentModule = (files: GameContentFiles): string => {
  const lines: string[] = []
  const table = (name: string, entries: [string, string][]): void => {
    lines.push(`export const ${name} = {${entries.map(([k, v]) => `\n  ${JSON.stringify(k)}: ${v},`).join('')}\n}`)
  }
  let n = 0
  const imp = (spec: string): string => {
    const local = `c${n++}`
    lines.push(`import ${local} from ${JSON.stringify(`@content/${spec}`)}`)
    return local
  }
  const levels = files.levels.map((p) => [p, imp(p)] as [string, string])
  const metas = files.assets.map((p) => [p, imp(`${p}${META_SUFFIX}?raw`)] as [string, string])
  // Materials and prefabs are read as JSON; every other kind is a file the renderer fetches by URL.
  const json = (p: string): boolean => p.endsWith('.mat.json') || p.endsWith('.prefab.json')
  const materials = files.assets.filter((p) => p.endsWith('.mat.json')).map((p) => [p, imp(p)] as [string, string])
  const prefabs = files.assets.filter((p) => p.endsWith('.prefab.json')).map((p) => [p, imp(p)] as [string, string])
  const urls = files.assets.filter((p) => !json(p)).map((p) => [p, imp(`${p}?url`)] as [string, string])
  table('LEVELS', levels)
  table('METAS', metas)
  table('MATERIALS', materials)
  table('PREFABS', prefabs)
  table('URLS', urls)
  return `${lines.join('\n')}\n`
}

interface DevServer {
  watcher: { add: (paths: string[]) => void; on: (event: 'add' | 'unlink', cb: (file: string) => void) => void }
  moduleGraph: { getModuleById: (id: string) => unknown; invalidateModule: (mod: never) => void }
  ws: { send: (payload: { type: 'full-reload' }) => void }
}

/**
 * The Vite plugin. `game` is the game this config builds, `null` for everything (tests). Served, a file added to or
 * removed from a library, or a level added or removed, rebuilds the module and reloads the page — as the globs this
 * replaced did — except where the config's `watch.ignored` says not to look (the box's level files, ADR 0089).
 */
export const gameContent = (game: string | null, root: string = contentRoot()) => {
  let command: 'serve' | 'build' = 'serve'
  return {
    name: 'game-content',
    configResolved(config: { command: 'serve' | 'build' }) {
      command = config.command
    },
    resolveId(id: string) {
      return id === GAME_CONTENT_ID ? RESOLVED : undefined
    },
    load(id: string) {
      if (id !== RESOLVED) return undefined
      return gameContentModule(gameContentFiles(root, game, command === 'build' ? 'used' : 'library'))
    },
    configureServer(server: DevServer) {
      const games = game === null ? gamesIn(root) : [game]
      const watched = [join(root, ASSETS_DIR), ...games.flatMap((g) => [join(root, g, ASSETS_DIR), join(root, g, LEVELS_DIR)])]
      server.watcher.add(watched)
      const inside = (file: string): boolean => watched.some((d) => resolve(file).startsWith(resolve(d) + sep))
      const refresh = (file: string): void => {
        if (!inside(file)) return
        const mod = server.moduleGraph.getModuleById(RESOLVED)
        if (mod !== undefined && mod !== null) server.moduleGraph.invalidateModule(mod as never)
        server.ws.send({ type: 'full-reload' })
      }
      server.watcher.on('add', refresh)
      server.watcher.on('unlink', refresh)
    },
  }
}

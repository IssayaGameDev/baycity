import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, join, relative, resolve, sep } from 'node:path'

import { CODE_ASSETS } from './packages/game-client/src/codeAssets'
import { contentTypeFor, kindForPath, META_SUFFIX, type AssetKind } from './packages/content/src/assets'
import { ASSETS_DIR, inLibrary, LEVELS_DIR, levelFile, levelRefForFile, libraryDir, mayUse } from './packages/content/src/layout'
import {
  levelIndexFile,
  levelIndexOf,
  levelNeeds,
  levelNeedsFile,
  levelOfNeedsFile,
  PLAY_CONTENT_DIR,
  type ContentCatalog,
  type LevelIndex,
  type LevelNeeds,
} from './packages/content/src/levelNeeds'
import { contentRoot } from './content-root'

/**
 * A game's content as its page reads it (ADR 0169): one level at a time, with only what that level uses.
 *
 * The page fetches `content/<game>/levels.json`, then `content/<game>/levels/<name>.needs.json`, then the files on
 * that list (`@mp/content` `levelNeeds.ts`). This plugin is what answers those addresses where Vite runs:
 *
 * - **Built** (`vite build`): it writes them into the build — every level, every file a level uses (hashed, so a
 *   browser keeps them), each level's list and the index. A build needs no server of ours to play.
 * - **Served locally**: it makes them from the files on disk, and a content write reloads the page, which reads its
 *   level again (ADR 0084's loop).
 * - **Served on the box** (`live`): it hands them to the editor server, which answers with what is being edited
 *   now (`/api/play`), so nothing reloads when someone edits a material.
 *
 * Nothing of `content/` is in the game's code any more: it used to be, every level and every asset of both
 * libraries, which every player downloaded and every asset edit on the box reloaded.
 *
 * Imported by relative path from each game's `vite.config.ts`, like `content-root.ts`; the tests read disk with it.
 */

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

/** A game's content on disk, read fresh on every call: the dev server's files change under it. */
export interface DiskContent {
  index: () => LevelIndex
  /** A level's JSON, `undefined` when it is not this game's or will not read. */
  level: (name: string) => unknown
  /** A level's list, each address made by `urlOf` from a path from `content/`. */
  needs: (name: string, urlOf: (path: string) => string) => LevelNeeds
  /** The assets the game may use — Shared's and its own library's, each with a sidecar — by id. */
  assets: () => ReadonlyMap<string, { kind: AssetKind; path: string }>
  /** Those assets, as `levelNeeds` asks for them. */
  catalog: () => ContentCatalog
}

export const diskContent = (root: string, game: string): DiskContent => {
  const levelNames = (): string[] =>
    filesUnder(join(root, game, LEVELS_DIR))
      .map((f) => levelRefForFile(posix(relative(root, f))))
      .filter((ref) => ref !== null && ref.game === game)
      .map((ref) => ref!.name)

  const assets = (): Map<string, { kind: AssetKind; path: string }> => {
    const byId = new Map<string, { kind: AssetKind; path: string }>()
    for (const library of [libraryDir(null), libraryDir(game)]) {
      for (const f of filesUnder(join(root, library))) {
        if (!f.endsWith(META_SUFFIX)) continue
        const path = posix(relative(root, f.slice(0, -META_SUFFIX.length)))
        const kind = kindForPath(path)
        if (kind === undefined || !existsSync(join(root, path))) continue
        const id = (readJson(f) as { id?: unknown } | undefined)?.id
        if (typeof id === 'string') byId.set(id, { kind, path })
      }
    }
    return byId
  }

  const catalog = (): ContentCatalog => {
    const byId = assets()
    const idByPath = new Map([...byId].map(([id, e]) => [e.path, id]))
    return {
      byId: (id) => byId.get(id),
      byPath: (path) => {
        const id = idByPath.get(path)
        return id === undefined ? undefined : { id }
      },
      contentsOf: (id) => {
        const path = byId.get(id)?.path
        return path !== undefined && path.endsWith('.json') ? readJson(join(root, path)) : undefined
      },
    }
  }

  const level = (name: string): unknown => (levelNames().includes(name) ? readJson(join(root, levelFile({ game, name }))) : undefined)

  return {
    index: () => levelIndexOf(levelNames()),
    level,
    needs: (name, urlOf) => levelNeeds({ game, name }, level(name), catalog(), CODE_ASSETS, urlOf),
    assets,
    catalog,
  }
}

/** A response to one content address, or `null` for nothing there. */
export interface ContentResponse {
  type: string
  body: string | Buffer
}

/**
 * What the local dev server answers for `rel`, an address under `content/`: the index, a level's list (addresses
 * under `content/` again), a level, or a file in a library the game may use. Nothing else under `content/`.
 */
export const diskResponse = (root: string, game: string, rel: string): ContentResponse | null => {
  const disk = diskContent(root, game)
  const json = (v: unknown): ContentResponse => ({ type: 'application/json', body: JSON.stringify(v) })
  if (rel === levelIndexFile(game)) return json(disk.index())
  const listed = levelOfNeedsFile(rel)
  if (listed !== null) {
    if (listed.game !== game || !disk.index().levels.includes(listed.name)) return null
    return json(disk.needs(listed.name, (path) => `${PLAY_CONTENT_DIR}/${path}`))
  }
  const level = levelRefForFile(rel)
  const file = level !== null ? (level.game === game ? join(root, rel) : null) : inLibrary(rel) && mayUse(game, rel) ? join(root, rel) : null
  if (file === null || !existsSync(file) || statSync(file).isDirectory()) return null
  return { type: contentTypeFor(file), body: readFileSync(file) }
}

/** What `configureServer` is handed, as far as this plugin uses it. */
interface DevServer {
  middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void }
  watcher: { add: (paths: string[]) => void; on: (event: 'add' | 'change' | 'unlink', cb: (file: string) => void) => void }
  ws: { send: (payload: { type: 'full-reload' }) => void }
}

/** What the build hooks are handed, as far as this plugin uses it. */
interface BuildContext {
  emitFile: (file: { type: 'asset'; name?: string; fileName?: string; source: string | Uint8Array }) => string
  getFileName: (ref: string) => string
  error: (message: string) => never
}

export interface GameContentOptions {
  /** Where `content/` is: the repo's, or the live mirror (`content-root.ts`, ADR 0084). */
  root?: string
  /** The editor server that answers the page's content live — the staging game on the box. Absent: from `root`. */
  live?: string
}

/** The Vite plugin for `game`'s page. */
export const gameContent = (game: string, opts: GameContentOptions = {}) => {
  const root = opts.root ?? contentRoot()
  let command: 'serve' | 'build' = 'serve'
  let base = '/'
  /** In a build: each file written, by its path from `content/`, as the reference `getFileName` resolves. */
  const written = new Map<string, string>()

  return {
    name: 'game-content',
    /**
     * On the box, the content addresses go to the editor server, whatever host the page was opened on. The host is
     * rewritten because the editor server redirects `dev.playgorbo.com` requests outside the game's path.
     */
    config(config: { base?: string }) {
      if (opts.live === undefined) return undefined
      const prefix = `${config.base ?? '/'}${PLAY_CONTENT_DIR}/`
      return { server: { proxy: { [prefix]: { target: opts.live, changeOrigin: true, rewrite: (p: string) => `/api/play/${p.slice(prefix.length)}` } } } }
    },
    configResolved(config: { command: 'serve' | 'build'; base: string }) {
      command = config.command
      base = config.base
    },
    configureServer(server: DevServer) {
      if (opts.live !== undefined) return
      const prefix = `${base}${PLAY_CONTENT_DIR}/`
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0] ?? ''
        if (!url.startsWith(prefix)) return next()
        const found = diskResponse(root, game, decodeURIComponent(url.slice(prefix.length)))
        res.statusCode = found === null ? 404 : 200
        res.setHeader('content-type', found?.type ?? 'text/plain')
        // Always asked again: a level edited a second ago must be what the next load plays.
        res.setHeader('cache-control', 'no-cache')
        res.end(found?.body ?? 'not found')
      })
      const watched = [join(root, ASSETS_DIR), join(root, game, ASSETS_DIR), join(root, game, LEVELS_DIR)]
      server.watcher.add(watched)
      const reload = (file: string): void => {
        if (watched.some((d) => resolve(file).startsWith(resolve(d) + sep))) server.ws.send({ type: 'full-reload' })
      }
      for (const event of ['add', 'change', 'unlink'] as const) server.watcher.on(event, reload)
    },
    /** Every level and every file some level uses, written under a hashed name. */
    buildStart(this: BuildContext) {
      if (command !== 'build') return
      written.clear()
      const disk = diskContent(root, game)
      const paths = new Set<string>()
      for (const name of disk.index().levels) {
        if (disk.level(name) === undefined) this.error(`${levelFile({ game, name })} will not parse`)
        paths.add(levelFile({ game, name }))
        for (const a of disk.needs(name, (p) => p).assets) paths.add(a.path)
      }
      for (const path of [...paths].sort()) written.set(path, this.emitFile({ type: 'asset', name: basename(path), source: readFileSync(join(root, path)) }))
    },
    /** Each level's list and the index, at the addresses the page asks for, pointing at the hashed files. */
    generateBundle(this: BuildContext) {
      if (command !== 'build') return
      const disk = diskContent(root, game)
      const urlOf = (path: string): string => {
        const ref = written.get(path)
        return ref === undefined ? `${PLAY_CONTENT_DIR}/${path}` : this.getFileName(ref)
      }
      const index = disk.index()
      this.emitFile({ type: 'asset', fileName: `${PLAY_CONTENT_DIR}/${levelIndexFile(game)}`, source: JSON.stringify(index) })
      for (const name of index.levels) {
        this.emitFile({ type: 'asset', fileName: `${PLAY_CONTENT_DIR}/${levelNeedsFile({ game, name })}`, source: JSON.stringify(disk.needs(name, urlOf)) })
      }
    },
  }
}

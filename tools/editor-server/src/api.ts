import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join, normalize, relative, sep } from 'node:path'

import { contentTypeFor, isDataAsset, kindForPath, META_SUFFIX } from '../../../packages/content/src/assets'

export { contentTypeFor }
import { gameFile, inLibrary, isGameName, levelFile, levelRefForFile, libraryOf, parseQualified, qualify, LEVELS_DIR } from '../../../packages/content/src/layout'
import { levelIndexFile, levelIndexOf, levelNeeds, levelOfNeedsFile, PLAY_CONTENT_DIR, type ContentCatalog } from '../../../packages/content/src/levelNeeds'
import type { NodeRef, Op } from '../../../packages/content/src/ops'
import { prefabRefsIn } from '../../../packages/content/src/prefabs'
import type { Level } from '../../../packages/content/src/types'
import { LevelError, validateLevel } from '../../../packages/content/src/validate'
import { createAssetIndex, type AssetIndex } from './assetIndex'
import { libraryFolders } from './assetImporter'
import type { LiveAssets } from './liveAssets'
import { gameDocId, isAssetOp, isLiveAssetPath } from '../../../packages/content/src/liveAssets'
import { AssetOpError, listFolders, makeFolder, movePath, removePath } from './assetOps'
import { componentTypesIn, levelMoveRefusal, libraryName, moveRefusal } from './libraryMoves'
import { usersOf } from '../../../packages/content/src/usage'
import type { ChangeFeed } from './changes'
import type { User } from './config'
import { docKey, LiveError, type FieldSpot, type Live } from './live'
import { encodeSse, SSE_HEADERS, SSE_KEEPALIVE } from './sse'

/**
 * The content API — one implementation behind both the dev editor (a Vite middleware, `auth: none`) and the
 * hosted editor (a Node server behind Cloudflare Access), so what the editor can do to `content/` is defined
 * once (ADR 0083).
 *
 *   GET  /api/me                      → { user, heartbeatMs, maxUploadBytes, games, admin? } — admin: true for an admin (ADR 0200)
 *   GET  /api/status                  → { pushError }
 *   GET  /api/levels                  → [{ name, mode?, prefabs?, components? }] — prefabs: asset ids it references (ADR 0097);
 *                                       components: every type it and its prefabs use (ADR 0162)
 *   GET/PUT /api/levels/:name         → the JSON (PUT validated structurally)
 *   POST /api/levels/move             → { from, to } — rename, both qualified (ADR 0110); into another game it keeps the
 *                                       tag in step, and is 409 while it uses its old game's own assets (ADR 0162)
 *   POST /api/levels/delete           → { path } — qualified; the file goes for good (ADR 0110)
 *                                       A level made, renamed or deleted tells every editor: a `levels` event (ADR 0162)
 *   GET/PUT /api/games/:name          → { components, settings? } (ADR 0077, 0087). GET says what it served
 *                                       (`x-asset-epoch`, `x-asset-seq`) and serves the live copy; PUT is 409 while
 *                                       the file is open live (ADR 0162)
 *   GET  /api/assets                  → { entries, libraries, folders, seq, files } (runs the importer; seq: the change feed's
 *                                       position; files: each entry's { bytes, modified } by path, ADR 0165)
 *   GET  /api/assets/users?id=        → { levels, assets } — who uses it, directly or through others (ADR 0165)
 *   POST /api/assets/mkdir|move|delete → { path } · { from, to } or { moves: [{ from, to }] } · { path } or { paths } — a move
 *                                       into another library is 409 while something would be left using what it may not
 *                                       (ADR 0161); several are checked together and done all or none (ADR 0166)
 *   POST /api/assets/upload?path=     → raw bytes → { entry }   (textures and .glb, capped, replace keeps the id)
 *   GET  /content/<path>              → the bytes
 *   PUT  /content/<path>              → a JSON asset
 *   GET  /api/play/<address>          → a game page's content (ADR 0169): `<game>/levels.json` (the index),
 *                                       `<game>/levels/<name>.needs.json` (a level's list), the level, a library
 *                                       file — each as it is now. Anyone Access let in, not only the editor's users
 *
 * An asset path is relative to `content/` and inside a library (ADR 0161): `assets/…`, or `<game>/assets/…` for a
 * game that exists. Nothing else under `content/` is reachable through these routes.
 *   POST /api/admin/commit-all        → Bearer token, not a user: deploy flushes every session
 *
 * Live level editing (ADR 0089), when `live` is given:
 *   GET  /api/live                    → open documents, peers, holds
 *   GET  /api/live/:kind/:name/events → SSE: hello, snapshot, ops (id = seq), holds, peers, presence, open-assets, fields, error
 *                                       plus `prefab` on a level's stream: a prefab the level uses was edited
 *                                       :kind is `level` or `prefab` — a prefab is its own document (ADR 0091)
 *   POST /api/live/:kind/:name/ops          → { connId, batchId, ops } → { ok, seq } · 400 bad op
 *   POST /api/live/asset/:id/ops · /api/live/game/:game/ops → { connId, batchId, ops } — a material, a game's data
 *                                       file (ADR 0159, 0162): echoed to every stream as an `asset` event
 *   POST /api/live/:kind/:name/hold         → { connId, refs } — what I have selected is exactly these → { ok }; shown, never refused (ADR 0158)
 *   POST /api/live/:kind/:name/release      → { connId, refs } → { ok }
 *   POST /api/live/:kind/:name/ping         → { connId } — still here (the editor, every heartbeat)
 *   POST /api/live/:kind/:name/presence     → { connId, data } — relayed, unnumbered
 *   POST /api/live/:kind/:name/assets       → { connId, assetIds } — what I have open in the asset Inspector is exactly these → { ok }; to everyone (ADR 0159)
 *   POST /api/live/:kind/:name/field        → { connId, spot: { targets, card, field } | null } — the Inspector field I am in → { ok }; to everyone (ADR 0160)
 *   POST /api/live/:kind/:name/flush        → write the file now
 *   POST /api/live/:kind/:name/leave        → { connId } (a closing tab's beacon)
 *   PUT  /api/levels/:name            → 409 while the level is open live; GET serves the live copy
 *
 * For the live mirror (ADR 0084):
 *   GET  /api/tree                    → { seq, files: [{ path, size, sha1 }] } — every file under content/
 *   GET  /api/changes?since=N&timeout=MS → { seq, paths } — long-poll; 410 when N is older than the feed remembers.
 *                                       Every editor tab follows it too, for other people's asset changes (ADR 0156)
 *   GET  /api/file?path=content/...   → the bytes of any content file (404 when gone)
 *
 * Every write reports the repo-relative paths it touched to `onChanged` and the change feed — always **file** paths,
 * so a folder move or delete is reported as the files it moved or removed.
 */
export interface ApiOptions {
  repoRoot: string
  /** The editor's assistant (ADR 0192), its `/api/assistant` routes, for a signed-in user. Absent: none. */
  assistant?: { handle: (req: IncomingMessage, res: ServerResponse, url: string, user: User) => Promise<boolean> }
  /** Whether this user is an admin (ADR 0200): `/api/me` says so, for the editor's link to the admin page. Absent: nobody. */
  isAdmin?: (user: User) => boolean
  /** `null` → 401. Throwing → 500. */
  identify: (req: IncomingMessage) => Promise<User | null>
  /**
   * Whether this request may read a game page's content (`/api/play`, ADR 0169): anyone the login let in, where
   * `identify` wants a name in the editor's list. Absent: `identify` decides.
   */
  identifyPlayer?: (req: IncomingMessage) => Promise<boolean>
  /** `heartbeatMs`: how often an editor pings its live connection; `maxUploadBytes`: the upload cap. */
  rules: { heartbeatMs: number; maxUploadBytes: number }
  /** Repo-relative posix paths a user just changed on disk. */
  onChanged?: (user: User, paths: string[]) => void
  status?: () => { pushError: string | null }
  admin?: { token: string; commitAll: () => Promise<void> }
  /** The live mirror's feed; every changed path is recorded here too. */
  changes?: ChangeFeed
  /** Game name → URL the editor's Play opens in a frame (ADR 0086). Relative to this server or absolute. */
  games?: Record<string, string>
  /** Live level documents (ADR 0089). Absent: levels are files, as before. */
  live?: Live
  /** The asset list in memory, shared with the prefab store so both see every write (ADR 0156). Made here when absent. */
  assets?: AssetIndex
  /** Data-file assets edited live (ADR 0159). Absent: they are plain files. */
  liveAssets?: LiveAssets
  /** SSE keepalive period; short in tests. */
  keepaliveMs?: number
}

/** Handles the request and resolves `true`, or resolves `false` having touched nothing. */
export type ApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>

/** `identify` throws one of these to answer with a status and a reason (403 not in the list, 503 not configured). */
export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * `/api/levels`, `/api/levels/<game>/<name>`, `/api/games`, `/api/games/<game>`.
 *
 * A level takes **two** segments because a game is a folder and two games may both own a `default`
 * (ADR 0108). The trailing group is the whole rest of the path, checked by `parseQualified` rather than by
 * this regex, so the one definition of a legal name lives in `@mp/content`.
 */
const ROUTE_RE = /^\/api\/(levels|games)(?:\/(.+))?$/
/** Where a game page's content is answered (ADR 0169). */
const PLAY_PREFIX = '/api/play/'
const MAX_JSON_BYTES = 32 * 1024 * 1024
/**
 * What upload accepts: what the runtime loads. `.gltf` is refused — it drags `.bin` and textures along. Fonts are what
 * a Text can draw with (ADR 0190): TrueType, OpenType and WOFF, not WOFF2, which the text library cannot read.
 */
export const UPLOAD_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'webp', 'ktx2', 'glb', 'ttf', 'otf', 'woff'])

/** Resolve `rel` inside `root`, or `null` if it escapes it. */
export const safeJoin = (root: string, rel: string): string | null => {
  const full = normalize(join(root, rel))
  return full === root || full.startsWith(root + sep) ? full : null
}

export const sendJson = (res: ServerResponse, code: number, body: unknown): void => {
  res.statusCode = code
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

class TooLarge extends Error {}

const readBody = (req: IncomingMessage, limit: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? '0')
    if (declared > limit) {
      reject(new TooLarge(`body is ${declared} bytes; the cap is ${limit}`))
      req.resume()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new TooLarge(`body exceeds the ${limit} byte cap`))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

const readJson = async (req: IncomingMessage): Promise<unknown> => JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8'))

const asRecord = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})

/** A field spot off the wire (ADR 0160): `null` is out of every field, `undefined` not a spot at all. */
const parseFieldSpot = (v: unknown): FieldSpot | null | undefined => {
  if (v === null) return null
  const o = asRecord(v)
  if (!Array.isArray(o.targets) || !o.targets.every((t) => typeof t === 'string')) return undefined
  if (typeof o.card !== 'string' || typeof o.field !== 'string') return undefined
  return { targets: o.targets as string[], card: o.card, field: o.field }
}
const strField = (o: Record<string, unknown>, name: string): string => {
  const v = o[name]
  if (typeof v !== 'string') throw new AssetOpError(`${name}: expected a string`)
  return v
}

/** Repo-relative key for a file the API knows: what the change feed and the commits name. */
export const keyFor = {
  /** `name` is the qualified `<game>/<name>` (ADR 0108). */
  level: (name: string): string => {
    const ref = parseQualified(name)
    return ref === null ? `content/${name}` : `content/${levelFile(ref)}`
  },
  game: (name: string): string => `content/${gameFile(name)}`,
  /** `path` is content-relative and starts with its library (ADR 0161). */
  asset: (path: string): string => `content/${path}`,
}

/** Every file under `dir`, as forward-slashed paths relative to `dir`. */
const filesUnder = (dir: string): string[] => {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      if (statSync(full).isDirectory()) walk(full)
      else out.push(relative(dir, full).split('\\').join('/'))
    }
  }
  walk(dir)
  return out.sort()
}

export const createContentApi = (opts: ApiOptions): ApiHandler => {
  const CONTENT = join(opts.repoRoot, 'content')
  if (!existsSync(CONTENT)) mkdirSync(CONTENT, { recursive: true })
  const assets = opts.assets ?? createAssetIndex(CONTENT)

  /** The game folders: a directory at the content root holding a `game.json` (ADR 0108). */
  const gameNames = (): string[] =>
    !existsSync(CONTENT)
      ? []
      : readdirSync(CONTENT)
          .filter((n) => isGameName(n) && statSync(join(CONTENT, n)).isDirectory() && existsSync(join(CONTENT, gameFile(n))))
          .sort()

  /** Every level file, as `{ ref, file }` with `file` absolute. */
  const levelFiles = (): { ref: { game: string; name: string }; file: string }[] => {
    const out: { ref: { game: string; name: string }; file: string }[] = []
    for (const game of gameNames()) {
      const dir = join(CONTENT, game, LEVELS_DIR)
      if (!existsSync(dir)) continue
      for (const f of readdirSync(dir).sort()) {
        const ref = levelRefForFile(`${game}/${LEVELS_DIR}/${f}`)
        if (ref !== null) out.push({ ref, file: join(dir, f) })
      }
    }
    return out
  }

  /**
   * A path the asset routes may touch (ADR 0161): inside a library — the shared one, or the own one of a game that
   * exists — and never a level, a `game.json`, or a library's own folder.
   */
  const assetPathOk = (path: string): boolean => {
    if (!inLibrary(path) || safeJoin(CONTENT, path) === null) return false
    const game = libraryOf(path)
    return game === null || (game !== undefined && existsSync(join(CONTENT, gameFile(game))))
  }
  /** A level's JSON as it is now: an open document is ahead of its file. `undefined` when it will not read. */
  const levelNow = (name: string, file: string): unknown => {
    try {
      return opts.live?.levelOf(name) ?? (JSON.parse(readFileSync(file, 'utf8')) as unknown)
    } catch {
      return undefined
    }
  }
  /** A prefab's, material's, shader's or data asset's JSON as it is now — a live copy when open — else `undefined`. */
  const assetJsonNow = (id: string): unknown => {
    const e = assets.byId(id)
    if (e === undefined || !(e.kind === 'prefab' || e.kind === 'material' || e.kind === 'shader' || e.kind === 'data')) return undefined
    if (e.kind === 'prefab') {
      const doc = opts.live?.levelOf(docKey('prefab', id))
      if (doc !== null && doc !== undefined) return doc.nodes[0]
    }
    const current = opts.liveAssets?.current(id)
    if (current !== null && current !== undefined) return current.json
    const file = safeJoin(CONTENT, e.path)
    try {
      return file === null ? undefined : (JSON.parse(readFileSync(file, 'utf8')) as unknown)
    } catch {
      return undefined
    }
  }
  /** The prefab document open on asset path `rel` (its file `file`), if any: a prefab is a live document now (ADR 0091). */
  const openPrefabAt = (rel: string, file: string): { id: string; root: unknown } | null => {
    if (opts.live === undefined || !rel.endsWith('.prefab.json')) return null
    // The index, not a walk per request: an editor loading the library asks for every prefab in turn. A file
    // the index has not seen yet (copied in from outside) gets one refresh.
    let entry = assets.byPath(rel)
    if (entry === undefined && existsSync(file)) {
      assets.refresh()
      entry = assets.byPath(rel)
    }
    if (entry === undefined || entry.kind !== 'prefab') return null
    const doc = opts.live.levelOf(docKey('prefab', entry.id))
    return doc === null ? null : { id: entry.id, root: doc.nodes[0] }
  }

  /**
   * A data-file asset edited live (ADR 0159): its id, and its live copy when open. Every such GET says what it
   * served (`x-asset-epoch`, `x-asset-seq`, `0` for the file) so an editor knows which edits it already has.
   */
  const liveAssetAt = (rel: string): { id: string; current: ReturnType<LiveAssets['current']> } | null => {
    if (opts.liveAssets === undefined || !isLiveAssetPath(rel)) return null
    const entry = assets.byPath(rel)
    return entry === undefined ? null : { id: entry.id, current: opts.liveAssets.current(entry.id) }
  }

  /** Asset `rel` as it is now, its file `file`: the live copy wins, as it does for a level — up to five seconds ahead of the file. */
  const sendAssetNow = (res: ServerResponse, rel: string, file: string): void => {
    const live = openPrefabAt(rel, file)
    if (live !== null) return sendJson(res, 200, live.root)
    const asset = liveAssetAt(rel)
    if (asset !== null && opts.liveAssets !== undefined) {
      res.setHeader('x-asset-epoch', String(asset.current?.epoch ?? opts.liveAssets.epoch))
      res.setHeader('x-asset-seq', String(asset.current?.seq ?? 0))
      if (asset.current !== null) return sendJson(res, 200, asset.current.json)
    }
    if (!existsSync(file) || statSync(file).isDirectory()) return sendJson(res, 404, { error: 'not found' })
    res.statusCode = 200
    res.setHeader('content-type', contentTypeFor(file))
    res.end(readFileSync(file))
  }

  /**
   * Why moving `from` into `to`'s library is refused, or `null` (ADR 0161): the whole of a folder counts, and what
   * uses or is used by it, in every game's levels and every library, as they are now.
   */
  const crossLibraryRefusal = (froms: readonly string[], to: string): string | null => {
    const moving = assets.entries().filter((e) => froms.some((from) => e.path === from || e.path.startsWith(`${from}/`)))
    const levels = levelFiles().map(({ ref, file }) => [qualify(ref), levelNow(qualify(ref), file)] as const)
    return moveRefusal(moving, libraryOf(to) ?? null, { entries: assets.entries(), levels, contentsOf: assetJsonNow })
  }

  /** Every folder in every library, content-relative, the empty ones included. */
  const assetFolders = (): string[] => libraryFolders(CONTENT).flatMap((l) => listFolders(join(CONTENT, l)).map((f) => `${l}/${f}`))

  const changed = (user: User, paths: string[]): void => {
    opts.onChanged?.(user, paths)
    opts.changes?.record(paths)
  }
  /** The list of levels changed — made, renamed, deleted: every editor in any room reads it again (ADR 0162). */
  const levelsChanged = (): void => opts.live?.broadcastAll('levels', {})

  /** A file's own path plus its sidecar; a folder's every file. For reporting what a move or delete touched. */
  const filesOf = (path: string): string[] => {
    const full = safeJoin(CONTENT, path)
    if (full !== null && existsSync(full) && statSync(full).isDirectory()) return filesUnder(full).map((f) => `${path}/${f}`)
    return [path, `${path}${META_SUFFIX}`]
  }

  /** Rescan so a new file has its sidecar now, attributed to the user who made it. */
  const rescanFor = (user: User): void => {
    const created = assets.rescan()
    if (created.length > 0) changed(user, created.map((p) => keyFor.asset(p)))
  }

  const handleAssets = async (req: IncomingMessage, res: ServerResponse, url: string, query: URLSearchParams, user: User): Promise<boolean> => {
    if (url === '/api/assets' && req.method === 'GET') {
      // Sidecars the importer wrote for files that arrived outside the API (copied into the folder) belong to
      // whoever looked first — better than untracked files nobody commits.
      rescanFor(user)
      // `seq`: where the change feed stood when this list was read, in the same tick, so an editor watching the
      // feed from here misses nothing and replays nothing (ADR 0156).
      // Each file's size and when it last changed (ADR 0165): the Inspector's facts, the Project window's date order.
      const files: Record<string, { bytes: number; modified: number }> = {}
      for (const e of assets.entries()) {
        const file = safeJoin(CONTENT, e.path)
        if (file === null || !existsSync(file)) continue
        const st = statSync(file)
        files[e.path] = { bytes: st.size, modified: Math.round(st.mtimeMs) }
      }
      sendJson(res, 200, { entries: assets.entries(), libraries: libraryFolders(CONTENT), folders: assetFolders(), seq: opts.changes?.seq() ?? 0, files })
      return true
    }

    if (url === '/api/assets/users' && req.method === 'GET') {
      // Every level and every asset as it is now — an open document ahead of its file — so a placement made a
      // moment ago counts.
      const id = query.get('id') ?? ''
      if (assets.byId(id) === undefined) return sendJson(res, 404, { error: `no asset ${id}` }), true
      const levels = levelFiles().map(({ ref, file }) => {
        const name = qualify(ref)
        return [name, levelNow(name, file)] as const
      })
      const others = assets.entries().map((e) => [e.id, assetJsonNow(e.id)] as const)
      sendJson(res, 200, usersOf(id, levels, others, (s) => assets.byId(s) !== undefined, assetJsonNow))
      return true
    }

    if (url === '/api/assets/upload') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST expected' }), true
      const rel = (query.get('path') ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
      const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()
      if (!assetPathOk(rel)) return sendJson(res, 400, { error: 'not a path in an asset library' }), true
      if (!UPLOAD_EXTENSIONS.has(ext) || kindForPath(rel) === undefined) return sendJson(res, 400, { error: `.${ext} is not an uploadable asset (${[...UPLOAD_EXTENSIONS].join(', ')})` }), true
      let bytes: Buffer
      try {
        bytes = await readBody(req, opts.rules.maxUploadBytes)
      } catch (e) {
        sendJson(res, e instanceof TooLarge ? 413 : 400, { error: String(e instanceof Error ? e.message : e) })
        return true
      }
      const file = safeJoin(CONTENT, rel)!
      mkdirSync(join(file, '..'), { recursive: true })
      // Same name, same folder: replaced, and the sidecar beside it is untouched, so the id — and every
      // reference — survives. That is how art gets updated.
      writeFileSync(file, bytes)
      changed(user, [keyFor.asset(rel)])
      assets.rescan()
      const meta = `${rel}${META_SUFFIX}`
      if (!existsSync(`${file}${META_SUFFIX}`)) sendJson(res, 500, { error: 'importer wrote no sidecar' })
      else {
        changed(user, [keyFor.asset(meta)])
        sendJson(res, 200, { entry: assets.byPath(rel) ?? null })
      }
      return true
    }

    const op = /^\/api\/assets\/(mkdir|move|delete)$/.exec(url)
    if (op !== null) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST expected' }), true
      try {
        const args = asRecord(await readJson(req))
        /** Both ends of every op are in a library: these routes delete things, and `content/` holds the levels. */
        const libraryPath = (name: string): string => {
          const path = strField(args, name)
          if (!assetPathOk(path)) throw new AssetOpError(`${name}: not a path in an asset library: ${path}`)
          return path
        }
        if (op[1] === 'mkdir') {
          const path = libraryPath('path')
          makeFolder(CONTENT, path)
          // An empty folder is nothing to git; it is committed with its first file.
        } else if (op[1] === 'move') {
          // One, or several at once (ADR 0166): every one is checked before any moves, so it is all or none.
          const moves = Array.isArray(args.moves)
            ? (args.moves as unknown[]).map((m, i) => {
                const one = asRecord(m)
                const at = (name: string): string => {
                  const path = strField(one, name)
                  if (!assetPathOk(path)) throw new AssetOpError(`moves[${i}].${name}: not a path in an asset library: ${path}`)
                  return path
                }
                return { from: at('from'), to: at('to') }
              })
            : [{ from: libraryPath('from'), to: libraryPath('to') }]
          if (moves.length === 0) throw new AssetOpError('moves: nothing to move')
          const targets = new Set<string>()
          for (const { from, to } of moves) {
            if (!existsSync(safeJoin(CONTENT, from)!)) throw new AssetOpError(`not found: ${from}`)
            if (existsSync(safeJoin(CONTENT, to)!) || targets.has(to)) throw new AssetOpError(`already exists: ${to}`)
            if (to === from || to.startsWith(`${from}/`)) throw new AssetOpError(`a folder cannot move inside itself: ${from}`)
            targets.add(to)
          }
          // Into another library only when nothing is left using what it may not (ADR 0161) — those going together
          // judged together, so a prefab and the material it uses may cross as one.
          const crossing = new Map<string | null, { froms: string[]; to: string }>()
          for (const { from, to } of moves) {
            if (libraryOf(from) === libraryOf(to)) continue
            const lib = libraryOf(to) ?? null
            crossing.set(lib, { froms: [...(crossing.get(lib)?.froms ?? []), from], to })
          }
          for (const [lib, { froms, to }] of crossing) {
            const why = crossLibraryRefusal(froms, to)
            if (why !== null) return sendJson(res, 409, { error: `not moved into ${libraryName(lib)}: ${why}` }), true
          }
          const touched: string[] = []
          for (const { from, to } of moves) {
            const before = filesOf(from)
            movePath(CONTENT, from, to)
            touched.push(...before, ...before.map((p) => `${to}${p.slice(from.length)}`))
          }
          rescanFor(user)
          changed(user, touched.map(keyFor.asset))
        } else {
          const paths = Array.isArray(args.paths)
            ? (args.paths as unknown[]).map((p, i) => {
                if (typeof p !== 'string' || !assetPathOk(p)) throw new AssetOpError(`paths[${i}]: not a path in an asset library`)
                return p
              })
            : [libraryPath('path')]
          if (paths.length === 0) throw new AssetOpError('paths: nothing to delete')
          // Several at once are refused together (ADR 0166): nothing goes while anyone holds any of them.
          const gone: string[] = []
          for (const path of paths) {
            if (!existsSync(safeJoin(CONTENT, path)!)) continue // inside a folder already deleted with it
            gone.push(...filesOf(path))
            // A live asset deleted goes with its document, unwritten edits and all (ADR 0159).
            for (const e of assets.entries()) if (e.path === path || e.path.startsWith(`${path}/`)) opts.liveAssets?.forget(e.id)
            removePath(CONTENT, path)
          }
          rescanFor(user)
          changed(user, gone.map(keyFor.asset))
        }
        sendJson(res, 200, { ok: true })
      } catch (e) {
        sendJson(res, e instanceof AssetOpError || e instanceof SyntaxError ? 400 : 500, { error: String(e instanceof Error ? e.message : e) })
      }
      return true
    }

    if (!url.startsWith('/content/')) return false
    const rel = url.slice('/content/'.length)
    const file = assetPathOk(rel) ? safeJoin(CONTENT, rel) : null
    if (file === null) return sendJson(res, 404, { error: 'not a path in an asset library' }), true

    if (req.method === 'GET') {
      sendAssetNow(res, rel, file)
      return true
    }
    if (req.method === 'PUT') {
      // Refused while it is open, as a level's PUT is: the document would write its own copy back over this.
      const live = openPrefabAt(rel, file)
      if (live !== null) return sendJson(res, 409, { error: `that prefab is open live; edit it in the editor` }), true
      const asset = liveAssetAt(rel)
      if (asset !== null && asset.current !== null) return sendJson(res, 409, { error: 'that asset is being edited live; edit it in the editor' }), true
      // A data asset belongs to the game that declares its type (ADR 0181): Shared has no code to read one.
      const data = kindForPath(rel) === 'data'
      if (data && libraryOf(rel) === null) return sendJson(res, 409, { error: 'a data asset belongs to a game: make it in that game’s library, not in Shared' }), true
      try {
        // JSON only: materials, prefabs, data assets. Binaries go through upload, which has the cap.
        const parsed: unknown = await readJson(req)
        if (data && !isDataAsset(parsed)) return sendJson(res, 400, { error: 'a data asset names its type and holds its fields as an object' }), true
        mkdirSync(join(file, '..'), { recursive: true })
        writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`)
        changed(user, [keyFor.asset(rel)])
        rescanFor(user)
        sendJson(res, 200, { ok: true })
      } catch (e) {
        sendJson(res, 400, { error: String(e instanceof Error ? e.message : e) })
      }
      return true
    }
    return false
  }

  /** The assets a game page's list is made from, as they are now (ADR 0169). */
  const playCatalog: ContentCatalog = {
    byId: (id) => {
      const e = assets.byId(id)
      return e === undefined ? undefined : { kind: e.kind, path: e.path }
    },
    contentsOf: assetJsonNow,
  }

  /**
   * A game page's content (ADR 0169), at the addresses `levelNeeds.ts` names, relative to `/api/play/`: a game's level
   * index, a level's list, the level, and a file in a library — each as it is now, an open document ahead of its
   * file, so a page loaded a second after an edit plays it. The staging game's dev server hands its page's content
   * requests here. Read-only, and never cached: the next load must see the next edit.
   */
  const handlePlay = (req: IncomingMessage, res: ServerResponse, url: string): boolean => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET expected' }), true
    res.setHeader('cache-control', 'no-cache')
    const rel = url.slice(PLAY_PREFIX.length)
    const levelOf = (ref: { game: string; name: string }): { file: string } | undefined =>
      levelFiles().find((f) => f.ref.game === ref.game && f.ref.name === ref.name)
    const game = rel.split('/')[0] ?? ''
    if (isGameName(game) && rel === levelIndexFile(game)) {
      if (!gameNames().includes(game)) return sendJson(res, 404, { error: `no game ${game}` }), true
      return sendJson(res, 200, levelIndexOf(levelFiles().filter((f) => f.ref.game === game).map((f) => f.ref.name))), true
    }
    const listed = levelOfNeedsFile(rel)
    if (listed !== null) {
      const found = levelOf(listed)
      if (found === undefined) return sendJson(res, 404, { error: `no level ${qualify(listed)}` }), true
      const level = levelNow(qualify(listed), found.file)
      return sendJson(res, 200, levelNeeds(listed, level, playCatalog, (path) => `${PLAY_CONTENT_DIR}/${path}`)), true
    }
    const ref = levelRefForFile(rel)
    if (ref !== null) {
      const found = levelOf(ref)
      const level = found === undefined ? undefined : levelNow(qualify(ref), found.file)
      return level === undefined ? sendJson(res, 404, { error: `no level ${qualify(ref)}` }) : sendJson(res, 200, level), true
    }
    const file = assetPathOk(rel) ? safeJoin(CONTENT, rel) : null
    if (file === null) return sendJson(res, 404, { error: 'not a game page’s content' }), true
    sendAssetNow(res, rel, file)
    return true
  }

  /**
   * Renaming and deleting a level (ADR 0110), shaped like `/api/assets/move|delete` because it is the same
   * job. Checked **before** `handleFiles`, whose `(.+)` would otherwise read `move` as a level name.
   *
   * Both refuse while the level is open live: the open document holds its own copy and the next flush would
   * write it straight back to the old path, so a rename would silently duplicate it and a delete would undo
   * itself. That is the same reason `PUT` answers 409, and it is a 409 here for the same reason.
   */
  const handleLevelOps = async (req: IncomingMessage, res: ServerResponse, url: string, user: User): Promise<boolean> => {
    const op = url === '/api/levels/move' ? 'move' : url === '/api/levels/delete' ? 'delete' : null
    if (op === null) return false
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST expected' }), true
    try {
      const args = asRecord(await readJson(req))
      const openLive = (qual: string): boolean => opts.live?.isOpen(qual) === true
      const fileOf = (ref: { game: string; name: string }): string => join(CONTENT, levelFile(ref))

      if (op === 'move') {
        const from = parseQualified(strField(args, 'from'))
        const to = parseQualified(strField(args, 'to'))
        if (from === null || to === null) throw new AssetOpError('from and to must both be <game>/<name>')
        if (qualify(from) === qualify(to)) throw new AssetOpError('from and to are the same level')
        for (const q of [qualify(from), qualify(to)]) {
          if (openLive(q)) return sendJson(res, 409, { error: `${q} is open live; close it in the editor first` }), true
        }
        const src = fileOf(from)
        const dst = fileOf(to)
        if (!existsSync(src)) return sendJson(res, 404, { error: `no level ${qualify(from)}` }), true
        if (existsSync(dst)) throw new AssetOpError(`${qualify(to)} already exists`)
        // The `id` inside follows the file name, as every writer of a level keeps it (see `live.ts`).
        const level = JSON.parse(readFileSync(src, 'utf8')) as Record<string, unknown>
        level['id'] = to.name
        if (from.game !== to.game) {
          // Into another game (ADR 0162): not while it uses its old game's own assets, which the new one's may not.
          const why = levelMoveRefusal(level, from.game, { entries: assets.entries(), contentsOf: assetJsonNow })
          if (why !== null) return sendJson(res, 409, { error: `${qualify(from)} not moved to ${to.game}: ${why}` }), true
          // The folder is the game, and the tag inside says the same (ADR 0108): a level read over HTTP has no folder.
          const config = typeof level['config'] === 'object' && level['config'] !== null ? (level['config'] as Record<string, unknown>) : {}
          level['config'] = { ...config, mode: { name: to.game } }
        }
        mkdirSync(dirname(dst), { recursive: true })
        writeFileSync(dst, `${JSON.stringify(level, null, 2)}\n`)
        rmSync(src)
        changed(user, [keyFor.level(qualify(from)), keyFor.level(qualify(to))])
        levelsChanged()
        sendJson(res, 200, { ok: true })
        return true
      }

      const ref = parseQualified(strField(args, 'path'))
      if (ref === null) throw new AssetOpError('path must be <game>/<name>')
      const qual = qualify(ref)
      if (openLive(qual)) return sendJson(res, 409, { error: `${qual} is open live; close it in the editor first` }), true
      const file = fileOf(ref)
      if (!existsSync(file)) return sendJson(res, 404, { error: `no level ${qual}` }), true
      rmSync(file)
      changed(user, [keyFor.level(qual)])
      levelsChanged()
      sendJson(res, 200, { ok: true })
      return true
    } catch (e) {
      sendJson(res, 400, { error: String(e instanceof Error ? e.message : e) })
      return true
    }
  }

  const handleFiles = async (req: IncomingMessage, res: ServerResponse, url: string, user: User): Promise<boolean> => {
    const m = ROUTE_RE.exec(url)
    if (m === null) return false
    const kind = m[1] as 'levels' | 'games'
    const rest = m[2]
    if (rest === undefined) {
      if (req.method !== 'GET') return false
      if (kind === 'games') return sendJson(res, 200, gameNames().map((name) => ({ name }))), true
      // Qualified name, the game it is in, and which prefabs it references (ADR 0097). A file that will not
      // parse is listed without the prefabs rather than omitted — you have to be able to see a broken level
      // in order to fix it. `mode` now comes from the **folder** (ADR 0108), which is the game by
      // construction, so a listing no longer depends on a tag inside a file that may not parse.
      //
      // The prefab ids ride along in the pass this already makes over every level file, which is what makes
      // "N levels use this" affordable enough to put in front of a delete.
      const entries = levelFiles().map(({ ref, file }) => {
        const name = qualify(ref)
        try {
          // An open document is ahead of its file, and a placement made in the last few seconds counts.
          const parsed = levelNow(name, file) as Level | undefined
          if (parsed === undefined) return { name, mode: ref.game }
          const prefabs = prefabRefsIn(parsed)
          const components = componentTypesIn([parsed, ...prefabs.map(assetJsonNow)])
          return { name, mode: ref.game, ...(prefabs.length > 0 ? { prefabs } : {}), components }
        } catch {
          return { name, mode: ref.game }
        }
      })
      sendJson(res, 200, entries)
      return true
    }
    // A level is `<game>/<name>`; a game is one segment. Anything else is a 404 rather than a path that
    // resolves to somewhere unintended.
    const ref = kind === 'levels' ? parseQualified(rest) : null
    if (kind === 'levels' && ref === null) return sendJson(res, 404, { error: `${rest} is not a level name: <game>/<name>` }), true
    if (kind === 'games' && !isGameName(rest)) return sendJson(res, 404, { error: `${rest} is not a game name` }), true
    const name = ref === null ? rest : qualify(ref)
    const file = join(CONTENT, ref === null ? gameFile(rest) : levelFile(ref))
    // A game's data file is a live document (ADR 0162): its copy, when open, is ahead of the file.
    const liveGame = kind === 'games' && opts.liveAssets !== undefined ? opts.liveAssets.current(gameDocId(name)) : null
    if (req.method === 'GET') {
      // An open live document is newer than its file until the next flush; serve it.
      const open = kind === 'levels' ? opts.live?.levelOf(name) : null
      if (open !== null && open !== undefined) return sendJson(res, 200, open), true
      if (kind === 'games' && opts.liveAssets !== undefined) {
        // What it served, so the editor knows which edits it already has — `0` for the file.
        res.setHeader('x-asset-epoch', String(liveGame?.epoch ?? opts.liveAssets.epoch))
        res.setHeader('x-asset-seq', String(liveGame?.seq ?? 0))
        if (liveGame !== null) return sendJson(res, 200, liveGame.json), true
      }
      if (!existsSync(file)) return sendJson(res, 404, { error: 'not found' }), true
      sendJson(res, 200, JSON.parse(readFileSync(file, 'utf8')))
      return true
    }
    if (req.method === 'PUT') {
      const key = kind === 'levels' ? keyFor.level(name) : keyFor.game(name)
      if (kind === 'levels' && opts.live?.isOpen(name) === true) return sendJson(res, 409, { error: `${name} is open live; edit it in the editor` }), true
      if (liveGame !== null) return sendJson(res, 409, { error: `${name}'s game file is open live; edit it in the editor` }), true
      try {
        const parsed: unknown = await readJson(req)
        // Structure is checked here so a broken level never reaches disk or git; parameters need the game's
        // registry, which the editor has and this server does not, so the editor checks those before sending.
        if (kind === 'levels') validateLevel(parsed)
        else if (!Array.isArray(asRecord(parsed).components)) throw new LevelError('games: expected { components: string[] }')
        // A game folder, and its levels folder, is made on demand: a PUT is how a new game comes into being.
        const made = !existsSync(file)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`)
        changed(user, [key])
        if (kind === 'levels' && made) levelsChanged()
        sendJson(res, 200, { ok: true })
      } catch (e) {
        sendJson(res, 400, { error: String(e instanceof Error ? e.message : e) })
      }
      return true
    }
    return false
  }

  const handleMirror = async (req: IncomingMessage, res: ServerResponse, url: string, query: URLSearchParams): Promise<boolean> => {
    if (req.method !== 'GET') return false
    // What is on disk must be current before anyone reads it from outside.
    if (url === '/api/tree' || url === '/api/file') {
      opts.live?.flushAll()
      opts.liveAssets?.flushAll()
    }
    if (url === '/api/tree') {
      const files = filesUnder(CONTENT).map((rel) => {
        const bytes = readFileSync(join(CONTENT, rel))
        return { path: `content/${rel}`, size: bytes.length, sha1: createHash('sha1').update(bytes).digest('hex') }
      })
      sendJson(res, 200, { seq: opts.changes?.seq() ?? 0, files })
      return true
    }
    if (url === '/api/changes') {
      const since = Number(query.get('since') ?? '0')
      const timeout = Math.min(Math.max(Number(query.get('timeout') ?? '25000'), 0), 60_000)
      if (opts.changes === undefined) return sendJson(res, 200, { seq: 0, paths: [] }), true
      const batch = await opts.changes.wait(Number.isFinite(since) ? since : 0, timeout)
      if (batch === null) return sendJson(res, 410, { error: 'too far behind; do a full sync' }), true
      sendJson(res, 200, batch)
      return true
    }
    if (url === '/api/file') {
      const rel = (query.get('path') ?? '').replace(/\\/g, '/')
      if (!rel.startsWith('content/')) return sendJson(res, 400, { error: 'path must start with content/' }), true
      const file = safeJoin(CONTENT, rel.slice('content/'.length))
      if (file === null) return sendJson(res, 400, { error: 'path escapes content' }), true
      if (!existsSync(file) || statSync(file).isDirectory()) return sendJson(res, 404, { error: 'not found' }), true
      res.statusCode = 200
      res.setHeader('content-type', contentTypeFor(file))
      res.end(readFileSync(file))
      return true
    }
    return false
  }

  const handleLive = async (req: IncomingMessage, res: ServerResponse, url: string, user: User): Promise<boolean> => {
    const live = opts.live
    if (live === undefined || !url.startsWith('/api/live')) return false
    if (url === '/api/live' && req.method === 'GET') return sendJson(res, 200, { docs: live.status() }), true

    /**
     * An edit to a data-file asset (ADR 0159) or a game's data file (ADR 0162), sent on whatever room connection
     * the editor has: neither is a room anyone joins, since everyone sees them drawn. The echo on every stream is
     * the acknowledgement.
     */
    const am = /^\/api\/live\/(?:asset\/([0-9a-f]{16})|game\/([\w-]+))\/ops$/.exec(url)
    if (am !== null) {
      if (opts.liveAssets === undefined) return false
      const id = am[1] ?? gameDocId(am[2]!)
      if (am[2] !== undefined && !gameNames().includes(am[2])) return sendJson(res, 404, { error: `no game ${am[2]}` }), true
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST expected' }), true
      let args: Record<string, unknown>
      try {
        args = asRecord(await readJson(req))
      } catch {
        return sendJson(res, 400, { error: 'expected a JSON body' }), true
      }
      const ops = Array.isArray(args.ops) ? (args.ops as unknown[]) : null
      if (ops === null || !ops.every(isAssetOp)) return sendJson(res, 400, { error: 'ops: expected asset ops' }), true
      try {
        const r = opts.liveAssets.apply(id, typeof args.connId === 'string' ? args.connId : '', user, {
          batchId: typeof args.batchId === 'string' ? args.batchId : '',
          ops,
        })
        return sendJson(res, 200, r), true
      } catch (e) {
        return sendJson(res, e instanceof LiveError ? e.status : 500, { error: e instanceof Error ? e.message : String(e) }), true
      }
    }
    /**
     * `/api/live/level/<game>/<name>/…` and `/api/live/prefab/<assetId>/…` (ADR 0091). The kind is its own
     * segment rather than a prefix in the name, because a `:` in a name would not match.
     *
     * A level's name carries a slash — it is qualified `<game>/<name>` (ADR 0108) — so the name group admits
     * one. The action is a fixed alternation anchored at the end, so the greedy group backtracks off it. A
     * level whose name is not a legal qualified one is not a document here, so the route does not match.
     */
    const m = /^\/api\/live\/(level|prefab)\/([\w\-/]+)\/(events|ops|hold|release|presence|assets|field|hidden|flush|leave|ping)$/.exec(url)
    if (m === null) return false
    const kind = m[1] as 'level' | 'prefab'
    if (kind === 'level' && parseQualified(m[2]!) === null) return false
    if (kind === 'prefab' && m[2]!.includes('/')) return false
    const name = docKey(kind, m[2]!)
    const action = m[3]!

    if (action === 'events') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET expected' }), true
      // Nothing is written until the join succeeds, so a missing level is still a 404 and not a stream.
      const connId = randomUUID()
      const buffered: string[] = []
      let started = false
      const send = (event: string, data: unknown, id?: number): void => {
        const frame = encodeSse(event, data, id)
        if (started) res.write(frame)
        else buffered.push(frame)
      }
      try {
        live.join(name, { connId, user, send })
      } catch (e) {
        return sendJson(res, e instanceof LiveError ? e.status : 500, { error: e instanceof Error ? e.message : String(e) }), true
      }
      res.writeHead(200, SSE_HEADERS)
      res.flushHeaders()
      res.write(buffered.join(''))
      started = true
      const keepalive = setInterval(() => res.write(SSE_KEEPALIVE), opts.keepaliveMs ?? 25_000)
      res.on('close', () => {
        clearInterval(keepalive)
        live.leave(name, connId)
      })
      return true
    }

    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST expected' }), true
    let args: Record<string, unknown>
    try {
      args = asRecord(await readJson(req))
    } catch {
      return sendJson(res, 400, { error: 'expected a JSON body' }), true
    }
    const connId = typeof args.connId === 'string' ? args.connId : ''
    try {
      switch (action) {
        case 'ops': {
          const ops = Array.isArray(args.ops) ? (args.ops as Op[]) : []
          sendJson(res, 200, live.apply(name, connId, user, { batchId: typeof args.batchId === 'string' ? args.batchId : '', ops }))
          return true
        }
        case 'hold': {
          sendJson(res, 200, live.hold(name, connId, user, Array.isArray(args.refs) ? (args.refs as NodeRef[]) : []))
          return true
        }
        case 'release': {
          live.release(name, connId, user, Array.isArray(args.refs) ? (args.refs as NodeRef[]) : [])
          sendJson(res, 200, { ok: true })
          return true
        }
        case 'hidden': {
          // Not an op: hiding is a view of the level, so it carries no batch and takes no sequence number.
          const keys = Array.isArray(args.keys) ? (args.keys as unknown[]).filter((k): k is string => typeof k === 'string') : []
          live.setHidden(name, keys, args.hidden === true)
          sendJson(res, 200, { ok: true })
          return true
        }
        case 'presence': {
          live.presence(name, connId, user, args.data)
          sendJson(res, 200, { ok: true })
          return true
        }
        case 'assets': {
          const ids = Array.isArray(args.assetIds) ? (args.assetIds as unknown[]).filter((a): a is string => typeof a === 'string' && /^[0-9a-f]{16}$/.test(a)) : []
          live.setOpenAssets(name, connId, user, ids)
          sendJson(res, 200, { ok: true })
          return true
        }
        case 'field': {
          const spot = parseFieldSpot(args.spot)
          if (spot === undefined) return sendJson(res, 400, { error: 'spot: expected { targets, card, field } or null' }), true
          live.setField(name, connId, user, spot)
          sendJson(res, 200, { ok: true })
          return true
        }
        case 'flush': {
          live.flush(name)
          sendJson(res, 200, { ok: true })
          return true
        }
        case 'ping': {
          live.ping(name, connId, user)
          sendJson(res, 200, { ok: true })
          return true
        }
        default: {
          live.leave(name, connId)
          sendJson(res, 200, { ok: true })
          return true
        }
      }
    } catch (e) {
      sendJson(res, e instanceof LiveError ? e.status : 500, { error: e instanceof Error ? e.message : String(e) })
      return true
    }
  }

  /** Who you are and the numbers the editor runs on; whether the last push failed. */
  const handleMe = (req: IncomingMessage, res: ServerResponse, url: string, user: User): boolean => {
    if (url === '/api/me' && req.method === 'GET') {
      const admin = opts.isAdmin?.(user) === true ? { admin: true } : {}
      sendJson(res, 200, { user, heartbeatMs: opts.rules.heartbeatMs, maxUploadBytes: opts.rules.maxUploadBytes, games: opts.games ?? {}, ...admin })
      return true
    }
    if (url === '/api/status' && req.method === 'GET') {
      sendJson(res, 200, { pushError: opts.status?.().pushError ?? null })
      return true
    }
    return false
  }

  return async (req, res) => {
    const raw = req.url ?? ''
    const q = raw.indexOf('?')
    const url = decodeURIComponent(q >= 0 ? raw.slice(0, q) : raw)
    const query = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : '')
    if (!url.startsWith('/api/') && !url.startsWith('/content/')) return false

    if (url === '/api/admin/commit-all') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST expected' }), true
      const auth = req.headers.authorization ?? ''
      if (opts.admin === undefined || auth !== `Bearer ${opts.admin.token}`) return sendJson(res, 401, { error: 'admin token required' }), true
      try {
        await opts.admin.commitAll()
        sendJson(res, 200, { ok: true })
      } catch (e) {
        sendJson(res, 500, { error: String(e instanceof Error ? e.message : e) })
      }
      return true
    }

    if (url.startsWith(PLAY_PREFIX)) {
      // A player, not an editor: the login is enough, as it is for the page itself (ADR 0169).
      const playerOk = opts.identifyPlayer ?? (async (r: IncomingMessage) => (await opts.identify(r)) !== null)
      let allowed: boolean
      try {
        allowed = await playerOk(req)
      } catch (e) {
        sendJson(res, e instanceof AuthError ? e.status : 500, { error: String(e instanceof Error ? e.message : e) })
        return true
      }
      if (!allowed) return sendJson(res, 401, { error: 'not signed in' }), true
      return handlePlay(req, res, url)
    }

    let user: User | null
    try {
      user = await opts.identify(req)
    } catch (e) {
      sendJson(res, e instanceof AuthError ? e.status : 500, { error: String(e instanceof Error ? e.message : e) })
      return true
    }
    if (user === null) return sendJson(res, 401, { error: 'not signed in' }), true

    if (opts.assistant !== undefined && (await opts.assistant.handle(req, res, url, user))) return true
    if (await handleLive(req, res, url, user)) return true
    if (await handleMirror(req, res, url, query)) return true
    if (handleMe(req, res, url, user)) return true
    if (await handleLevelOps(req, res, url, user)) return true
    if (await handleFiles(req, res, url, user)) return true
    return handleAssets(req, res, url, query, user)
  }
}

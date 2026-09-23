import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join, normalize, relative, sep } from 'node:path'

import { kindForPath, META_SUFFIX } from '../../../packages/content/src/assets'
import { ASSETS_DIR, gameFile, isGameName, levelFile, levelRefForFile, parseQualified, qualify, LEVELS_DIR } from '../../../packages/content/src/layout'
import type { NodeRef, Op } from '../../../packages/content/src/ops'
import { prefabRefsIn } from '../../../packages/content/src/prefabs'
import type { Level } from '../../../packages/content/src/types'
import { LevelError, validateLevel } from '../../../packages/content/src/validate'
import { importAssets } from './assetImporter'
import { AssetOpError, listFolders, makeFolder, movePath, removePath } from './assetOps'
import type { ChangeFeed } from './changes'
import type { User } from './config'
import { docKey, LiveError, type Live } from './live'
import { acquire, blocker, heartbeat, holder, release, type LockRules, type LockTable } from './locks'
import { encodeSse, SSE_HEADERS, SSE_KEEPALIVE } from './sse'

/**
 * The content API — one implementation behind both the dev editor (a Vite middleware, `auth: none`) and the
 * hosted editor (a Node server behind Cloudflare Access), so what the editor can do to `content/` is defined
 * once (ADR 0083).
 *
 *   GET  /api/me                      → { user, heartbeatMs, lockStaleMs, maxUploadBytes, games }
 *   GET  /api/status                  → { pushError, locks: [{ path, owner, since }] }
 *   POST /api/locks/acquire           → { path } → { ok, owner? }
 *   POST /api/locks/release           → { path } → { ok }         (a sendBeacon on tab close lands here too)
 *   POST /api/locks/heartbeat         → { paths } → { lost }
 *   GET  /api/levels                  → [{ name, mode?, prefabs? }] — prefabs: asset ids it references (ADR 0097)
 *   GET/PUT /api/levels/:name         → the JSON (PUT validated structurally)
 *   POST /api/levels/move             → { from, to } — rename, both qualified (ADR 0110)
 *   POST /api/levels/delete           → { path } — qualified; the file goes for good (ADR 0110)
 *   GET/PUT /api/games/:name          → { components } (ADR 0077)
 *   GET  /api/assets                  → { entries, folders } (runs the importer)
 *   POST /api/assets/mkdir|move|delete → { path } · { from, to } · { path }
 *   POST /api/assets/upload?path=     → raw bytes → { entry }   (textures and .glb, capped, replace keeps the id)
 *   GET  /assets/<path>               → the bytes
 *   PUT  /assets/<path>               → a JSON asset
 *   POST /api/admin/commit-all        → Bearer token, not a user: deploy flushes every session
 *
 * Live level editing (ADR 0089), when `live` is given:
 *   GET  /api/live                    → open documents, peers, holds
 *   GET  /api/live/:kind/:name/events → SSE: hello, snapshot, ops (id = seq), holds, peers, presence, error
 *                                       plus `prefab` on a level's stream: a prefab the level uses was edited
 *                                       :kind is `level` or `prefab` — a prefab is its own document (ADR 0091)
 *   POST /api/live/:kind/:name/ops          → { connId, batchId, ops } → { ok, seq } · 400 bad op · 423 held by another
 *   POST /api/live/:kind/:name/hold         → { connId, refs } — my holds are exactly these → { ok } / { ok: false, holder, refused }
 *   POST /api/live/:kind/:name/release      → { connId, refs } → { ok }
 *   POST /api/live/:kind/:name/ping         → { connId } — still here (the editor, every heartbeat)
 *   POST /api/live/:kind/:name/presence     → { connId, data } — relayed, unnumbered
 *   POST /api/live/:kind/:name/flush        → write the file now
 *   POST /api/live/:kind/:name/leave        → { connId } (a closing tab's beacon)
 *   PUT  /api/levels/:name            → 409 while the level is open live; GET serves the live copy
 *
 * For the live mirror (ADR 0084):
 *   GET  /api/tree                    → { seq, files: [{ path, size, sha1 }] } — every file under content/
 *   GET  /api/changes?since=N&timeout=MS → { seq, paths } — long-poll; 410 when N is older than the feed remembers
 *   GET  /api/file?path=content/...   → the bytes of any content file (404 when gone)
 *
 * Every write is gated by the lock table: a path someone else holds live is a 423 with their name. Every
 * write reports the repo-relative paths it touched to `onChanged` and the change feed — always **file** paths,
 * so a folder move or delete is reported as the files it moved or removed.
 */
export interface ApiOptions {
  repoRoot: string
  /** `null` → 401. Throwing → 500. */
  identify: (req: IncomingMessage) => Promise<User | null>
  locks: LockTable
  rules: LockRules & { heartbeatMs: number; maxUploadBytes: number }
  now?: () => number
  /** Repo-relative posix paths a user just changed on disk. */
  onChanged?: (user: User, paths: string[]) => void
  /** A lock was released (or the release was a no-op); the caller may commit the user's session. */
  onLockReleased?: (user: User) => void
  /** Persist the lock table after it changed. */
  onLocksChanged?: () => void
  status?: () => { pushError: string | null }
  admin?: { token: string; commitAll: () => Promise<void> }
  /** The live mirror's feed; every changed path is recorded here too. */
  changes?: ChangeFeed
  /** Game name → URL the editor's Play opens in a frame (ADR 0086). Relative to this server or absolute. */
  games?: Record<string, string>
  /** Live level documents (ADR 0089). Absent: levels are files, as before. */
  live?: Live
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
const MAX_JSON_BYTES = 32 * 1024 * 1024
/** What upload accepts: what the runtime loads. `.gltf` is refused — it drags `.bin` and textures along. */
export const UPLOAD_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'webp', 'ktx2', 'glb'])

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ktx2: 'image/ktx2',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  json: 'application/json',
}

export const contentTypeFor = (path: string): string => {
  const dot = path.lastIndexOf('.')
  return (dot >= 0 ? CONTENT_TYPES[path.slice(dot + 1).toLowerCase()] : undefined) ?? 'application/octet-stream'
}

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
const strField = (o: Record<string, unknown>, name: string): string => {
  const v = o[name]
  if (typeof v !== 'string') throw new AssetOpError(`${name}: expected a string`)
  return v
}

/** Repo-relative lock/commit key for a file the API knows. */
export const keyFor = {
  /** `name` is the qualified `<game>/<name>` (ADR 0108). */
  level: (name: string): string => {
    const ref = parseQualified(name)
    return ref === null ? `content/${name}` : `content/${levelFile(ref)}`
  },
  game: (name: string): string => `content/${gameFile(name)}`,
  asset: (path: string): string => `content/${ASSETS_DIR}/${path}`,
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
  const now = opts.now ?? (() => Date.now())
  const CONTENT = join(opts.repoRoot, 'content')
  const ASSETS = join(CONTENT, ASSETS_DIR)
  if (!existsSync(ASSETS)) mkdirSync(ASSETS, { recursive: true })

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

  const changed = (user: User, paths: string[]): void => {
    opts.onChanged?.(user, paths)
    opts.changes?.record(paths)
  }
  const locksChanged = (): void => opts.onLocksChanged?.()

  /** A file's own path plus its sidecar; a folder's every file. For reporting what a move or delete touched. */
  const filesOf = (rel: string): string[] => {
    const full = safeJoin(ASSETS, rel)
    if (full !== null && existsSync(full) && statSync(full).isDirectory()) return filesUnder(full).map((f) => `${rel}/${f}`)
    return [rel, `${rel}${META_SUFFIX}`]
  }

  /** Refuse with 423 when someone else holds `key` (or, for a folder, anything under it). Returns `true` when refused. */
  const refuseIfLocked = (res: ServerResponse, user: User, keys: readonly string[]): boolean => {
    const t = now()
    for (const key of keys) {
      const direct = blocker(opts.locks, key, user, t, opts.rules)
      const under = direct ?? Object.keys(opts.locks).filter((p) => p.startsWith(`${key}/`)).map((p) => blocker(opts.locks, p, user, t, opts.rules)).find((b) => b !== null) ?? null
      if (under !== null) {
        sendJson(res, 423, { error: `locked by ${under.name}`, owner: { name: under.name } })
        return true
      }
    }
    return false
  }

  /** Rescan so a new file has its sidecar now, attributed to the user who made it. */
  const rescanFor = (user: User): void => {
    const { created } = importAssets(ASSETS)
    if (created.length > 0) changed(user, created.map((p) => keyFor.asset(p)))
  }

  const handleAssets = async (req: IncomingMessage, res: ServerResponse, url: string, query: URLSearchParams, user: User): Promise<boolean> => {
    if (url === '/api/assets' && req.method === 'GET') {
      const { entries, created } = importAssets(ASSETS)
      // Sidecars the importer wrote for files that arrived outside the API (copied into the folder) belong to
      // whoever looked first — better than untracked files nobody commits.
      if (created.length > 0) changed(user, created.map((p) => keyFor.asset(p)))
      sendJson(res, 200, { entries, folders: listFolders(ASSETS) })
      return true
    }

    if (url === '/api/assets/upload') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST expected' }), true
      const rel = (query.get('path') ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
      const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()
      if (rel === '' || safeJoin(ASSETS, rel) === null) return sendJson(res, 400, { error: 'path escapes the assets root' }), true
      if (!UPLOAD_EXTENSIONS.has(ext) || kindForPath(rel) === undefined) return sendJson(res, 400, { error: `.${ext} is not an uploadable asset (${[...UPLOAD_EXTENSIONS].join(', ')})` }), true
      if (refuseIfLocked(res, user, [keyFor.asset(rel)])) return true
      let bytes: Buffer
      try {
        bytes = await readBody(req, opts.rules.maxUploadBytes)
      } catch (e) {
        sendJson(res, e instanceof TooLarge ? 413 : 400, { error: String(e instanceof Error ? e.message : e) })
        return true
      }
      const file = safeJoin(ASSETS, rel)!
      mkdirSync(join(file, '..'), { recursive: true })
      // Same name, same folder: replaced, and the sidecar beside it is untouched, so the id — and every
      // reference — survives. That is how art gets updated.
      writeFileSync(file, bytes)
      changed(user, [keyFor.asset(rel)])
      const { entries } = importAssets(ASSETS)
      const meta = `${rel}${META_SUFFIX}`
      if (!existsSync(`${file}${META_SUFFIX}`)) sendJson(res, 500, { error: 'importer wrote no sidecar' })
      else {
        changed(user, [keyFor.asset(meta)])
        sendJson(res, 200, { entry: entries.find((e) => e.path === rel) ?? null })
      }
      return true
    }

    const op = /^\/api\/assets\/(mkdir|move|delete)$/.exec(url)
    if (op !== null) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST expected' }), true
      try {
        const args = asRecord(await readJson(req))
        if (op[1] === 'mkdir') {
          const path = strField(args, 'path')
          makeFolder(ASSETS, path)
          // An empty folder is nothing to git; it is committed with its first file.
        } else if (op[1] === 'move') {
          const from = strField(args, 'from')
          const to = strField(args, 'to')
          if (refuseIfLocked(res, user, [keyFor.asset(from), keyFor.asset(to)])) return true
          const before = filesOf(from)
          movePath(ASSETS, from, to)
          const after = before.map((p) => `${to}${p.slice(from.length)}`)
          changed(user, [...before, ...after].map(keyFor.asset))
        } else {
          const path = strField(args, 'path')
          if (refuseIfLocked(res, user, [keyFor.asset(path)])) return true
          const gone = filesOf(path)
          removePath(ASSETS, path)
          changed(user, gone.map(keyFor.asset))
        }
        sendJson(res, 200, { ok: true })
      } catch (e) {
        sendJson(res, e instanceof AssetOpError || e instanceof SyntaxError ? 400 : 500, { error: String(e instanceof Error ? e.message : e) })
      }
      return true
    }

    if (!url.startsWith('/assets/')) return false
    const rel = url.slice('/assets/'.length)
    const file = safeJoin(ASSETS, rel)
    if (file === null) return sendJson(res, 400, { error: 'path escapes the assets root' }), true

    /** The prefab document open on this path, if any: a prefab is a live document now (ADR 0091). */
    const openPrefab = (): { id: string; root: unknown } | null => {
      if (opts.live === undefined || !rel.endsWith('.prefab.json')) return null
      const entry = importAssets(ASSETS).entries.find((e) => e.kind === 'prefab' && e.path === rel)
      if (entry === undefined) return null
      const doc = opts.live.levelOf(docKey('prefab', entry.id))
      return doc === null ? null : { id: entry.id, root: doc.nodes[0] }
    }

    if (req.method === 'GET') {
      // The live copy wins, as it does for a level: it is up to five seconds ahead of the file.
      const live = openPrefab()
      if (live !== null) return sendJson(res, 200, live.root), true
      if (!existsSync(file) || statSync(file).isDirectory()) return sendJson(res, 404, { error: 'not found' }), true
      res.statusCode = 200
      res.setHeader('content-type', contentTypeFor(file))
      res.end(readFileSync(file))
      return true
    }
    if (req.method === 'PUT') {
      // Refused while it is open, as a level's PUT is: the document would write its own copy back over this.
      const live = openPrefab()
      if (live !== null) return sendJson(res, 409, { error: `that prefab is open live; edit it in the editor` }), true
      if (refuseIfLocked(res, user, [keyFor.asset(rel)])) return true
      try {
        // JSON only: materials, prefabs and clips. Binaries go through upload, which has the cap.
        const parsed: unknown = await readJson(req)
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
        if (refuseIfLocked(res, user, [keyFor.level(qualify(from)), keyFor.level(qualify(to))])) return true
        const src = fileOf(from)
        const dst = fileOf(to)
        if (!existsSync(src)) return sendJson(res, 404, { error: `no level ${qualify(from)}` }), true
        if (existsSync(dst)) throw new AssetOpError(`${qualify(to)} already exists`)
        // The `id` inside follows the file name, as every writer of a level keeps it (see `live.ts`).
        const level = JSON.parse(readFileSync(src, 'utf8')) as Record<string, unknown>
        level['id'] = to.name
        mkdirSync(dirname(dst), { recursive: true })
        writeFileSync(dst, `${JSON.stringify(level, null, 2)}\n`)
        rmSync(src)
        changed(user, [keyFor.level(qualify(from)), keyFor.level(qualify(to))])
        sendJson(res, 200, { ok: true })
        return true
      }

      const ref = parseQualified(strField(args, 'path'))
      if (ref === null) throw new AssetOpError('path must be <game>/<name>')
      const qual = qualify(ref)
      if (openLive(qual)) return sendJson(res, 409, { error: `${qual} is open live; close it in the editor first` }), true
      if (refuseIfLocked(res, user, [keyFor.level(qual)])) return true
      const file = fileOf(ref)
      if (!existsSync(file)) return sendJson(res, 404, { error: `no level ${qual}` }), true
      rmSync(file)
      changed(user, [keyFor.level(qual)])
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
          const live = opts.live?.levelOf(name)
          const parsed = (live ?? JSON.parse(readFileSync(file, 'utf8'))) as Level
          const prefabs = prefabRefsIn(parsed)
          return { name, mode: ref.game, ...(prefabs.length > 0 ? { prefabs } : {}) }
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
    if (req.method === 'GET') {
      // An open live document is newer than its file until the next flush; serve it.
      const open = kind === 'levels' ? opts.live?.levelOf(name) : null
      if (open !== null && open !== undefined) return sendJson(res, 200, open), true
      if (!existsSync(file)) return sendJson(res, 404, { error: 'not found' }), true
      sendJson(res, 200, JSON.parse(readFileSync(file, 'utf8')))
      return true
    }
    if (req.method === 'PUT') {
      const key = kind === 'levels' ? keyFor.level(name) : keyFor.game(name)
      if (kind === 'levels' && opts.live?.isOpen(name) === true) return sendJson(res, 409, { error: `${name} is open live; edit it in the editor` }), true
      if (refuseIfLocked(res, user, [key])) return true
      try {
        const parsed: unknown = await readJson(req)
        // Structure is checked here so a broken level never reaches disk or git; parameters need the game's
        // registry, which the editor has and this server does not, so the editor checks those before sending.
        if (kind === 'levels') validateLevel(parsed)
        else if (!Array.isArray(asRecord(parsed).components)) throw new LevelError('games: expected { components: string[] }')
        // A game folder, and its levels folder, is made on demand: a PUT is how a new game comes into being.
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`)
        changed(user, [key])
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
    if (url === '/api/tree' || url === '/api/file') opts.live?.flushAll()
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
     * `/api/live/level/<game>/<name>/…` and `/api/live/prefab/<assetId>/…` (ADR 0091). The kind is its own
     * segment rather than a prefix in the name, because a `:` in a name would not match.
     *
     * A level's name carries a slash — it is qualified `<game>/<name>` (ADR 0108) — so the name group admits
     * one. The action is a fixed alternation anchored at the end, so the greedy group backtracks off it. A
     * level whose name is not a legal qualified one is not a document here, so the route does not match.
     */
    const m = /^\/api\/live\/(level|prefab)\/([\w\-/]+)\/(events|ops|hold|release|presence|hidden|flush|leave|ping)$/.exec(url)
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

  const handleLocks = async (req: IncomingMessage, res: ServerResponse, url: string, user: User): Promise<boolean> => {
    if (url === '/api/me' && req.method === 'GET') {
      sendJson(res, 200, { user, heartbeatMs: opts.rules.heartbeatMs, lockStaleMs: opts.rules.staleMs, maxUploadBytes: opts.rules.maxUploadBytes, games: opts.games ?? {} })
      return true
    }
    if (url === '/api/status' && req.method === 'GET') {
      const t = now()
      const locks = Object.entries(opts.locks)
        .filter(([path]) => holder(opts.locks, path, t, opts.rules) !== null)
        .map(([path, lock]) => ({ path, owner: lock.owner.name, since: lock.since }))
      sendJson(res, 200, { pushError: opts.status?.().pushError ?? null, locks })
      return true
    }
    const m = /^\/api\/locks\/(acquire|release|heartbeat)$/.exec(url)
    if (m === null) return false
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST expected' }), true
    let args: Record<string, unknown>
    try {
      args = asRecord(await readJson(req))
    } catch {
      return sendJson(res, 400, { error: 'expected a JSON body' }), true
    }
    const t = now()
    if (m[1] === 'heartbeat') {
      const paths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === 'string') : []
      const lost = heartbeat(opts.locks, paths, user, t)
      locksChanged()
      sendJson(res, 200, { lost })
      return true
    }
    const path = typeof args.path === 'string' ? args.path : ''
    if (path === '') return sendJson(res, 400, { error: 'path: expected a string' }), true
    if (m[1] === 'acquire') {
      const r = acquire(opts.locks, path, user, t, opts.rules)
      locksChanged()
      sendJson(res, 200, r.ok ? { ok: true } : { ok: false, owner: { name: r.owner.name } })
      return true
    }
    const ok = release(opts.locks, path, user)
    locksChanged()
    sendJson(res, 200, { ok })
    // After the response: the commit can take a second and the editor does not wait for it.
    opts.onLockReleased?.(user)
    return true
  }

  return async (req, res) => {
    const raw = req.url ?? ''
    const q = raw.indexOf('?')
    const url = decodeURIComponent(q >= 0 ? raw.slice(0, q) : raw)
    const query = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : '')
    if (!url.startsWith('/api/') && !url.startsWith('/assets/')) return false

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

    let user: User | null
    try {
      user = await opts.identify(req)
    } catch (e) {
      sendJson(res, e instanceof AuthError ? e.status : 500, { error: String(e instanceof Error ? e.message : e) })
      return true
    }
    if (user === null) return sendJson(res, 401, { error: 'not signed in' }), true

    if (await handleLive(req, res, url, user)) return true
    if (await handleMirror(req, res, url, query)) return true
    if (await handleLocks(req, res, url, user)) return true
    if (await handleLevelOps(req, res, url, user)) return true
    if (await handleFiles(req, res, url, user)) return true
    return handleAssets(req, res, url, query, user)
  }
}

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, normalize, sep } from 'node:path'

import { kindForPath, META_SUFFIX } from '../../../packages/content/src/assets'
import { LevelError, validateLevel } from '../../../packages/content/src/validate'
import { importAssets } from './assetImporter'
import { AssetOpError, listFolders, makeFolder, movePath, removePath } from './assetOps'
import type { User } from './config'
import { acquire, blocker, heartbeat, holder, release, type LockRules, type LockTable } from './locks'

/**
 * The content API — one implementation behind both the dev editor (a Vite middleware, `auth: none`) and the
 * hosted editor (a Node server behind Cloudflare Access), so what the editor can do to `content/` is defined
 * once (ADR 0083).
 *
 *   GET  /api/me                      → { user, heartbeatMs, lockStaleMs, maxUploadBytes }
 *   GET  /api/status                  → { pushError, locks: [{ path, owner, since }] }
 *   POST /api/locks/acquire           → { path } → { ok, owner? }
 *   POST /api/locks/release           → { path } → { ok }         (a sendBeacon on tab close lands here too)
 *   POST /api/locks/heartbeat         → { paths } → { lost }
 *   GET  /api/levels                  → [{ name, mode? }]
 *   GET/PUT /api/levels/:name         → the JSON (PUT validated structurally)
 *   GET/PUT /api/games/:name          → { components } (ADR 0077)
 *   GET  /api/assets                  → { entries, folders } (runs the importer)
 *   POST /api/assets/mkdir|move|delete → { path } · { from, to } · { path }
 *   POST /api/assets/upload?path=     → raw bytes → { entry }   (textures and .glb, capped, replace keeps the id)
 *   GET  /assets/<path>               → the bytes
 *   PUT  /assets/<path>               → a JSON asset
 *   POST /api/admin/commit-all        → Bearer token, not a user: deploy flushes every session
 *
 * Every write is gated by the lock table: a path someone else holds live is a 423 with their name. Every
 * write reports the repo-relative paths it touched to `onChanged`, which is how sessions know what to commit.
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

const ROUTE_RE = /^\/api\/(levels|games)(?:\/([\w-]+))?$/
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
  level: (name: string): string => `content/levels/${name}.json`,
  game: (name: string): string => `content/games/${name}.json`,
  asset: (path: string): string => `content/assets/${path}`,
}

export const createContentApi = (opts: ApiOptions): ApiHandler => {
  const now = opts.now ?? (() => Date.now())
  const DIRS = { levels: join(opts.repoRoot, 'content', 'levels'), games: join(opts.repoRoot, 'content', 'games') }
  const ASSETS = join(opts.repoRoot, 'content', 'assets')
  for (const dir of [...Object.values(DIRS), ASSETS]) if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const changed = (user: User, paths: string[]): void => opts.onChanged?.(user, paths)
  const locksChanged = (): void => opts.onLocksChanged?.()

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
          movePath(ASSETS, from, to)
          changed(user, [keyFor.asset(from), keyFor.asset(`${from}${META_SUFFIX}`), keyFor.asset(to), keyFor.asset(`${to}${META_SUFFIX}`)])
        } else {
          const path = strField(args, 'path')
          if (refuseIfLocked(res, user, [keyFor.asset(path)])) return true
          removePath(ASSETS, path)
          changed(user, [keyFor.asset(path), keyFor.asset(`${path}${META_SUFFIX}`)])
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

    if (req.method === 'GET') {
      if (!existsSync(file) || statSync(file).isDirectory()) return sendJson(res, 404, { error: 'not found' }), true
      res.statusCode = 200
      res.setHeader('content-type', contentTypeFor(file))
      res.end(readFileSync(file))
      return true
    }
    if (req.method === 'PUT') {
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

  const handleFiles = async (req: IncomingMessage, res: ServerResponse, url: string, user: User): Promise<boolean> => {
    const m = ROUTE_RE.exec(url)
    if (m === null) return false
    const kind = m[1] as 'levels' | 'games'
    const dir = DIRS[kind]
    const name = m[2]
    if (name === undefined) {
      if (req.method !== 'GET') return false
      // Name and which game it is for (ADR 0052). A file that will not parse is listed without a game rather
      // than omitted — you have to be able to see a broken level in order to fix it.
      const entries = readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const levelName = f.slice(0, -'.json'.length)
          try {
            const parsed = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { config?: { mode?: { name?: unknown } } }
            const mode = parsed.config?.mode?.name
            return { name: levelName, ...(typeof mode === 'string' && mode !== '' ? { mode } : {}) }
          } catch {
            return { name: levelName }
          }
        })
      sendJson(res, 200, entries)
      return true
    }
    const file = join(dir, `${name}.json`)
    if (req.method === 'GET') {
      if (!existsSync(file)) return sendJson(res, 404, { error: 'not found' }), true
      sendJson(res, 200, JSON.parse(readFileSync(file, 'utf8')))
      return true
    }
    if (req.method === 'PUT') {
      const key = kind === 'levels' ? keyFor.level(name) : keyFor.game(name)
      if (refuseIfLocked(res, user, [key])) return true
      try {
        const parsed: unknown = await readJson(req)
        // Structure is checked here so a broken level never reaches disk or git; parameters need the game's
        // registry, which the editor has and this server does not, so the editor checks those before sending.
        if (kind === 'levels') validateLevel(parsed)
        else if (!Array.isArray(asRecord(parsed).components)) throw new LevelError('games: expected { components: string[] }')
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

  const handleLocks = async (req: IncomingMessage, res: ServerResponse, url: string, user: User): Promise<boolean> => {
    if (url === '/api/me' && req.method === 'GET') {
      sendJson(res, 200, { user, heartbeatMs: opts.rules.heartbeatMs, lockStaleMs: opts.rules.staleMs, maxUploadBytes: opts.rules.maxUploadBytes })
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

    if (await handleLocks(req, res, url, user)) return true
    if (await handleFiles(req, res, url, user)) return true
    return handleAssets(req, res, url, query, user)
  }
}

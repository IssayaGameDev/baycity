import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join } from 'node:path'

import { createAccessVerifier } from './access'
import { AuthError, contentTypeFor, createContentApi, safeJoin } from './api'
import type { ServerConfig, User } from './config'
import { commitPaths, push } from './git'
import { heldBy, sweep, type LockTable } from './locks'
import { describeCommit, markDirty, take, takeAll, takeDue, type Session, type SessionTable } from './sessions'

/**
 * The hosted editor's server (ADR 0083): the content API behind Cloudflare Access, the built editor as static
 * files, one lock table, one session per person, commits on the content branch.
 *
 * State outside the repo (`stateDir`): `locks.json` so a restart keeps every lock, `admin.token` so deploy can
 * ask for every session to be committed before it merges.
 */
export interface EditorServer {
  server: Server
  /** Commit every session, then stop listening. */
  close: () => Promise<void>
}

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
}

const log = (msg: string): void => console.log(`${new Date().toISOString()} ${msg}`)

export const startEditorServer = (config: ServerConfig): EditorServer => {
  mkdirSync(config.stateDir, { recursive: true })
  const locksFile = join(config.stateDir, 'locks.json')
  const tokenFile = join(config.stateDir, 'admin.token')

  const locks: LockTable = existsSync(locksFile) ? (JSON.parse(readFileSync(locksFile, 'utf8')) as LockTable) : {}
  const saveLocks = (): void => writeFileSync(locksFile, `${JSON.stringify(locks, null, 2)}\n`)
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(24).toString('hex'), { mode: 0o600 })
  const adminToken = readFileSync(tokenFile, 'utf8').trim()

  const sessions: SessionTable = new Map()
  let pushError: string | null = null

  // Commits run one at a time: two sessions committing at once would race on the index.
  let queue: Promise<void> = Promise.resolve()
  const commitSession = (s: Session): Promise<void> => {
    const git = config.git
    if (git === null) return Promise.resolve()
    queue = queue.then(async () => {
      try {
        const r = await commitPaths(config.repoRoot, {
          paths: [...s.dirty],
          author: s.user,
          committer: git.committer,
          message: describeCommit(s.dirty),
        })
        if (!r.committed) return
        log(`commit ${r.sha.slice(0, 7)} by ${s.user.name}: ${r.paths.length} file(s)`)
        if (!git.push) return
        try {
          await push(config.repoRoot, git.branch)
          pushError = null
        } catch (e) {
          pushError = e instanceof Error ? e.message : String(e)
          log(`push failed: ${pushError}`)
        }
      } catch (e) {
        // The files are still dirty on disk; put them back so the next commit picks them up.
        markDirty(sessions, s.user, [...s.dirty], s.since)
        log(`commit failed for ${s.user.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    })
    return queue
  }
  const commitAll = async (): Promise<void> => {
    for (const s of takeAll(sessions)) void commitSession(s)
    await queue
  }

  // --- identity ---
  let identify: (req: IncomingMessage) => Promise<User | null>
  if (config.auth.kind === 'none') {
    const user = config.auth.user
    identify = async () => user
  } else {
    const auth = config.auth
    const verifier = createAccessVerifier(auth.teamDomain, auth.aud)
    identify = async (req) => {
      const header = req.headers['cf-access-jwt-assertion']
      const token = Array.isArray(header) ? header[0] : header
      if (token === undefined || token === '') return null
      const v = await verifier.verify(token)
      if (!v.ok) {
        if (v.reason === 'wrong audience' && auth.aud === '') {
          log(`auth.aud is empty; this login carried aud ${JSON.stringify(v.aud ?? [])} — put it in the config`)
          throw new AuthError(503, 'the server has no audience tag yet; ask Kodjo to finish the config')
        }
        return null
      }
      const name = auth.users[v.email]
      if (name === undefined) throw new AuthError(403, `${v.email} is signed in but not in the editor's user list`)
      return { name, email: v.email }
    }
  }

  const api = createContentApi({
    repoRoot: config.repoRoot,
    identify,
    locks,
    rules: { staleMs: config.lockStaleMs, heartbeatMs: config.heartbeatMs, maxUploadBytes: config.maxUploadBytes },
    onChanged: (user, paths) => markDirty(sessions, user, paths, Date.now()),
    onLockReleased: (user) => {
      const s = take(sessions, user)
      if (s !== null) void commitSession(s)
    },
    onLocksChanged: saveLocks,
    status: () => ({ pushError }),
    admin: { token: adminToken, commitAll },
  })

  // --- static editor ---
  const serveStatic = (req: IncomingMessage, res: ServerResponse): void => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')
    const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '')
    const file = safeJoin(config.editorDist, rel)
    if (file === null || !existsSync(file)) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    const ext = extname(file)
    res.statusCode = 200
    res.setHeader('content-type', STATIC_TYPES[ext] ?? contentTypeFor(file))
    // Vite hashes everything under assets/; index.html is the one file that must never be stale.
    res.setHeader('cache-control', rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
    res.end(readFileSync(file))
  }

  const server = createServer((req, res) => {
    void api(req, res)
      .then((handled) => {
        if (!handled) serveStatic(req, res)
      })
      .catch((e: unknown) => {
        log(`${req.method ?? ''} ${req.url ?? ''} failed: ${e instanceof Error ? e.message : String(e)}`)
        if (!res.headersSent) {
          res.statusCode = 500
          res.end('server error')
        }
      })
  })

  // Stale locks are swept and overdue sessions committed once a minute.
  const timer = setInterval(() => {
    const now = Date.now()
    const dropped = sweep(locks, now, { staleMs: config.lockStaleMs })
    if (dropped.length > 0) {
      saveLocks()
      for (const lock of dropped) {
        if (heldBy(locks, lock.owner).length > 0) continue
        const s = take(sessions, lock.owner)
        if (s !== null) void commitSession(s)
      }
    }
    for (const s of takeDue(sessions, now, config.safetyCommitMs)) void commitSession(s)
  }, 60_000)

  server.listen(config.port, () => log(`editor server on :${config.port}, ${config.auth.kind === 'none' ? 'no auth' : `Access team ${config.auth.teamDomain}`}, git ${config.git === null ? 'off' : `→ ${config.git.branch}`}`))

  return {
    server,
    close: async () => {
      clearInterval(timer)
      await commitAll()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

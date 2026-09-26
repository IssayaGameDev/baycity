import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, extname, join } from 'node:path'

import { createAccessVerifier } from './access'
import { AuthError, contentTypeFor, createContentApi, safeJoin } from './api'
import { createChangeFeed } from './changes'
import type { ServerConfig, User } from './config'
import { commitPaths, push } from './git'
import { createLive, levelPath } from './live'
import { createAssetIndex } from './assetIndex'
import { liveAssetFiles } from './liveAssetFiles'
import { createLiveAssets } from './liveAssets'
import { createPrefabStore } from './prefabStore'
import { hostRedirect, proxyHttp, proxyUpgrade, routeFor, stripPrefix } from './proxy'
import { describeCommit, markDirty, take, takeAll, takeDue, type Session, type SessionTable } from './sessions'

/**
 * The hosted editor's server (ADR 0083): the content API behind Cloudflare Access, the built editor as static
 * files, one session per person, commits on the content branch.
 *
 * State outside the repo (`stateDir`): `admin.token` so deploy can ask for every session to be committed before it
 * merges, and `hidden.json`.
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
  const tokenFile = join(config.stateDir, 'admin.token')
  /**
   * Which nodes are hidden in the editor's viewport, by document key (ADR 0132).
   *
   * In the state folder because it belongs to this server, not to the content. Hiding never reaches the game
   * and must not become a content edit everyone has to merge, so it is neither in the level file nor in the
   * repo. Rewritten whole per toggle — a handful of string keys.
   */
  const hiddenFile = join(config.stateDir, 'hidden.json')

  if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(24).toString('hex'), { mode: 0o600 })
  const adminToken = readFileSync(tokenFile, 'utf8').trim()
  const hidden: Record<string, string[]> = existsSync(hiddenFile) ? (JSON.parse(readFileSync(hiddenFile, 'utf8')) as Record<string, string[]>) : {}
  const saveHidden = (): void => writeFileSync(hiddenFile, JSON.stringify(hidden, null, 2) + '\n')

  const sessions: SessionTable = new Map()
  let pushError: string | null = null
  const feed = createChangeFeed()

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
    live.flushAll() // unwritten live edits first, or the commit would miss them
    liveAssets.flushAll()
    for (const s of takeAll(sessions)) void commitSession(s)
    await queue
  }

  // --- live level documents (ADR 0089) ---
  const CONTENT = join(config.repoRoot, 'content')
  /** A level is named `<game>/<name>` and lives in its game's folder (ADR 0108); `levelPath` is the one rule. */
  const levelFileOf = (name: string): string => join(config.repoRoot, levelPath(name))
  /** One asset list for the API and the prefab store, so a prefab the API just moved is where the store looks (ADR 0156). */
  const assets = createAssetIndex(CONTENT)
  const live = createLive({
    staleMs: config.lockStaleMs,
    // A level references a prefab by asset id (ADR 0091); the definitions come off disk.
    prefabs: createPrefabStore(CONTENT, assets),
    readHidden: (key) => hidden[key] ?? [],
    writeHidden: (key, keys) => {
      if (keys.length === 0) delete hidden[key]
      else hidden[key] = keys
      saveHidden()
    },
    readLevel: (name) => {
      const file = levelFileOf(name)
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : null
    },
    writeLevel: (name, level) => {
      const file = levelFileOf(name)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(level, null, 2)}\n`)
    },
    // Disk is written; now every contributor's session goes dirty and the mirror hears the path — once.
    changed: (users, path) => {
      const now = Date.now()
      for (const u of users) markDirty(sessions, u, [path], now)
      feed.record([path])
    },
    onDocClosed: (users) => {
      for (const u of users) {
        const s = take(sessions, u)
        if (s !== null) void commitSession(s)
      }
    },
  })

  /**
   * Data-file assets edited live (ADR 0159): a material's edits reach every editor in any room, and its file is
   * written behind — into the editor's session, as a level's writes are.
   */
  const liveAssets = createLiveAssets({
    ...liveAssetFiles(CONTENT, assets),
    changed: (users, path) => {
      const now = Date.now()
      for (const u of users) markDirty(sessions, u, [path], now)
      feed.record([path])
    },
    connection: (connId) => live.connection(connId),
    broadcast: (event, data) => live.broadcastAll(event, data),
  })

  // --- identity ---
  let identify: (req: IncomingMessage) => Promise<User | null>
  /** Anyone the login let in may play (`/api/play`, ADR 0169); the editor wants a name in its list. */
  let identifyPlayer: (req: IncomingMessage) => Promise<boolean>
  if (config.auth.kind === 'none') {
    const user = config.auth.user
    identify = async () => user
    identifyPlayer = async () => true
  } else {
    const auth = config.auth
    const verifier = createAccessVerifier(auth.teamDomain, auth.aud)
    /** The login's verdict on this request, or `null` for none. */
    const signedIn = async (req: IncomingMessage) => {
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
      return v
    }
    identify = async (req) => {
      const v = await signedIn(req)
      if (v === null) return null
      if (v.service !== undefined) return { name: auth.services[v.service] ?? `service ${v.service.slice(0, 8)}…`, email: v.email }
      const name = auth.users[v.email]
      if (name === undefined) throw new AuthError(403, `${v.email} is signed in but not in the editor's user list`)
      return { name, email: v.email }
    }
    identifyPlayer = async (req) => (await signedIn(req)) !== null
  }

  const api = createContentApi({
    repoRoot: config.repoRoot,
    identify,
    identifyPlayer,
    rules: { heartbeatMs: config.heartbeatMs, maxUploadBytes: config.maxUploadBytes },
    onChanged: (user, paths) => markDirty(sessions, user, paths, Date.now()),
    status: () => ({ pushError }),
    admin: { token: adminToken, commitAll },
    changes: feed,
    games: Object.fromEntries(Object.entries(config.games).map(([name, g]) => [name, g.path])),
    live,
    assets,
    liveAssets,
  })

  // --- the staging games, under this origin (ADR 0086) ---
  const gameRoutes = Object.values(config.games).map((g) => ({ path: g.path, target: new URL(g.target), host: g.host }))
  const relayRoute = { path: '/relay', target: new URL(config.relay) }
  const pathOf = (req: IncomingMessage): string => (req.url ?? '/').split('?')[0] ?? '/'

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
    // Vite hashes everything under app/ (`assetsDir`; `content/` is the asset route); index.html must never be stale.
    res.setHeader('cache-control', rel.startsWith('app/') ? 'public, max-age=31536000, immutable' : 'no-cache')
    res.end(readFileSync(file))
  }

  const server = createServer((req, res) => {
    const redirect = hostRedirect(req.headers.host, req.url ?? '/', gameRoutes)
    if (redirect !== null) {
      res.writeHead(302, { location: redirect })
      res.end()
      return
    }
    const game = routeFor(pathOf(req), gameRoutes)
    if (game !== undefined) {
      proxyHttp(req, res, game.target)
      return
    }
    // Colyseus matchmakes over HTTP before it opens the socket; both ride `/relay`, prefix stripped.
    if (routeFor(pathOf(req), [relayRoute]) !== undefined) {
      proxyHttp(req, res, relayRoute.target, stripPrefix(req.url ?? '/', relayRoute.path))
      return
    }
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

  // Vite's HMR socket for a framed game, and the relay socket its page opens at /relay.
  server.on('upgrade', (req, socket, head) => {
    const route = routeFor(pathOf(req), [...gameRoutes, relayRoute])
    if (route === undefined) {
      socket.destroy()
      return
    }
    proxyUpgrade(req, socket, head, route.target, route === relayRoute ? stripPrefix(req.url ?? '/', relayRoute.path) : (req.url ?? '/'))
  })

  // Silent live connections are swept and overdue sessions committed once a minute.
  const timer = setInterval(() => {
    live.sweep()
    for (const s of takeDue(sessions, Date.now(), config.safetyCommitMs)) void commitSession(s)
  }, 60_000)

  server.listen(config.port, () =>
    log(
      `editor server on :${config.port}, ${config.auth.kind === 'none' ? 'no auth' : `Access team ${config.auth.teamDomain}`}, git ${config.git === null ? 'off' : `→ ${config.git.branch}`}, games ${Object.keys(config.games).join(', ') || 'none'}`,
    ),
  )

  return {
    server,
    close: async () => {
      clearInterval(timer)
      await commitAll() // flushes live documents first
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** Who is calling: the name commits carry and locks show, and the email Access verified. */
export interface User {
  name: string
  email: string
}

/**
 * How callers are identified.
 *
 * `none` is the dev editor: one machine, one person, no login — every request is `user`. `access` is the
 * hosted editor behind Cloudflare Access: every request carries a signed JWT for `teamDomain` and `aud`, and
 * `users` maps the verified email to the display name commits and locks use (ADR 0083).
 */
export type AuthConfig =
  | { kind: 'none'; user: User }
  | {
      kind: 'access'
      /** `<team>.cloudflareaccess.com` — where the signing keys are fetched and who must have issued the token. */
      teamDomain: string
      /** The Access application's audience tag. Empty accepts nothing: the first login logs the tag it carried. */
      aud: string
      /** Verified email (lower-cased) → display name. An email not listed is refused even if Access let it in. */
      users: Record<string, string>
      /**
       * Access service-token Client ID → display name (ADR 0084). Any token Access let through is accepted —
       * the Access policy is the list — this only names it in logs; unlisted ones show as `service <id…>`.
       */
      services: Record<string, string>
    }

export interface ServerConfig {
  port: number
  /** The checkout the server edits and commits in. `content/` is under it. */
  repoRoot: string
  /** Locks and the admin token live here, outside the repo — never a commit. */
  stateDir: string
  /** Where the built editor is served from. */
  editorDist: string
  auth: AuthConfig
  /**
   * `null` disables git entirely (the dev editor: what is on disk is the working copy Kodjo commits himself).
   * Otherwise every session commits on `branch` and, with `push`, pushes it.
   */
  git: { branch: string; push: boolean; committer: User } | null
  /** Upload cap per file. Kodjo's knob; 10 MB to start. */
  maxUploadBytes: number
  /** A lock whose holder has not been heard from for this long is anyone's. */
  lockStaleMs: number
  /** How often the editor is expected to call heartbeat — advertised to it. */
  heartbeatMs: number
  /** A session's dirty files are committed at least this often even if its lock is never released. */
  safetyCommitMs: number
  /**
   * The staging games this server fronts (ADR 0086): by game name, the path they are served under here and the
   * dev server to proxy to. `host`: a hostname whose root should land on the game (`dev.playgorbo.com`).
   */
  games: Record<string, StagingGame>
  /** The relay every game page reaches at `/relay` (ws). */
  relay: string
}

export interface StagingGame {
  /** `/play/keyboard/` — also the game's Vite `base`. */
  path: string
  /** `http://127.0.0.1:5177` */
  target: string
  host?: string
}

export const DEFAULTS = {
  port: 8080,
  maxUploadBytes: 10 * 1024 * 1024,
  lockStaleMs: 2 * 60_000,
  heartbeatMs: 30_000,
  safetyCommitMs: 10 * 60_000,
} as const

const num = (v: unknown, fallback: number, name: string): number => {
  if (v === undefined) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`config.${name}: expected a positive number`)
  return v
}
const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v === '') throw new Error(`config.${name}: expected a non-empty string`)
  return v
}
const user = (v: unknown, name: string): User => {
  const o = (typeof v === 'object' && v !== null ? v : {}) as { name?: unknown; email?: unknown }
  return { name: str(o.name, `${name}.name`), email: str(o.email, `${name}.email`) }
}

/** Parse a config object. Paths are resolved against `baseDir` so a config file can use relative ones. */
export const parseConfig = (raw: unknown, baseDir: string): ServerConfig => {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const path = (v: unknown, name: string): string => {
    const p = str(v, name)
    return isAbsolute(p) ? p : resolve(baseDir, p)
  }
  const auth = (typeof o.auth === 'object' && o.auth !== null ? o.auth : {}) as Record<string, unknown>
  let authConfig: AuthConfig
  if (auth.kind === 'access') {
    const users = (typeof auth.users === 'object' && auth.users !== null ? auth.users : {}) as Record<string, unknown>
    const named: Record<string, string> = {}
    for (const [email, name] of Object.entries(users)) named[email.toLowerCase()] = str(name, `auth.users.${email}`)
    const services = (typeof auth.services === 'object' && auth.services !== null ? auth.services : {}) as Record<string, unknown>
    const namedServices: Record<string, string> = {}
    for (const [id, name] of Object.entries(services)) namedServices[id] = str(name, `auth.services.${id}`)
    authConfig = {
      kind: 'access',
      teamDomain: str(auth.teamDomain, 'auth.teamDomain'),
      aud: typeof auth.aud === 'string' ? auth.aud : '',
      users: named,
      services: namedServices,
    }
  } else if (auth.kind === 'none' || auth.kind === undefined) {
    authConfig = { kind: 'none', user: auth.user === undefined ? { name: 'local', email: 'local@localhost' } : user(auth.user, 'auth.user') }
  } else throw new Error(`config.auth.kind: expected 'none' or 'access'`)

  let git: ServerConfig['git'] = null
  if (o.git !== undefined && o.git !== null) {
    const g = o.git as Record<string, unknown>
    git = {
      branch: str(g.branch, 'git.branch'),
      push: g.push === undefined ? true : g.push === true,
      committer: g.committer === undefined ? { name: 'Editor Server', email: 'editor-server@localhost' } : user(g.committer, 'git.committer'),
    }
  }

  const games: Record<string, StagingGame> = {}
  const rawGames = (typeof o.games === 'object' && o.games !== null ? o.games : {}) as Record<string, unknown>
  for (const [name, g] of Object.entries(rawGames)) {
    const r = (typeof g === 'object' && g !== null ? g : {}) as Record<string, unknown>
    const p = str(r.path, `games.${name}.path`)
    if (!p.startsWith('/') || !p.endsWith('/')) throw new Error(`config.games.${name}.path: must start and end with /`)
    games[name] = { path: p, target: str(r.target, `games.${name}.target`), ...(typeof r.host === 'string' && r.host !== '' ? { host: r.host } : {}) }
  }

  const repoRoot = path(o.repoRoot, 'repoRoot')
  return {
    port: num(o.port, DEFAULTS.port, 'port'),
    repoRoot,
    stateDir: path(o.stateDir ?? '.editor-server', 'stateDir'),
    editorDist: o.editorDist === undefined ? resolve(repoRoot, 'tools/editor/dist') : path(o.editorDist, 'editorDist'),
    auth: authConfig,
    git,
    maxUploadBytes: num(o.maxUploadBytes, DEFAULTS.maxUploadBytes, 'maxUploadBytes'),
    lockStaleMs: num(o.lockStaleMs, DEFAULTS.lockStaleMs, 'lockStaleMs'),
    heartbeatMs: num(o.heartbeatMs, DEFAULTS.heartbeatMs, 'heartbeatMs'),
    safetyCommitMs: num(o.safetyCommitMs, DEFAULTS.safetyCommitMs, 'safetyCommitMs'),
    games,
    relay: typeof o.relay === 'string' && o.relay !== '' ? o.relay : 'http://127.0.0.1:9200',
  }
}

export const loadConfig = (file: string): ServerConfig => parseConfig(JSON.parse(readFileSync(file, 'utf8')), resolve(file, '..'))

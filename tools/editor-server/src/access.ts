import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from 'node:crypto'

/**
 * Cloudflare Access identity: the `Cf-Access-Jwt-Assertion` header every request through the tunnel carries.
 *
 * Trusting the plain `Cf-Access-Authenticated-User-Email` header would trust anyone who can reach the box —
 * and cloudflared itself connects from loopback, so "loopback" proves nothing. The JWT is signed by the team's
 * keys (published at `/cdn-cgi/access/certs`), names the application (`aud`) and expires; a request that
 * skipped Cloudflare cannot forge one. Node's own `crypto` verifies RS256, so no dependency (ADR 0083).
 *
 * `verifyToken` is pure over a key set and a clock; `createAccessVerifier` fetches and caches the keys.
 */
export interface Jwk extends JsonWebKey {
  kid?: string
}

export interface VerifyOptions {
  /** `https://<team>.cloudflareaccess.com` */
  issuer: string
  /** The application's audience tag. */
  aud: string
  /** Seconds since the epoch. */
  now: number
  keys: readonly Jwk[]
}

export type Verified = { ok: true; email: string } | { ok: false; reason: string; aud?: string[] }

const b64url = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

const parseJson = (buf: Buffer): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(buf.toString('utf8'))
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export const verifyToken = (token: string, opts: VerifyOptions): Verified => {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' }
  const [h, p, s] = parts as [string, string, string]
  const header = parseJson(b64url(h))
  const payload = parseJson(b64url(p))
  if (header === null || payload === null) return { ok: false, reason: 'malformed token' }
  if (header.alg !== 'RS256') return { ok: false, reason: `unsupported alg ${String(header.alg)}` }

  const key = opts.keys.find((k) => k.kid === header.kid)
  if (key === undefined) return { ok: false, reason: 'unknown kid' }
  let valid = false
  try {
    valid = cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key, format: 'jwk' }), b64url(s))
  } catch {
    valid = false
  }
  if (!valid) return { ok: false, reason: 'bad signature' }

  const aud = Array.isArray(payload.aud) ? payload.aud.filter((a): a is string => typeof a === 'string') : typeof payload.aud === 'string' ? [payload.aud] : []
  if (payload.iss !== opts.issuer) return { ok: false, reason: 'wrong issuer', aud }
  if (typeof payload.exp !== 'number' || payload.exp <= opts.now) return { ok: false, reason: 'expired', aud }
  if (opts.aud === '' || !aud.includes(opts.aud)) return { ok: false, reason: 'wrong audience', aud }
  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : ''
  if (email === '') return { ok: false, reason: 'no email', aud }
  return { ok: true, email }
}

export interface AccessVerifier {
  verify: (token: string) => Promise<Verified>
}

/** The team's published keys. */
export const fetchKeys = async (teamDomain: string): Promise<Jwk[]> => {
  const r = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`)
  if (!r.ok) throw new Error(`certs → ${r.status}`)
  const body = (await r.json()) as { keys?: unknown }
  return Array.isArray(body.keys) ? (body.keys as Jwk[]) : []
}

/**
 * Keys are fetched on the first request and refetched at most once a minute when a token names a kid we do
 * not hold — Cloudflare rotates them, and a rotation must not lock everyone out until a restart.
 */
export const createAccessVerifier = (
  teamDomain: string,
  aud: string,
  deps: { fetchKeys?: (team: string) => Promise<Jwk[]>; now?: () => number } = {},
): AccessVerifier => {
  const getKeys = deps.fetchKeys ?? fetchKeys
  const clock = deps.now ?? (() => Date.now())
  const issuer = `https://${teamDomain}`
  let keys: Jwk[] | null = null
  let fetchedAt = -Infinity
  const REFETCH_MS = 60_000

  const load = async (): Promise<Jwk[]> => {
    keys = await getKeys(teamDomain)
    fetchedAt = clock()
    return keys
  }

  return {
    verify: async (token) => {
      const now = Math.floor(clock() / 1000)
      let set = keys ?? (await load())
      let result = verifyToken(token, { issuer, aud, now, keys: set })
      if (!result.ok && result.reason === 'unknown kid' && clock() - fetchedAt >= REFETCH_MS) {
        set = await load()
        result = verifyToken(token, { issuer, aud, now, keys: set })
      }
      return result
    },
  }
}

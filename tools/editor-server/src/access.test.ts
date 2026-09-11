import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { createAccessVerifier, verifyToken, type Jwk } from './access'

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const keyPair = (kid: string): { priv: KeyObject; jwk: Jwk } => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { priv: privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid } }
}

const mint = (priv: KeyObject, kid: string, payload: Record<string, unknown>): string => {
  const h = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }))
  const p = b64url(JSON.stringify(payload))
  const s = b64url(sign('RSA-SHA256', Buffer.from(`${h}.${p}`), priv))
  return `${h}.${p}.${s}`
}

const TEAM = 'cold-boat-3e59.cloudflareaccess.com'
const ISS = `https://${TEAM}`
const AUD = 'a'.repeat(64)
const NOW = 1_700_000_000

describe('verifyToken', () => {
  const k = keyPair('k1')
  const good = { aud: [AUD], email: 'Ada@Example.com', exp: NOW + 600, iat: NOW, iss: ISS, sub: 'x', type: 'app' }

  it('accepts a signed, unexpired token for the right app and lower-cases the email', () => {
    const t = mint(k.priv, 'k1', good)
    expect(verifyToken(t, { issuer: ISS, aud: AUD, now: NOW, keys: [k.jwk] })).toEqual({ ok: true, email: 'ada@example.com' })
  })

  it('refuses a token signed by another key, even one with the same kid', () => {
    const other = keyPair('k1')
    const t = mint(other.priv, 'k1', good)
    expect(verifyToken(t, { issuer: ISS, aud: AUD, now: NOW, keys: [k.jwk] })).toMatchObject({ ok: false, reason: 'bad signature' })
  })

  it('refuses expiry, wrong issuer, wrong audience — and reports the audience it saw', () => {
    const opts = { issuer: ISS, aud: AUD, now: NOW, keys: [k.jwk] }
    expect(verifyToken(mint(k.priv, 'k1', { ...good, exp: NOW }), opts)).toMatchObject({ ok: false, reason: 'expired' })
    expect(verifyToken(mint(k.priv, 'k1', { ...good, iss: 'https://evil' }), opts)).toMatchObject({ ok: false, reason: 'wrong issuer' })
    expect(verifyToken(mint(k.priv, 'k1', { ...good, aud: ['other'] }), opts)).toEqual({ ok: false, reason: 'wrong audience', aud: ['other'] })
    expect(verifyToken(mint(k.priv, 'k1', good), { ...opts, aud: '' })).toMatchObject({ ok: false, reason: 'wrong audience', aud: [AUD] })
  })

  it('accepts a service token by its common_name when there is no email', () => {
    const t = mint(k.priv, 'k1', { aud: [AUD], common_name: 'abc123.access', exp: NOW + 600, iss: ISS, type: 'app' })
    expect(verifyToken(t, { issuer: ISS, aud: AUD, now: NOW, keys: [k.jwk] })).toEqual({ ok: true, email: 'abc123.access@service', service: 'abc123.access' })
    const neither = mint(k.priv, 'k1', { aud: [AUD], exp: NOW + 600, iss: ISS })
    expect(verifyToken(neither, { issuer: ISS, aud: AUD, now: NOW, keys: [k.jwk] })).toMatchObject({ ok: false, reason: 'no email' })
  })

  it('refuses garbage and unknown kids without throwing', () => {
    expect(verifyToken('nope', { issuer: ISS, aud: AUD, now: NOW, keys: [k.jwk] })).toMatchObject({ ok: false })
    expect(verifyToken(mint(k.priv, 'k9', good), { issuer: ISS, aud: AUD, now: NOW, keys: [k.jwk] })).toMatchObject({ ok: false, reason: 'unknown kid' })
  })
})

describe('createAccessVerifier', () => {
  it('fetches keys once, and refetches once a minute at most when a kid is unknown', async () => {
    const k1 = keyPair('k1')
    const k2 = keyPair('k2')
    let published = [k1.jwk]
    let fetches = 0
    let clock = 0
    const v = createAccessVerifier(TEAM, AUD, {
      fetchKeys: async () => {
        fetches++
        return published
      },
      now: () => clock,
    })
    const payload = { aud: [AUD], email: 'a@b', exp: 10_000, iss: ISS }
    expect(await v.verify(mint(k1.priv, 'k1', payload))).toEqual({ ok: true, email: 'a@b' })
    expect(fetches).toBe(1)

    // Rotation: a token from a key we have not seen. Within the minute: no refetch.
    published = [k1.jwk, k2.jwk]
    clock = 30_000
    expect(await v.verify(mint(k2.priv, 'k2', payload))).toMatchObject({ ok: false, reason: 'unknown kid' })
    expect(fetches).toBe(1)
    clock = 61_000
    expect(await v.verify(mint(k2.priv, 'k2', payload))).toEqual({ ok: true, email: 'a@b' })
    expect(fetches).toBe(2)
  })
})

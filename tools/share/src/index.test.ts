import { describe, expect, it } from 'vitest'

import { composeShareLink, findTunnelUrl, gameToShare, isTunnelNews, SHARED_GAMES } from './index'

describe('findTunnelUrl', () => {
  it('pulls the hostname out of the cloudflared banner', () => {
    const banner = [
      '2026-07-28T02:06:12Z INF +--------------------------------------------------+',
      '2026-07-28T02:06:12Z INF |  Your quick Tunnel has been created! Visit it at: |',
      '2026-07-28T02:06:12Z INF |  https://nyc-organisations-ask-concert.trycloudflare.com  |',
      '2026-07-28T02:06:12Z INF +--------------------------------------------------+',
    ].join('\n')
    expect(findTunnelUrl(banner)).toBe('https://nyc-organisations-ask-concert.trycloudflare.com')
  })

  it('returns null while no tunnel has been assigned yet', () => {
    expect(findTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeNull()
  })
})

describe('composeShareLink', () => {
  it('points the page at its own host’s /relay proxy, as wss, in ?server=', () => {
    expect(composeShareLink('https://page.trycloudflare.com')).toBe(
      'https://page.trycloudflare.com/?server=wss://page.trycloudflare.com/relay',
    )
  })
})

describe('gameToShare', () => {
  it('defaults to keyboard, the one game there is', () => {
    expect(gameToShare([]).name).toBe('keyboard')
  })

  it('picks the named game and its own port', () => {
    expect(gameToShare(['keyboard'])).toEqual({ name: 'keyboard', script: 'dev:keyboard', port: 5177 })
  })

  it('refuses a name that is not a game rather than sharing the wrong one', () => {
    expect(() => gameToShare(['kayboard'])).toThrow(/no game called "kayboard"/)
  })

  it('knows every game that has a dev script', () => {
    expect(SHARED_GAMES.map((g) => g.name).sort()).toEqual(['keyboard'])
  })
})

describe('isTunnelNews', () => {
  it('keeps the connection and failure lines', () => {
    expect(isTunnelNews('2026-09-10T14:37:42Z INF Registered tunnel connection connIndex=0 protocol=quic')).toBe(true)
    expect(isTunnelNews('2026-09-10T14:37:42Z ERR Failed to dial a quic connection')).toBe(true)
    expect(isTunnelNews('2026-09-10T14:37:42Z WRN Cannot determine default origin certificate path')).toBe(true)
  })

  it('drops the banner and the pre-checks', () => {
    expect(isTunnelNews('2026-09-10T14:37:41Z INF |  https://x.trycloudflare.com  |')).toBe(false)
    expect(isTunnelNews('2026-09-10T14:37:41Z INF |  UDP Connectivity  region1.v2.argotunnel.com  PASS  |')).toBe(false)
  })
})

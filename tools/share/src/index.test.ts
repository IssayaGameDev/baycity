import { describe, expect, it } from 'vitest'

import { composeShareLink, findTunnelUrl } from './index'

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
  it('carries the relay endpoint as wss in ?server=', () => {
    expect(composeShareLink('https://page.trycloudflare.com', 'https://relay.trycloudflare.com')).toBe(
      'https://page.trycloudflare.com/?server=wss://relay.trycloudflare.com',
    )
  })
})

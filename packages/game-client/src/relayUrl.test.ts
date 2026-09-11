import { describe, expect, it } from 'vitest'

import { relayUrl } from './relayUrl'

const at = (url: string): Parameters<typeof relayUrl>[0] => {
  const u = new URL(url)
  return { protocol: u.protocol, hostname: u.hostname, host: u.host, search: u.search }
}

describe('relayUrl', () => {
  it('dev: plain http talks to :9200 on the same machine', () => {
    expect(relayUrl(at('http://localhost:5177/'))).toBe('ws://localhost:9200')
    expect(relayUrl(at('http://192.168.1.20:5177/?level=keyboard'))).toBe('ws://192.168.1.20:9200')
  })
  it('behind https the page’s own server proxies /relay', () => {
    expect(relayUrl(at('https://dev.playgorbo.com/'))).toBe('wss://dev.playgorbo.com/relay')
    expect(relayUrl(at('https://x.trycloudflare.com/?level=a'))).toBe('wss://x.trycloudflare.com/relay')
  })
  it('?server= overrides everything', () => {
    expect(relayUrl(at('http://localhost:5177/?server=wss://elsewhere/relay'))).toBe('wss://elsewhere/relay')
    expect(relayUrl(at('https://dev.playgorbo.com/?server='))).toBe('wss://dev.playgorbo.com/relay')
  })
})

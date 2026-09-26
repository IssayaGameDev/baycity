import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'

import { hostRedirect, proxyHttp, proxyUpgrade, routeFor, stripPrefix } from './proxy'

const listen = (s: Server): Promise<number> =>
  new Promise((r) =>
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      r(typeof a === 'object' && a !== null ? a.port : 0)
    }),
  )
const servers: Server[] = []
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections()
    await new Promise<void>((r) => s.close(() => r()))
  }
  servers.length = 0
})

describe('routeFor', () => {
  it('matches the longest path, with or without the trailing slash', () => {
    const routes = [{ path: '/play/' }, { path: '/play/keyboard/' }]
    expect(routeFor('/play/keyboard/src/main.ts', routes)?.path).toBe('/play/keyboard/')
    expect(routeFor('/play/keyboard', routes)?.path).toBe('/play/keyboard/')
    expect(routeFor('/play/other/', routes)?.path).toBe('/play/')
    expect(routeFor('/api/me', routes)).toBeUndefined()
  })
})

describe('stripPrefix', () => {
  it('drops the relay prefix and keeps the rest, query included', () => {
    expect(stripPrefix('/relay/matchmake/joinOrCreate/game', '/relay')).toBe('/matchmake/joinOrCreate/game')
    expect(stripPrefix('/relay/abc?sessionId=1', '/relay/')).toBe('/abc?sessionId=1')
    expect(stripPrefix('/relay', '/relay')).toBe('/')
    expect(stripPrefix('/relayx/y', '/relay')).toBe('/relayx/y')
  })
})

describe('proxyHttp', () => {
  it('forwards method, path, headers and body, and answers 502 when the target is down', async () => {
    const target = createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString()))
      req.on('end', () => {
        res.setHeader('x-seen', `${req.method} ${req.url} accept=${req.headers['x-accept'] ?? ''} body=${body}`)
        res.end('hello from the game')
      })
    })
    servers.push(target)
    const tport = await listen(target)
    const front = createServer((req, res) => proxyHttp(req, res, new URL(`http://127.0.0.1:${tport}`)))
    servers.push(front)
    const fport = await listen(front)

    const r = await fetch(`http://127.0.0.1:${fport}/play/keyboard/?level=a`, { method: 'POST', body: 'x=1', headers: { 'x-accept': 'yes' } })
    expect(await r.text()).toBe('hello from the game')
    expect(r.headers.get('x-seen')).toBe('POST /play/keyboard/?level=a accept=yes body=x=1')

    target.closeAllConnections()
    await new Promise<void>((r) => target.close(() => r()))
    servers.splice(servers.indexOf(target), 1)
    const down = await fetch(`http://127.0.0.1:${fport}/play/keyboard/`)
    expect(down.status).toBe(502)
    expect(await down.text()).toMatch(/not answering/)
  })
})

describe('proxyUpgrade', () => {
  it('replays the handshake and pipes bytes both ways', async () => {
    const sockets: Duplex[] = []
    const CRLF = String.fromCharCode(13, 10)
    const target = createServer()
    target.on('upgrade', (req, socket) => {
      sockets.push(socket)
      socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `x-path: ${req.url ?? ''}`, '', ''].join(CRLF))
      socket.on('data', (d: Buffer) => socket.write(`echo:${d.toString()}`))
    })
    servers.push(target)
    const tport = await listen(target)
    const front = createServer()
    front.on('upgrade', (req, socket, head) => {
      sockets.push(socket)
      proxyUpgrade(req, socket, head, new URL(`http://127.0.0.1:${tport}`))
    })
    servers.push(front)
    const fport = await listen(front)

    const got = await new Promise<string>((resolve, reject) => {
      const s = connect(fport, '127.0.0.1', () => {
        s.write(['GET /relay/ HTTP/1.1', 'Host: editor.test', 'Upgrade: websocket', 'Connection: Upgrade', '', ''].join(CRLF))
      })
      sockets.push(s)
      let buf = ''
      s.on('data', (d: Buffer) => {
        const chunk = d.toString()
        buf += chunk
        if (chunk.startsWith('HTTP/1.1 101')) s.write('ping')
        if (buf.includes('echo:ping')) resolve(buf)
      })
      s.on('error', reject)
      setTimeout(() => reject(new Error(`timeout; got ${buf}`)), 3000).unref()
    })
    for (const s of sockets) s.destroy()
    expect(got).toMatch(/^HTTP\/1\.1 101/)
    expect(got).toMatch(/x-path: \/relay\//)
    expect(got).toMatch(/echo:ping$/)
  })
})

describe('hostRedirect', () => {
  const games = [{ path: '/play/keyboard/', host: 'dev.playgorbo.com' }, { path: '/play/other/' }]

  it('sends a game host’s bare address to the game, query kept', () => {
    expect(hostRedirect('dev.playgorbo.com', '/', games)).toBe('/play/keyboard/')
    expect(hostRedirect('dev.playgorbo.com:443', '/?level=Roblox', games)).toBe('/play/keyboard/?level=Roblox')
  })

  it('leaves every other path on that host alone: what the game’s page asks for', () => {
    for (const url of ['/api/levels/keyboard/Roblox', '/api/live/level/keyboard/Roblox/events', '/api/play/keyboard/levels.json', '/relay/matchmake', '/play/keyboard/']) {
      expect(hostRedirect('dev.playgorbo.com', url, games), url).toBeNull()
    }
  })

  it('never redirects another host', () => {
    expect(hostRedirect('editor.playgorbo.com', '/', games)).toBeNull()
    expect(hostRedirect(undefined, '/', games)).toBeNull()
  })
})

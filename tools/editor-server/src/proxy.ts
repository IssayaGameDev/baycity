import type { IncomingMessage, ServerResponse } from 'node:http'
import { request } from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'

/**
 * The little reverse proxy that puts the staging game under the editor's own origin (ADR 0086):
 * `editor.playgorbo.com/play/keyboard/…` → the game's Vite dev server on the box, and `/relay` → the relay.
 * Same origin, so the editor can embed the game in a frame and the Access login carries over with no
 * third-party-cookie trouble. Plain `node:http` and `node:net`; the upgrade path carries Vite's HMR socket and
 * the game's relay socket.
 *
 * The `Host` header is passed through unchanged: Vite checks it against `allowedHosts`, which lists the domain.
 */
export const proxyHttp = (req: IncomingMessage, res: ServerResponse, target: URL): void => {
  const upstream = request(
    { host: target.hostname, port: Number(target.port), method: req.method, path: req.url, headers: req.headers },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    },
  )
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.statusCode = 502
      res.setHeader('content-type', 'text/plain')
    }
    res.end(`${target.host} is not answering — is the game server running?`)
  })
  req.pipe(upstream)
}

/** Forward a WebSocket (or any) upgrade: replay the request line and headers, then pipe bytes both ways. */
export const proxyUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer, target: URL): void => {
  const upstream = connect(Number(target.port), target.hostname, () => {
    const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`]
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
  socket.on('close', () => upstream.destroy())
  upstream.on('close', () => socket.destroy())
}

/** Which configured route a URL falls under, longest path first so `/play/keyboard/` beats `/play/`. */
export const routeFor = <T extends { path: string }>(url: string, routes: readonly T[]): T | undefined =>
  [...routes].sort((a, b) => b.path.length - a.path.length).find((r) => url === r.path.replace(/\/$/, '') || url.startsWith(r.path))

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
/** `/relay/matchmake/x` → `/matchmake/x`: the relay lives at its root, as behind the games' own Vite proxy. */
export const stripPrefix = (url: string, prefix: string): string => {
  const bare = prefix.replace(/\/$/, '')
  return url === bare ? '/' : url.startsWith(`${bare}/`) ? url.slice(bare.length) : url
}

export const proxyHttp = (req: IncomingMessage, res: ServerResponse, target: URL, path: string = req.url ?? '/'): void => {
  const upstream = request(
    { host: target.hostname, port: Number(target.port), method: req.method, path, headers: req.headers },
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
export const proxyUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer, target: URL, path: string = req.url ?? '/'): void => {
  const upstream = connect(Number(target.port), target.hostname, () => {
    const lines = [`${req.method ?? 'GET'} ${path} HTTP/1.1`]
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

/**
 * Where a request for a game's own host goes (ADR 0086): its bare address, `/`, to the game's path, query kept —
 * `dev.playgorbo.com` → `/play/keyboard/`. `null` for anything else, which is answered as on any host.
 *
 * The bare address only. It used to catch every path outside the game's, so a page on that host asking this server
 * for anything — its live level (ADR 0089) — got the game's page back instead and fell back quietly, where the
 * editor's Play frame, on another host, worked.
 */
export const hostRedirect = (host: string | undefined, url: string, games: readonly { path: string; host?: string | undefined }[]): string | null => {
  const name = (host ?? '').split(':')[0]
  const game = games.find((g) => g.host !== undefined && g.host === name)
  const q = url.indexOf('?')
  if (game === undefined || (q >= 0 ? url.slice(0, q) : url) !== '/') return null
  return `${game.path}${q >= 0 ? url.slice(q) : ''}`
}

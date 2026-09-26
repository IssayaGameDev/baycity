/**
 * @mp/share — pure helpers for the quick-tunnel share link. The process orchestration
 * lives in `main.ts`; everything testable lives here.
 */

/** Hostname cloudflared prints once a quick tunnel is assigned. */
const QUICK_TUNNEL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

/** First quick-tunnel URL in a chunk of cloudflared output, or null. */
export const findTunnelUrl = (chunk: string): string | null => QUICK_TUNNEL.exec(chunk)?.[0] ?? null

/**
 * cloudflared's own lines worth seeing. Everything else it prints is a banner or a pre-check, and drowning the
 * link in it is how a tunnel that never connected went unnoticed: the URL is printed *before* the connection
 * is made, and a failure after that was filtered out.
 */
export const isTunnelNews = (line: string): boolean => /ERR|WRN|Registered tunnel connection|Unregistered/.test(line)

/**
 * One hostname for both. The page's dev server proxies the relay at `/relay` (each game's `vite.config.ts`),
 * so the page is handed `wss://<same host>/relay` via `?server=` — read by `createNetHost`. https→wss because
 * the page is served over TLS and a `ws://` relay would be blocked as mixed content.
 */
export const composeShareLink = (pageUrl: string): string => `${pageUrl}/?server=${pageUrl.replace(/^https:/, 'wss:')}/relay`

/** A game `pnpm share` can put behind a tunnel: its root dev script and the port that script's Vite binds. */
export interface SharedGame {
  readonly name: string
  readonly script: string
  readonly port: number
}

/**
 * Every game in the build, by name. The ports are each game's `vite.config.ts`; a new game is one line here
 * or it cannot be shared.
 */
export const SHARED_GAMES: readonly SharedGame[] = [
  { name: 'keyboard', script: 'dev:keyboard', port: 5177 },
]

/**
 * Which game to share: `pnpm share <name>`, defaulting to keyboard, the one game there is.
 * Throws on a name that is not a game rather than silently sharing the wrong one.
 */
export const gameToShare = (args: readonly string[], games: readonly SharedGame[] = SHARED_GAMES): SharedGame => {
  const name = args.find((a) => !a.startsWith('-')) ?? 'keyboard'
  const game = games.find((g) => g.name === name)
  if (game === undefined) throw new Error(`no game called "${name}"; one of: ${games.map((g) => g.name).join(', ')}`)
  return game
}

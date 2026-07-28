/**
 * @mp/share — pure helpers for the quick-tunnel share link. The process orchestration
 * lives in `main.ts`; everything testable lives here.
 */

/** Hostname cloudflared prints once a quick tunnel is assigned. */
const QUICK_TUNNEL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

/** First quick-tunnel URL in a chunk of cloudflared output, or null. */
export const findTunnelUrl = (chunk: string): string | null => QUICK_TUNNEL.exec(chunk)?.[0] ?? null

/**
 * The page and the relay sit behind separate tunnels (separate origins), and the relay
 * hostname is only known at runtime, so the page is handed its endpoint via `?server=`
 * — read in `modes/parkour/src/main.ts`. https→wss because the page is served over TLS
 * and a `ws://` relay would be blocked as mixed content.
 */
export const composeShareLink = (pageUrl: string, relayUrl: string): string =>
  `${pageUrl}/?server=${relayUrl.replace(/^https:/, 'wss:')}`

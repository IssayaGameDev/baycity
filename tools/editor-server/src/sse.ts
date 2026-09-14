/**
 * Server-sent events framing (ADR 0089). One function, because the format is four lines: an optional `id`,
 * an `event` name, one `data:` line per line of the JSON, a blank line. A comment line (`:keepalive`) is what
 * keeps a proxy from closing an idle stream.
 */
export const encodeSse = (event: string, data: unknown, id?: number): string => {
  const lines = JSON.stringify(data)
    .split('\n')
    .map((l) => `data: ${l}`)
    .join('\n')
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\n${lines}\n\n`
}

export const SSE_KEEPALIVE = ':keepalive\n\n'

export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  // nginx-style proxies buffer by default; Cloudflare honours this too.
  'x-accel-buffering': 'no',
} as const

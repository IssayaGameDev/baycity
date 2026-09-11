/**
 * Where the relay is, from where the page is (ADR 0085).
 *
 * - `?server=` wins: the share tool hands a page its relay this way (ADR 0074).
 * - A page on plain `http://` — the dev servers on this machine — talks to the relay on `:9200` directly.
 * - A page on `https://` is behind something (the staging tunnel at `dev.playgorbo.com`, a future host), where
 *   `:9200` is not reachable and the page's own server proxies `/relay` to the relay. Same host, `wss`.
 */
export interface PageLocation {
  protocol: string
  hostname: string
  host: string
  search: string
}

export const relayUrl = (loc: PageLocation): string => {
  const override = new URLSearchParams(loc.search).get('server')
  if (override !== null && override !== '') return override
  return loc.protocol === 'https:' ? `wss://${loc.host}/relay` : `ws://${loc.hostname}:9200`
}

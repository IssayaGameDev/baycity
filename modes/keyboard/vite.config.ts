import { defineConfig } from 'vite'

import { contentAlias, contentBanner } from '../../content-root'

/**
 * Copy this with the directory and **change the port** — every game needs its own, or the second one you run
 * silently steals the first one's. Parkour is 5174, swing 5175; this one is deliberately in the same range so
 * a clash is obvious rather than mysterious.
 *
 * `es2022` for the top-level await `startTpsClient` needs. The `allowedHosts` entry is for quick tunnels:
 * they present an arbitrary `*.trycloudflare.com` Host header, which Vite 6 rejects by default.
 */
export default defineConfig({
  // `@content` is the repo's content/, or the live mirror when `.env` says so (ADR 0084).
  plugins: [contentBanner()],
  resolve: { alias: contentAlias() },
  server: {
    port: 5177,
    allowedHosts: ['.trycloudflare.com', '.playgorbo.com'],
    /**
     * The relay, reachable through this server at `/relay` (ADR 0074). A shared page points its client at
     * `wss://<this host>/relay`, so page and relay ride **one** tunnel: two quick tunnels opened together were
     * never routed by Cloudflare, one alone routes in seconds. Local play never uses this — with no `?server=`
     * the client talks to :9200 directly.
     */
    proxy: {
      '/relay': { target: 'http://localhost:9200', ws: true, rewrite: (p) => p.replace(/^\/relay/, '') },
      // On the box (`dev.playgorbo.com` → this server), the live level comes from the editor server (ADR 0089).
      ...(process.env.MP_BASE !== undefined ? { '/api': { target: 'http://127.0.0.1:8080' } } : {}),
    },
    /**
     * On the box the hosted editor rewrites level files every few seconds; watching them reloaded every
     * player's page each time. The page reads its level at boot instead (`pickLevel`, ADR 0089). Locally the
     * watch stays: the mirror writing a level is what reloads the game, and that is the loop wanted there.
     */
    ...(process.env.MP_BASE !== undefined ? { watch: { ignored: ['**/content/*/levels/**', '**/.content-live/*/levels/**'] } } : {}),
  },
  // On the box the game is served under the editor's origin at this path (ADR 0086); locally at /.
  base: process.env.MP_BASE ?? '/',
  build: { target: 'es2022' },
})

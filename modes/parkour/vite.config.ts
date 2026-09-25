import { defineConfig } from 'vite'

import { contentAlias, contentBanner } from '../../content-root'
import { gameContent } from '../../game-content'

// Throwaway M10 demo app (3D TPS character controller). Target ES2022 for the
// top-level await used to init the physics/HUD.
export default defineConfig({
  // `@content` is the repo's content/, or the live mirror when `.env` says so (ADR 0084).
  plugins: [contentBanner(), gameContent('parkour')],
  resolve: { alias: contentAlias() },
  // Quick tunnels present an arbitrary *.trycloudflare.com Host header; Vite 6 rejects
  // unrecognised hosts by default.
  server: {
    port: 5174,
    allowedHosts: ['.trycloudflare.com', '.playgorbo.com'],
    /**
     * The relay, reachable through this server at `/relay` (ADR 0074). A shared page points its client at
     * `wss://<this host>/relay`, so page and relay ride **one** tunnel: two quick tunnels opened together were
     * never routed by Cloudflare, one alone routes in seconds. Local play never uses this — with no `?server=`
     * the client talks to :9200 directly.
     */
    proxy: { '/relay': { target: 'http://localhost:9200', ws: true, rewrite: (p) => p.replace(/^\/relay/, '') } },
  },
  build: { target: 'es2022' },
})

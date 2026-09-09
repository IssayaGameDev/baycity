import { defineConfig } from 'vite'

/**
 * Copy this with the directory and **change the port** — every game needs its own, or the second one you run
 * silently steals the first one's. Parkour is 5174, swing 5175; this one is deliberately in the same range so
 * a clash is obvious rather than mysterious.
 *
 * `es2022` for the top-level await `startTpsClient` needs. The `allowedHosts` entry is for quick tunnels:
 * they present an arbitrary `*.trycloudflare.com` Host header, which Vite 6 rejects by default.
 */
export default defineConfig({
  server: { port: 5179, allowedHosts: ['.trycloudflare.com'] },
  build: { target: 'es2022' },
})

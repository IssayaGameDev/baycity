import { defineConfig } from 'vite'

// Throwaway M10 demo app (3D TPS character controller). Target ES2022 for the
// top-level await used to init the physics/HUD.
export default defineConfig({
  // Quick tunnels present an arbitrary *.trycloudflare.com Host header; Vite 6 rejects
  // unrecognised hosts by default.
  server: { port: 5175, allowedHosts: ['.trycloudflare.com'] },
  build: { target: 'es2022' },
})

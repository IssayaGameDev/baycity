import { defineConfig } from 'vite'

// Throwaway M10 demo app (3D TPS character controller). Target ES2022 for the
// top-level await used to init the physics/HUD.
export default defineConfig({
  server: { port: 5174 },
  build: { target: 'es2022' },
})

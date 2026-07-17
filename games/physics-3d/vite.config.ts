import { defineConfig } from 'vite'

// Throwaway M7 demo app. Vite serves the @mp/* workspace packages from source; no
// stack build step. Target ES2022 so top-level await (HUD init) is allowed.
export default defineConfig({
  server: { port: 5173 },
  build: { target: 'es2022' },
})

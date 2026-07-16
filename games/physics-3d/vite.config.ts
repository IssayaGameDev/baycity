import { defineConfig } from 'vite'

// Throwaway M3 demo app. Vite serves the @mp/* workspace packages (including
// render-three and three) straight from source; no stack build step.
export default defineConfig({
  server: { port: 5173 },
})

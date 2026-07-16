import { defineConfig } from 'vite'

// Throwaway M2 demo app. Vite serves the @mp/* workspace packages straight from
// their TypeScript sources (source-first exports), so there is no build step for
// the stack itself.
export default defineConfig({
  server: { port: 5173 },
})

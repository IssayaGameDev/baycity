import { defineConfig } from 'vite'

// Localhost content viewer/inspector (content pipeline C4). ES2022 for top-level await
// (physics init). Own port so it can run alongside the game + server.
export default defineConfig({
  server: { port: 5175 },
  build: { target: 'es2022' },
})

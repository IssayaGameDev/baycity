import { defineConfig } from 'vite'

import { contentAlias, contentBanner } from '../../content-root'

// Localhost content viewer/inspector (content pipeline C4). ES2022 for top-level await
// (physics init). Own port so it can run alongside the game + server.
export default defineConfig({
  plugins: [contentBanner()],
  resolve: { alias: contentAlias() },
  server: { port: 5175 },
  build: { target: 'es2022' },
})

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 'forks' (child processes) keeps the native uWebSockets.js addon and real
    // sockets used by the end-to-end test well-isolated per test file.
    pool: 'forks',
    include: ['packages/*/src/**/*.test.ts'],
  },
})

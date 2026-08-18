import { defineConfig } from 'vitest/config'

const ALL = '{packages,tools,modes}/*/src/**/*.test.ts'
const LIVE_SERVER = 'tools/bots/src/matchmaking.test.ts'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          // 'forks' (child processes) keeps native addons and real sockets well-isolated per file.
          pool: 'forks',
          include: [ALL],
          exclude: [LIVE_SERVER],
        },
      },
      {
        test: {
          name: 'live-server',
          /**
           * Threads, not forks, for the one test that boots a real Colyseus server in-process.
           * `@colyseus/core`'s `Stats.reset()` imports `@pm2/io` on boot, and its transport announces
           * itself with `process.send(...)` — which in a vitest **fork** is vitest's own IPC channel,
           * so the pool receives a message it cannot deserialize and the run dies before any
           * assertion. A worker thread has no `process.send` at all (IPC belongs to the parent
           * process), so @pm2/io finds no channel and stays quiet.
           *
           * Aliasing `@pm2/io` to a stub does not work: Vite externalizes node_modules, so Node
           * resolves that dynamic import, not Vite.
           */
          pool: 'threads',
          include: [LIVE_SERVER],
        },
      },
    ],
  },
})

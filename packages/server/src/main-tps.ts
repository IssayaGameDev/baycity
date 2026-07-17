import { DEFAULT_PORT, startServer } from './index'

// Convenience entry that runs the TPS world (M10). Same as `MODE=tps tsx main.ts`.
const port = Number(process.env.PORT ?? DEFAULT_PORT)

startServer({ port, mode: 'tps' })
  .then((h) => {
    console.log(`[server] mode=tps listening on ws://localhost:${h.port}`)
  })
  .catch((err: unknown) => {
    console.error('[server] failed to start:', err)
    process.exit(1)
  })

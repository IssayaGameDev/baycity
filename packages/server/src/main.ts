import { DEFAULT_PORT, startServer } from './index'

const port = Number(process.env.PORT ?? DEFAULT_PORT)

startServer({ port })
  .then((h) => {
    console.log(`[server] client-authoritative relay listening on ws://localhost:${h.port}`)
  })
  .catch((err: unknown) => {
    console.error('[server] failed to start:', err)
    process.exit(1)
  })

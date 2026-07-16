import { DEFAULT_PORT, startServer } from './index'

const port = Number(process.env.PORT ?? DEFAULT_PORT)

startServer({ port })
  .then((h) => {
    console.log(`[server] walking-skeleton listening on ws://localhost:${h.port}`)
  })
  .catch((err: unknown) => {
    console.error('[server] failed to start:', err)
    process.exit(1)
  })

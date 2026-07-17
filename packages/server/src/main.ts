import { DEFAULT_PORT, startServer, type GameMode } from './index'

const port = Number(process.env.PORT ?? DEFAULT_PORT)
const mode: GameMode = process.env.MODE === 'tps' ? 'tps' : 'ball'

startServer({ port, mode })
  .then((h) => {
    console.log(`[server] mode=${mode} listening on ws://localhost:${h.port}`)
  })
  .catch((err: unknown) => {
    console.error('[server] failed to start:', err)
    process.exit(1)
  })

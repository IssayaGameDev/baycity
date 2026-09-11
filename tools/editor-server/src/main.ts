import { loadConfig } from './config'
import { startEditorServer } from './server'

/**
 * `pnpm --filter @mp/editor-server run start <config.json>` — or `EDITOR_SERVER_CONFIG=<path>`.
 * See `deploy/editor/editor-server.config.example.json` for every field.
 */
const file = process.argv[2] ?? process.env.EDITOR_SERVER_CONFIG
if (file === undefined) {
  console.error('usage: tsx src/main.ts <config.json>  (or EDITOR_SERVER_CONFIG=<path>)')
  process.exit(2)
}

const app = startEditorServer(loadConfig(file))

// A restart (deploy) or a stop commits every session first: nothing on disk is lost either way, but history
// should not owe anyone a commit.
const stop = (): void => {
  void app.close().then(
    () => process.exit(0),
    () => process.exit(1),
  )
  setTimeout(() => process.exit(1), 30_000).unref()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)

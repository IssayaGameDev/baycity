import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

// By *relative source path*, not as `@mp/editor-server`: Vite loads its config through plain Node, which
// cannot load a workspace package whose entry is a `.ts` file. Bundled into the config instead.
import { REPO_CONTENT, contentAlias } from '../../content-root'
import { createContentApi } from '../editor-server/src/api'
import { DEFAULTS } from '../editor-server/src/config'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The content API, in the dev server (ADR 0083).
 *
 * The same handlers the hosted editor runs (`tools/editor-server`), with no login — every request is `local`
 * — and no git: what is on disk is the working copy Kodjo commits himself. Locks still work in-process, so the
 * editor's lock code runs the same way against both; with one person here they never refuse.
 */
const filesApi = (): Plugin => ({
  name: 'files-api',
  configureServer(server) {
    const local = { name: 'local', email: 'local@localhost' }
    const api = createContentApi({
      repoRoot: ROOT,
      identify: async () => local,
      locks: {},
      rules: { staleMs: DEFAULTS.lockStaleMs, heartbeatMs: DEFAULTS.heartbeatMs, maxUploadBytes: DEFAULTS.maxUploadBytes },
    })
    server.middlewares.use((req, res, next) => {
      void api(req, res).then(
        (handled) => {
          if (!handled) next()
        },
        (e: unknown) => {
          res.statusCode = 500
          res.end(String(e instanceof Error ? e.message : e))
        },
      )
    })
  },
})

// Localhost level/prefab editor. Own port so it runs alongside the game/server/viewer.
export default defineConfig({
  plugins: [filesApi()],
  // Always the repo's content/: the dev editor edits that folder, never the mirror (ADR 0084).
  resolve: { alias: contentAlias(REPO_CONTENT) },
  /**
   * `content/games` is imported by every game's `rules.ts`, which the editor bundles (`modes.ts`), so a write
   * to it would be a full page reload of the editor — losing the undo history — right after the editor itself
   * wrote it. The editor reads those files live over `/api/games` instead (ADR 0077); the game's own dev server
   * still watches them and reloads, which is the reload that matters.
   */
  server: { port: 5176, watch: { ignored: ['**/content/games/**'] } },
  // `app/`, not Vite's default `assets/`: that prefix is the content API's asset route (ADR 0083).
  build: { target: 'es2022', assetsDir: 'app' },
})

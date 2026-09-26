import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

// By *relative source path*, not as `@mp/editor-server`: Vite loads its config through plain Node, which
// cannot load a workspace package whose entry is a `.ts` file. Bundled into the config instead.
import { REPO_CONTENT, contentAlias } from '../../content-root'
import { createContentApi } from '../editor-server/src/api'
import { createAssetIndex } from '../editor-server/src/assetIndex'
import { createChangeFeed } from '../editor-server/src/changes'
import { DEFAULTS } from '../editor-server/src/config'
import { createLive, levelPath } from '../editor-server/src/live'
import { liveAssetFiles } from '../editor-server/src/liveAssetFiles'
import { createLiveAssets } from '../editor-server/src/liveAssets'
import { createPrefabStore } from '../editor-server/src/prefabStore'
import { SHARED_GAMES } from '../share/src/index'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** One asset list for the API and the prefab store, as on the box (ADR 0156). */
const assets = createAssetIndex(join(ROOT, 'content'))
/**
 * The change feed, as on the box: the editor watches it for other people's asset changes (ADR 0156). Without
 * one the watch would be answered at once, every time, and spin.
 */
const feed = createChangeFeed()

/** The live level sessions of this dev server (ADR 0089): the same code as the box, files on this disk. */
const live = createLive({
  // `levelPath` is the one rule for where a level lives: its game's folder (ADR 0108).
  readLevel: (name) => {
    const file = join(ROOT, levelPath(name))
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : null
  },
  writeLevel: (name, level) => {
    const file = join(ROOT, levelPath(name))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(level, null, 2)}\n`)
  },
  changed: (_users, path) => feed.record([path]),
  // A level references a prefab by asset id (ADR 0091); the definitions come off this disk.
  prefabs: createPrefabStore(join(ROOT, 'content'), assets),
})
/** Data-file assets edited live, as on the box (ADR 0159). */
const liveAssets = createLiveAssets({
  ...liveAssetFiles(join(ROOT, 'content'), assets),
  changed: (_users, path) => feed.record([path]),
  connection: (connId) => live.connection(connId),
  broadcast: (event, data) => live.broadcastAll(event, data),
})
let sweeper: ReturnType<typeof setInterval> | null = null

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
    // Dev server only, and never holding the process open: vitest loads this config too.
    if (sweeper === null) sweeper = setInterval(() => live.sweep(), 60_000).unref()
    const local = { name: 'local', email: 'local@localhost' }
    const api = createContentApi({
      repoRoot: ROOT,
      identify: async () => local,
      rules: { heartbeatMs: DEFAULTS.heartbeatMs, maxUploadBytes: DEFAULTS.maxUploadBytes },
      // Play frames the game's own dev server on this machine (ADR 0086): `pnpm dev:<game>` has to be running.
      games: Object.fromEntries(SHARED_GAMES.map((g) => [g.name, `http://localhost:${g.port}/`])),
      // Levels are edited live here too (ADR 0089): the same session code, one person, files on this disk.
      live,
      changes: feed,
      assets,
      liveAssets,
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
   * `content/<game>/game.json` is imported by every game's `rules.ts`, which the editor bundles (`modes.ts`), so a write
   * to it would be a full page reload of the editor — losing the undo history — right after the editor itself
   * wrote it. The editor reads those files live over `/api/games` instead (ADR 0077); the game's own dev server
   * still watches them and reloads, which is the reload that matters.
   */
  // A game's own files too: the live session writes those every few seconds, and the editor does not import them.
  server: { port: 5176, watch: { ignored: ['**/content/*/game.json', '**/content/*/levels/**'] } },
  // `app/`, not Vite's default `assets/`: the built editor's own files, kept apart from content's (`/content/`, ADR 0161).
  build: { target: 'es2022', assetsDir: 'app' },
})

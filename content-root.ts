import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Where the browser apps read `content/` from (ADR 0084).
 *
 * Every game, the viewer and the editor bundle content with `import.meta.glob('@content/...')`. The alias
 * points at the repo's `content/` — master's, merged in from the `content` branch — unless `MP_CONTENT_ROOT` in
 * the root `.env` names another folder: the live mirror `pnpm sync:content` writes, so a save on the hosted
 * editor reloads the local game within a second.
 *
 * Imported by relative path from each `vite.config.ts` (a root file, not a package — Vite bundles it into the
 * config). Tests always take the repo's `content/`, whatever `.env` says.
 */
export const REPO_ROOT = fileURLToPath(new URL('.', import.meta.url))

const envFile = resolve(REPO_ROOT, '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

export const REPO_CONTENT = resolve(REPO_ROOT, 'content')

/** The configured root, or the repo's `content/` when the configured one does not exist yet (with a warning). */
export const contentRoot = (): string => {
  const wanted = process.env.MP_CONTENT_ROOT
  if (wanted === undefined || wanted === '') return REPO_CONTENT
  const abs = resolve(REPO_ROOT, wanted)
  if (existsSync(abs)) return abs
  console.warn(`MP_CONTENT_ROOT=${wanted} does not exist — run \`pnpm sync:content\`; using content/ meanwhile`)
  return REPO_CONTENT
}

/** `resolve.alias` entry for a Vite config. */
export const contentAlias = (root: string = contentRoot()): Record<string, string> => ({ '@content': root })

/** What the mirror wrote last, if this root is one. */
const mirrorAge = (root: string): string | null => {
  const stamp = resolve(root, '.sync.json')
  if (!existsSync(stamp)) return null
  try {
    const { at } = JSON.parse(readFileSync(stamp, 'utf8')) as { at: string }
    const s = Math.round((Date.now() - new Date(at).getTime()) / 1000)
    return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`
  } catch {
    return 'unreadable .sync.json'
  }
}

/**
 * A Vite plugin that says which content the dev server bundles, and how fresh the mirror is — the one thing you
 * would otherwise not notice when `pnpm sync:content` is not running.
 */
export const contentBanner = (root: string = contentRoot()): { name: string; configureServer: (server: { config: { logger: { info: (msg: string) => void; warn: (msg: string) => void } } }) => void } => ({
  name: 'content-banner',
  configureServer(server) {
    const rel = root.startsWith(REPO_ROOT) ? root.slice(REPO_ROOT.length) : root
    if (root === REPO_CONTENT) {
      server.config.logger.info(`content: ${rel} (the repo's, master)`)
      return
    }
    const age = mirrorAge(root)
    if (age === null) server.config.logger.warn(`content: ${rel} — no .sync.json; is pnpm sync:content running?`)
    else server.config.logger.info(`content: ${rel} (live mirror, synced ${age})`)
  },
})

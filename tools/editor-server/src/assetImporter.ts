import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// Imported by *relative source path*, not as `@mp/content`. This module is reached from vite.config.ts,
// and Vite loads its own config through plain Node — which cannot load a workspace package whose entry is
// a `.ts` file. A relative path is bundled into the config instead, so the extension→kind mapping stays a
// single definition rather than being copied into the dev server.
import {
  entriesFrom,
  kindForPath,
  META_SUFFIX,
  type AssetEntry,
  type AssetKind,
  type AssetMeta,
} from '../../../packages/content/src/assets'
import { ASSETS_DIR, isGameName, libraryDir } from '../../../packages/content/src/layout'

/**
 * The importer: scans every asset library and makes sure every asset has an identity.
 *
 * **Every library in one pass** (ADR 0161) — the shared one and each game's own — so an id is unique across all of
 * them: a file copied from one library into another with its sidecar is two files, and the second is reissued.
 * Paths come out relative to `content/`, starting with their library.
 *
 * An asset's id lives in a `.meta` sidecar beside it, written once and never re-derived — that is what
 * makes a reference survive renaming and moving the file. Deriving an id from the path or the contents
 * would look tidier and defeat the entire purpose.
 *
 * Node-only (it writes files); the dev server runs it, and the game reads the sidecars it produced.
 */
export interface ImportedAssets {
  entries: AssetEntry[]
  /** Sidecars written this pass — new assets, plus any whose id had to be reissued. */
  created: string[]
}

const freshId = (): string => randomBytes(8).toString('hex')

const readMeta = (file: string): AssetMeta | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const id = (parsed as { id?: unknown }).id
      const kind = (parsed as { kind?: unknown }).kind
      if (typeof id === 'string' && id !== '' && typeof kind === 'string') return { id, kind: kind as AssetKind }
    }
  } catch {
    // Unreadable or malformed: treated as absent, and rewritten below.
  }
  return undefined
}

const walk = (dir: string, out: string[]): void => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
}

/**
 * The libraries under `content/`, as content-relative folders: the shared one, always (made if missing), then each
 * game folder's `assets/` that exists, name-sorted.
 */
export const libraryFolders = (contentDir: string): string[] => {
  const shared = join(contentDir, ASSETS_DIR)
  if (!existsSync(shared)) mkdirSync(shared, { recursive: true })
  const own = (game: string): boolean => {
    const dir = join(contentDir, game, ASSETS_DIR)
    return existsSync(dir) && statSync(dir).isDirectory()
  }
  const games = readdirSync(contentDir).filter((name) => isGameName(name) && own(name)).sort()
  return [libraryDir(null), ...games.map((g) => libraryDir(g))]
}

export const importAssets = (contentDir: string): ImportedAssets => {
  const files: string[] = []
  for (const library of libraryFolders(contentDir)) walk(join(contentDir, library), files)
  files.sort() // stable order, so the panel and the manifest do not reshuffle between scans

  const pairs: [string, AssetMeta][] = []
  const created: string[] = []
  const seen = new Set<string>()

  for (const full of files) {
    const path = relative(contentDir, full).split('\\').join('/')
    const kind = kindForPath(path)
    if (kind === undefined) continue

    const metaFile = `${full}${META_SUFFIX}`
    const existing = readMeta(metaFile)

    // A duplicated asset usually arrives with its sidecar duplicated too, which would give two files one
    // identity and make every reference ambiguous. First one keeps the id; the rest are reissued.
    const reissue = existing === undefined || seen.has(existing.id)
    const id = reissue ? freshId() : existing.id

    // The file's extension decides the kind, not the sidecar: renaming .png to .glb changes what it is.
    if (reissue || existing.kind !== kind) {
      writeFileSync(metaFile, `${JSON.stringify({ id, kind } satisfies AssetMeta, null, 2)}\n`)
      created.push(`${path}${META_SUFFIX}`)
    }

    seen.add(id)
    pairs.push([path, { id, kind }])
  }

  // Assembled by the shared function rather than here, so the editor and the game cannot disagree about
  // what an entry is.
  return { entries: entriesFrom(pairs), created }
}

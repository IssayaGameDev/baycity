import { validateLevel, type Level } from '@mp/content'
import { DEFAULT_REGISTRY, type Registry } from '@mp/components'

/**
 * Client for the dev-server level API (see vite.config.ts).
 *
 * Levels only. Prefabs used to live here too; they are **assets** now (`*.prefab.json` under
 * `content/assets/`), which gives them ids that survive a rename, folders, and previews — see `assetsApi.ts`.
 */
export type FileKind = 'levels'

const req = async (kind: FileKind, path = '', init?: RequestInit): Promise<Response> => {
  const r = await fetch(`/api/${kind}${path}`, init)
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} /api/${kind}${path} → ${r.status}`)
  return r
}

/** One level on disk, as a listing needs it: its file name and the game it declares (ADR 0052). */
export interface FileEntry {
  name: string
  /** Absent for a level that names no game, and for one whose file will not parse. */
  mode?: string
}

export const listFiles = async (kind: FileKind): Promise<FileEntry[]> => (await req(kind)).json() as Promise<FileEntry[]>

/**
 * Validated **with the registry**, so a bad component parameter is a load error rather than a broken panel.
 *
 * *Which* registry is the level's own business: it names a game, and that game declares the components it may
 * use (ADR 0052). So the structure is read first, `registryFor` resolves the game, and the parameters are
 * checked against it. A level naming a game this build does not have falls back to everything the build knows,
 * because the alternative is refusing to open a file over a missing sibling app.
 */
export const loadLevel = async (name: string, registryFor?: (mode: string) => Registry | undefined): Promise<Level> => {
  const raw = (await (await req('levels', `/${name}`)).json()) as { config?: { mode?: { name?: unknown } } }
  const mode = typeof raw.config?.mode?.name === 'string' ? raw.config.mode.name : undefined
  const registry = (mode === undefined ? undefined : registryFor?.(mode)) ?? DEFAULT_REGISTRY
  return validateLevel(raw, registry)
}

export const saveFile = async (kind: FileKind, name: string, data: unknown): Promise<void> => {
  await req(kind, `/${name}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
}

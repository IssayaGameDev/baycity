import { validateLevel, type Level } from '@mp/content'

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

export const listFiles = async (kind: FileKind): Promise<string[]> => (await req(kind)).json() as Promise<string[]>

export const loadLevel = async (name: string): Promise<Level> => validateLevel(await (await req('levels', `/${name}`)).json())

export const saveFile = async (kind: FileKind, name: string, data: unknown): Promise<void> => {
  await req(kind, `/${name}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
}

import { validateLevel, type Level, type Prefab } from '@mp/content'

/** Client for the dev-server file API (see vite.config.ts). */
export type FileKind = 'levels' | 'prefabs'

const req = async (kind: FileKind, path = '', init?: RequestInit): Promise<Response> => {
  const r = await fetch(`/api/${kind}${path}`, init)
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} /api/${kind}${path} → ${r.status}`)
  return r
}

export const listFiles = async (kind: FileKind): Promise<string[]> => (await req(kind)).json() as Promise<string[]>

export const loadLevel = async (name: string): Promise<Level> => validateLevel(await (await req('levels', `/${name}`)).json())

// Prefabs are authored by us; a light structural check (full types live in TS).
export const loadPrefab = async (name: string): Promise<Prefab> => {
  const data: unknown = await (await req('prefabs', `/${name}`)).json()
  if (typeof data !== 'object' || data === null || !Array.isArray((data as { pieces?: unknown }).pieces))
    throw new Error(`prefab "${name}": expected { id, pieces: [...] }`)
  return data as Prefab
}

export const saveFile = async (kind: FileKind, name: string, data: Level | Prefab): Promise<void> => {
  await req(kind, `/${name}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
}

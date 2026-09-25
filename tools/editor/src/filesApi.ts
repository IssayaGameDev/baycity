import { levelFile, parseQualified, validateLevel, type Level } from '@mp/content'
import { DEFAULT_REGISTRY, type Registry } from '@mp/components'
import { normalizePoints, type CurvePoint } from '@mp/mode'

/**
 * Client for the content API (`tools/editor-server/src/api.ts`, ADR 0083) — the same routes whether the
 * editor is the dev server on localhost or the hosted one behind Cloudflare Access.
 *
 * Levels, games, identity, locks and upload live here. Prefabs, materials and clips are **assets**
 * (`assetsApi.ts`), which gives them ids that survive a rename, folders, and previews.
 */
export type FileKind = 'levels' | 'games'

/** A refused request, with what the server said. `status` 423 is a lock held by someone else. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Who holds the lock, on a 423. */
    readonly owner: string | null = null,
  ) {
    super(message)
  }
}

/** Throw the server's reason rather than a bare status, so a warning can say "locked by Ada". */
export const failed = async (r: Response, what: string): Promise<never> => {
  const detail = (await r.json().catch(() => ({}))) as { error?: string; owner?: { name?: string } }
  throw new ApiError(r.status, detail.error ?? `${what} → ${r.status}`, detail.owner?.name ?? null)
}

const req = async (kind: FileKind, path = '', init?: RequestInit): Promise<Response> => {
  const r = await fetch(`/api/${kind}${path}`, init)
  if (!r.ok) await failed(r, `${init?.method ?? 'GET'} /api/${kind}${path}`)
  return r
}

/** One level on disk, as a listing needs it: its qualified name and the game whose folder it is in. */
export interface FileEntry {
  /** `<game>/<name>` (ADR 0108) — what every route, lock key and live document key calls this level. */
  name: string
  /**
   * The game this level belongs to, which is now the **folder it is in** (ADR 0108) and so is always
   * present. It used to come from `config.mode.name` inside the file, and was therefore absent for a level
   * that named no game and for one that would not parse.
   */
  mode?: string
  /**
   * The asset ids of every prefab this level references (ADR 0097). Absent when it references none, and for
   * one whose file will not parse.
   *
   * Reported in the pass the server already makes over every level file, which is what makes "N levels use
   * this" cheap enough to put in front of a delete.
   */
  prefabs?: string[]
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

/** The level as it is on disk, unvalidated — for the caller that has to look at it before choosing a registry. */
export const loadLevelRaw = async (name: string): Promise<unknown> => (await req('levels', `/${name}`)).json()

/** A game's data file: its shared-component list (ADR 0077) and its settings (ADR 0087/0088: numbers or curve points). */
export interface GameData {
  components: string[]
  settings: Record<string, number | CurvePoint[]>
}

export const loadGame = async (name: string): Promise<GameData> => {
  const r = await fetch(`/api/games/${name}`)
  if (r.status === 404) return { components: [], settings: {} }
  if (!r.ok) await failed(r, `GET /api/games/${name}`)
  const raw = (await r.json()) as { components?: unknown; settings?: unknown }
  const settings: Record<string, number | CurvePoint[]> = {}
  if (typeof raw.settings === 'object' && raw.settings !== null) {
    for (const [k, v] of Object.entries(raw.settings as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) settings[k] = v
      else {
        const pts = normalizePoints(v)
        if (pts !== null) settings[k] = pts
      }
    }
  }
  return { components: Array.isArray(raw.components) ? raw.components.filter((c): c is string => typeof c === 'string') : [], settings }
}

export const saveGame = (name: string, data: GameData): Promise<void> => saveFile('games', name, data)

/**
 * Rename a level, both names qualified `<game>/<name>` (ADR 0110). A `to` in another game moves it there,
 * because the folder is the game.
 *
 * 409 while anyone has it open live: the open document would write the old file straight back.
 */
export const renameLevel = async (from: string, to: string): Promise<void> => {
  await postOrFail('/api/levels/move', { from, to }, `rename ${from}`)
}

/** Delete a level for good (ADR 0110). 409 while it is open live. */
export const deleteLevel = async (path: string): Promise<void> => {
  await postOrFail('/api/levels/delete', { path }, `delete ${path}`)
}

const postOrFail = async (url: string, body: unknown, what: string): Promise<void> => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) await failed(r, what)
}

export const saveFile = async (kind: FileKind, name: string, data: unknown): Promise<void> => {
  await req(kind, `/${name}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
}

// --- identity, locks, upload (ADR 0083) ---

/** Who the server thinks you are, and the rules it runs by. */
export interface Me {
  user: { name: string; email: string }
  heartbeatMs: number
  lockStaleMs: number
  maxUploadBytes: number
  /** Game name → where its playable page is, for Play to frame (ADR 0086). Relative to this origin or absolute. */
  games: Record<string, string>
}

const getJson = async <T>(url: string): Promise<T> => {
  const r = await fetch(url)
  if (!r.ok) await failed(r, `GET ${url}`)
  return (await r.json()) as T
}

const postJson = async <T>(url: string, body: unknown): Promise<T> => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) await failed(r, `POST ${url}`)
  return (await r.json()) as T
}

export const me = (): Promise<Me> => getJson('/api/me')

export interface ServerStatus {
  /** The last push's failure, or `null`. Kodjo's to fix; shown so a session knows its commits are not on GitHub yet. */
  pushError: string | null
  locks: { path: string; owner: string; since: number }[]
}

export const serverStatus = (): Promise<ServerStatus> => getJson('/api/status')

/**
 * Repo-relative keys the lock table is indexed by — the same strings the server's `keyFor` makes. A lock is on
 * a *file*, so what the editor writes is what it locks: the level, the prefab asset, the material, the clip.
 */
export const lockKey = {
  /** `name` is the qualified `<game>/<name>` (ADR 0108). */
  level: (name: string): string => {
    const ref = parseQualified(name)
    return ref === null ? `content/${name}` : `content/${levelFile(ref)}`
  },
  /** `path` is from `content/`, starting with its library (ADR 0161). */
  asset: (path: string): string => `content/${path}`,
}

/** Take a lock. Resolves the holder's name when someone else has it live, `null` when it is yours. */
export const acquireLock = async (path: string): Promise<string | null> => {
  const r = await postJson<{ ok: boolean; owner?: { name: string } }>('/api/locks/acquire', { path })
  return r.ok ? null : (r.owner?.name ?? 'someone')
}

export const releaseLock = (path: string): Promise<unknown> => postJson('/api/locks/release', { path })

/** Fire-and-forget release for a closing tab: the request outlives the page. */
export const releaseLockBeacon = (path: string): void => {
  navigator.sendBeacon('/api/locks/release', new Blob([JSON.stringify({ path })], { type: 'application/json' }))
}

/** Refresh every lock you hold. Resolves the ones the server no longer thinks are yours. */
export const heartbeatLocks = async (paths: readonly string[]): Promise<string[]> =>
  (await postJson<{ lost: string[] }>('/api/locks/heartbeat', { paths })).lost

/** Upload a texture or a `.glb` to `path` under the assets root. Same path replaces the file and keeps its id. */
export const uploadAsset = async (path: string, file: Blob): Promise<void> => {
  const r = await fetch(`/api/assets/upload?path=${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  })
  if (!r.ok) await failed(r, `upload ${path}`)
}

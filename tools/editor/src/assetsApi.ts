import type { Origin } from './assetSync'
import { failed } from './filesApi'
import {
  buildDatabase,
  libraryDir,
  type AssetDatabase,
  type AssetEntry,
  type MaterialAsset,
  type Node,
} from '@mp/content'

/**
 * Client for the dev server's asset routes (see vite.config.ts).
 *
 * Materials and prefabs are fetched eagerly and kept in memory. They are tiny JSON, and it
 * makes `materialOf` and `prefabOf` synchronous — which the material compiler and the loader both need, since
 * compiling and instantiating are pure steps after the preload pass rather than things that await
 * mid-scene-build.
 */
export interface AssetLibrary {
  db: AssetDatabase
  /** The asset libraries on disk, by folder from `content/` (ADR 0161): the shared one first, then each game's own. */
  libraries: string[]
  /** Folders on disk, including empty ones — the tree needs those and no path implies them. From `content/`. */
  folders: string[]
  /** Where the server's change feed stood when this list was read: what a watch starts from (ADR 0156). */
  seq: number
  /** A file's size and when it last changed (ADR 0165), by path; `undefined` when the server did not say. */
  fileOf: (path: string) => FileFacts | undefined
  /** URL the bytes of an asset are served from. */
  urlOf: (path: string) => string
  urlOfId: (assetId: string) => string | null
  /** A loaded material's JSON, by asset id. */
  materialOf: (assetId: string) => MaterialAsset | undefined
  /** A loaded prefab asset's JSON, by asset id. */
  prefabOf: (assetId: string) => Node | undefined
  /**
   * Where a material's copy came from (ADR 0159): the server process that numbered it and how many live edits
   * it holds — `seq` 0 for the file. `undefined` when the server did not say.
   */
  originOf: (assetId: string) => Origin | undefined
  /**
   * Replace a material in memory — what `assetSync.ts` shows. Nothing is written: a material is a live document
   * on the server, edited by ops (ADR 0159).
   */
  setMaterial: (assetId: string, material: MaterialAsset) => void
  /** A material's live copy from the server, and where it stands. */
  fetchLive: (assetId: string) => Promise<{ json: unknown; origin: Origin } | null>
  /**
   * Fetch one prefab again, as it is now — the server answers with its live copy when the prefab is open, so it
   * has everyone's edits since this library loaded. What placing one reads.
   */
  refreshPrefab: (assetId: string) => Promise<void>
  /** Overwrite a prefab asset on disk and in memory. */
  savePrefab: (assetId: string, prefab: Node) => Promise<void>
  /** Write a prefab to a path in a library (from `content/`), creating it. Returns its entry after a rescan. */
  createPrefab: (path: string, prefab: Node) => Promise<AssetEntry | undefined>
  mkdir: (parent: string, name: string) => Promise<void>
  /** Rename or move. The sidecar goes with it, so ids survive. */
  move: (from: string, to: string) => Promise<void>
  remove: (path: string) => Promise<void>
  /** Create `<name>.mat.json` in `folder` (from `content/`; the shared library's `materials` by default). Resolves once the importer has given it an id. */
  createMaterial: (name: string, material: MaterialAsset, folder?: string) => Promise<AssetEntry | undefined>
}

/** Where an asset's bytes are served: its path from `content/`, as on disk (ADR 0161). */
export const assetUrl = (path: string): string => `/content/${path}`

const fetchJson = async <T>(url: string): Promise<T> => {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`)
  return (await r.json()) as T
}

/** A JSON asset and where it came from, off the headers every live asset's GET carries (ADR 0159). */
const fetchWithOrigin = async (url: string): Promise<{ json: unknown; origin: Origin | undefined }> => {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`)
  const epoch = r.headers.get('x-asset-epoch')
  const seq = r.headers.get('x-asset-seq')
  const origin = epoch === null || seq === null ? undefined : { epoch: Number(epoch), seq: Number(seq) }
  return { json: (await r.json()) as unknown, origin }
}

/** A file's size in bytes, and when it last changed, in ms since the epoch (ADR 0165). */
export interface FileFacts {
  bytes: number
  modified: number
}

/** Who uses an asset (ADR 0165): the levels, qualified, and the assets, by id — directly or through others. */
export const fetchUsers = async (assetId: string): Promise<{ levels: string[]; assets: string[] } | null> => {
  const r = await fetch(`/api/assets/users?id=${encodeURIComponent(assetId)}`).catch(() => null)
  if (r === null || !r.ok) return null
  const body = (await r.json().catch(() => null)) as { levels?: unknown; assets?: unknown } | null
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])
  return body === null ? null : { levels: strings(body.levels), assets: strings(body.assets) }
}

const isMaterial = (v: unknown): v is MaterialAsset =>
  typeof v === 'object' && v !== null && typeof (v as { shader?: unknown }).shader === 'string'

/** A prefab file is a **root node** since stage C1: a `components` array is what tells it from a material. */
const isPrefab = (v: unknown): v is Node =>
  typeof v === 'object' && v !== null && Array.isArray((v as { components?: unknown }).components)

const post = async (route: string, body: unknown): Promise<void> => {
  const r = await fetch(`/api/assets/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) await failed(r, route)
}

/**
 * Fetch the database and every JSON asset in it.
 *
 * With `reuse`, a material or prefab that library already holds, at the same path, is kept rather than fetched
 * — unless its path is in `refetch`, the paths the server says changed (ADR 0156). So a change somebody else
 * made costs its own file, not the whole library.
 */
export const loadAssetLibrary = async (opts: { reuse?: AssetLibrary | null; refetch?: ReadonlySet<string> } = {}): Promise<AssetLibrary> => {
  const { entries, libraries, folders, seq, files } = await fetchJson<{
    entries: AssetEntry[]
    libraries?: string[]
    folders: string[]
    seq?: number
    files?: Record<string, FileFacts>
  }>('/api/assets')
  const db = buildDatabase(entries)
  const materials = new Map<string, MaterialAsset>()
  const origins = new Map<string, Origin>()
  const prefabs = new Map<string, Node>()
  const reuse = opts.reuse ?? null
  const kept = (e: AssetEntry): boolean => reuse !== null && reuse.db.byId[e.id]?.path === e.path && opts.refetch?.has(e.path) !== true

  // Both are small JSON and both are needed synchronously — a material to compile, a prefab to preview or
  // place — so they are fetched up front rather than on demand.
  await Promise.all(
    entries
      .filter((e) => e.kind === 'material' || e.kind === 'prefab')
      .map(async (e) => {
        if (kept(e)) {
          const held = e.kind === 'material' ? reuse?.materialOf(e.id) : reuse?.prefabOf(e.id)
          if (held !== undefined) {
            if (e.kind === 'material') {
              materials.set(e.id, held as MaterialAsset)
              const o = reuse?.originOf(e.id)
              if (o !== undefined) origins.set(e.id, o)
            } else prefabs.set(e.id, held as Node)
            return
          }
        }
        try {
          const { json: parsed, origin } = await fetchWithOrigin(assetUrl(e.path))
          if (e.kind === 'material') {
            if (isMaterial(parsed)) {
              materials.set(e.id, parsed)
              if (origin !== undefined) origins.set(e.id, origin)
            } else console.warn(`material ${e.path}: no shader`)
          } else if (isPrefab(parsed)) prefabs.set(e.id, parsed)
          else console.warn(`prefab ${e.path}: no pieces`)
        } catch (err) {
          console.warn(`${e.kind} ${e.path}: ${String(err)}`)
        }
      }),
  )

  const put = async (path: string, body: unknown): Promise<void> => {
    const r = await fetch(assetUrl(path), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) await failed(r, `PUT ${path}`)
  }

  const rescan = async (path: string): Promise<AssetEntry | undefined> => {
    // The id is the importer's to assign, so a new file only has one after a rescan.
    const { entries: rescanned } = await fetchJson<{ entries: AssetEntry[] }>('/api/assets')
    return rescanned.find((e) => e.path === path)
  }

  return {
    db,
    libraries: libraries ?? [libraryDir(null)],
    folders,
    seq: seq ?? 0,
    fileOf: (path) => files?.[path],
    urlOf: assetUrl,
    urlOfId: (id) => {
      const entry = db.byId[id]
      return entry === undefined ? null : assetUrl(entry.path)
    },
    materialOf: (id) => materials.get(id),
    prefabOf: (id) => prefabs.get(id),
    originOf: (id) => origins.get(id),
    setMaterial: (id, material) => void materials.set(id, material),
    fetchLive: async (id) => {
      const entry = db.byId[id]
      if (entry === undefined) return null
      const { json, origin } = await fetchWithOrigin(assetUrl(entry.path))
      return origin === undefined ? null : { json, origin }
    },
    createMaterial: async (name, material, folder = `${libraryDir(null)}/materials`) => {
      const safe = name.replace(/[^\w-]+/g, '-') || 'material'
      const path = `${folder}/${safe}.mat.json`
      await put(path, material)
      return rescan(path)
    },
    refreshPrefab: async (id) => {
      const entry = db.byId[id]
      if (entry === undefined || entry.kind !== 'prefab') return
      const parsed = await fetchJson<unknown>(assetUrl(entry.path))
      if (isPrefab(parsed)) prefabs.set(id, parsed)
    },
    savePrefab: async (id, prefab) => {
      const entry = db.byId[id]
      if (entry === undefined) throw new Error(`prefab ${id}: not in the database`)
      await put(entry.path, prefab)
      prefabs.set(id, prefab)
    },
    createPrefab: async (path, prefab) => {
      await put(path, prefab)
      return rescan(path)
    },
    mkdir: async (parent, name) => post('mkdir', { path: `${parent}/${name}` }),
    move: async (from, to) => post('move', { from, to }),
    remove: async (path) => post('delete', { path }),
  }
}

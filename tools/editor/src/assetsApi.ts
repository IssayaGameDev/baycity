import { failed } from './filesApi'
import {
  buildDatabase,
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
  /** Folders on disk, including empty ones — the tree needs those and no path implies them. */
  folders: string[]
  /** URL the bytes of an asset are served from. */
  urlOf: (path: string) => string
  urlOfId: (assetId: string) => string | null
  /** A loaded material's JSON, by asset id. */
  materialOf: (assetId: string) => MaterialAsset | undefined
  /** A loaded prefab asset's JSON, by asset id. */
  prefabOf: (assetId: string) => Node | undefined
  /** Overwrite a material on disk and in memory. */
  saveMaterial: (assetId: string, material: MaterialAsset) => Promise<void>
  /**
   * Fetch one prefab again, as it is now — the server answers with its live copy when the prefab is open, so it
   * has everyone's edits since this library loaded. What placing one reads.
   */
  refreshPrefab: (assetId: string) => Promise<void>
  /** Overwrite a prefab asset on disk and in memory. */
  savePrefab: (assetId: string, prefab: Node) => Promise<void>
  /** Write a prefab to a path under the assets root, creating it. Returns its entry after a rescan. */
  createPrefab: (path: string, prefab: Node) => Promise<AssetEntry | undefined>
  mkdir: (parent: string, name: string) => Promise<void>
  /** Rename or move. The sidecar goes with it, so ids survive. */
  move: (from: string, to: string) => Promise<void>
  remove: (path: string) => Promise<void>
  /** Create `<name>.mat.json` in `folder`. Resolves once the importer has given it an id. */
  createMaterial: (name: string, material: MaterialAsset, folder?: string) => Promise<AssetEntry | undefined>
}

export const assetUrl = (path: string): string => `/assets/${path}`

const fetchJson = async <T>(url: string): Promise<T> => {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`)
  return (await r.json()) as T
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

/** Fetch the database and every JSON asset in it. */
export const loadAssetLibrary = async (): Promise<AssetLibrary> => {
  const { entries, folders } = await fetchJson<{ entries: AssetEntry[]; folders: string[] }>('/api/assets')
  const db = buildDatabase(entries)
  const materials = new Map<string, MaterialAsset>()
  const prefabs = new Map<string, Node>()

  // Both are small JSON and both are needed synchronously — a material to compile, a prefab to preview or
  // place — so they are fetched up front rather than on demand.
  await Promise.all(
    entries
      .filter((e) => e.kind === 'material' || e.kind === 'prefab')
      .map(async (e) => {
        try {
          const parsed = await fetchJson<unknown>(assetUrl(e.path))
          if (e.kind === 'material') {
            if (isMaterial(parsed)) materials.set(e.id, parsed)
            else console.warn(`material ${e.path}: no shader`)
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
    folders,
    urlOf: assetUrl,
    urlOfId: (id) => {
      const entry = db.byId[id]
      return entry === undefined ? null : assetUrl(entry.path)
    },
    materialOf: (id) => materials.get(id),
    prefabOf: (id) => prefabs.get(id),
    saveMaterial: async (id, material) => {
      const entry = db.byId[id]
      if (entry === undefined) throw new Error(`material ${id}: not in the database`)
      await put(entry.path, material)
      materials.set(id, material)
    },
    createMaterial: async (name, material, folder = 'materials') => {
      const safe = name.replace(/[^\w-]+/g, '-') || 'material'
      const path = `${folder === '' ? '' : `${folder}/`}${safe}.mat.json`
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
    mkdir: async (parent, name) => post('mkdir', { path: parent === '' ? name : `${parent}/${name}` }),
    move: async (from, to) => post('move', { from, to }),
    remove: async (path) => post('delete', { path }),
  }
}

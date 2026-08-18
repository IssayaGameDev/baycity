import { buildDatabase, type AssetDatabase, type AssetEntry, type MaterialAsset } from '@mp/content'

/**
 * Client for the dev server's asset routes (see vite.config.ts).
 *
 * Materials are fetched eagerly and kept in memory. They are tiny JSON, and it makes `materialOf`
 * synchronous — which the material compiler needs, since compiling is a pure step after the preload pass
 * rather than something that awaits mid-scene-build.
 */
export interface AssetLibrary {
  db: AssetDatabase
  /** URL the bytes of an asset are served from. */
  urlOf: (path: string) => string
  urlOfId: (assetId: string) => string | null
  /** A loaded material's JSON, by asset id. */
  materialOf: (assetId: string) => MaterialAsset | undefined
  /** Overwrite a material on disk and in memory. */
  saveMaterial: (assetId: string, material: MaterialAsset) => Promise<void>
  /** Create `<name>.mat.json` under materials/. Resolves once the importer has given it an id. */
  createMaterial: (name: string, material: MaterialAsset) => Promise<AssetEntry | undefined>
}

export const assetUrl = (path: string): string => `/assets/${path}`

const fetchJson = async <T>(url: string): Promise<T> => {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`)
  return (await r.json()) as T
}

const isMaterial = (v: unknown): v is MaterialAsset =>
  typeof v === 'object' && v !== null && typeof (v as { shader?: unknown }).shader === 'string'

/** Fetch the database and every material in it. */
export const loadAssetLibrary = async (): Promise<AssetLibrary> => {
  const { entries } = await fetchJson<{ entries: AssetEntry[] }>('/api/assets')
  const db = buildDatabase(entries)
  const materials = new Map<string, MaterialAsset>()

  await Promise.all(
    entries
      .filter((e) => e.kind === 'material')
      .map(async (e) => {
        try {
          const parsed = await fetchJson<unknown>(assetUrl(e.path))
          if (isMaterial(parsed)) materials.set(e.id, parsed)
          else console.warn(`material ${e.path}: not a material (no shader)`)
        } catch (err) {
          console.warn(`material ${e.path}: ${String(err)}`)
        }
      }),
  )

  const put = async (path: string, body: unknown): Promise<void> => {
    const r = await fetch(assetUrl(path), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`PUT ${path} → ${r.status}`)
  }

  return {
    db,
    urlOf: assetUrl,
    urlOfId: (id) => {
      const entry = db.byId[id]
      return entry === undefined ? null : assetUrl(entry.path)
    },
    materialOf: (id) => materials.get(id),
    saveMaterial: async (id, material) => {
      const entry = db.byId[id]
      if (entry === undefined) throw new Error(`material ${id}: not in the database`)
      await put(entry.path, material)
      materials.set(id, material)
    },
    createMaterial: async (name, material) => {
      const safe = name.replace(/[^\w-]+/g, '-') || 'material'
      const path = `materials/${safe}.mat.json`
      await put(path, material)
      // The id is the importer's to assign, so the new entry only exists after a rescan.
      const { entries: rescanned } = await fetchJson<{ entries: AssetEntry[] }>('/api/assets')
      return rescanned.find((e) => e.path === path)
    },
  }
}

/// <reference path="./virtual-game-content.d.ts" />
import {
  buildDatabase,
  entriesFrom,
  kindForPath,
  type AssetDatabase,
  type AssetMeta,
  type MaterialAsset,
  type Node,
  type PrefabSource,
} from '@mp/content'
import { MATERIALS, METAS, PREFABS, URLS } from 'virtual:game-content'

/**
 * The game's view of the asset tree, bundled at build time.
 *
 * No server and no scan at runtime: the `gameContent` plugin (`game-content.ts`, ADR 0161) hands over this game's
 * assets — its own library's and Shared's, and in a build only what its levels use — keyed by their paths from
 * `content/`. Ids come from the `.meta` sidecars the editor's importer wrote, so the game resolves the same ids the
 * editor stored in a level, and a missing sidecar means an asset the editor has not imported yet rather than a guess.
 *
 * Prefab definitions (ADR 0091) are eager, like materials, because a level references a prefab by asset id and
 * `hydrate` must resolve it **before** `instantiateLevel`, which stays synchronous (`baseIndex` goes on the wire,
 * ADR 0021).
 */

const asMeta = (raw: string): AssetMeta | undefined => {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return undefined
    const id = (value as { id?: unknown }).id
    return typeof id === 'string' && id !== '' ? (value as AssetMeta) : undefined
  } catch {
    return undefined // a corrupt sidecar is an asset the game does not know about, not a broken build
  }
}

const pairs: [string, AssetMeta][] = []
const urlByPath = new Map<string, string>()
const materialsById = new Map<string, MaterialAsset>()
const prefabsById = new Map<string, Node>()

for (const [path, url] of Object.entries(URLS)) urlByPath.set(path, url)

for (const [path, raw] of Object.entries(METAS)) {
  const meta = asMeta(raw)
  if (meta === undefined) continue
  // The extension decides the kind, as it does in the importer; the sidecar only carries identity.
  const kind = kindForPath(path)
  if (kind === undefined) continue
  pairs.push([path, meta])

  if (kind === 'material') {
    const material = MATERIALS[path]
    if (typeof material === 'object' && material !== null && typeof (material as { shader?: unknown }).shader === 'string') {
      materialsById.set(meta.id, material as MaterialAsset)
    }
  } else if (kind === 'prefab') {
    // Structural, as the editor's check is: a root node has a components array. A malformed file is an
    // unresolved reference, not a broken build.
    const prefab = PREFABS[path]
    if (typeof prefab === 'object' && prefab !== null && Array.isArray((prefab as { components?: unknown }).components)) prefabsById.set(meta.id, prefab as Node)
  }
}

export const ASSET_DB: AssetDatabase = buildDatabase(entriesFrom(pairs))

/** Bundled URL for an asset path, or the path itself if it was not bundled (nothing to serve it). */
export const assetUrlOf = (path: string): string => urlByPath.get(path) ?? path

export const materialOf = (assetId: string): MaterialAsset | undefined => materialsById.get(assetId)

/** Prefab definitions, as the `PrefabSource` `hydrate` takes (ADR 0091). Bundled, so resolution is synchronous. */
export const PREFAB_SOURCE: PrefabSource = { root: (assetId) => prefabsById.get(assetId) }

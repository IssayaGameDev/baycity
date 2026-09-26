import {
  buildDatabase,
  entryFor,
  PLAY_CONTENT_DIR,
  type AssetDatabase,
  type AssetEntry,
  type LevelNeeds,
  type MaterialAsset,
  type Node,
  type PrefabSource,
} from '@mp/content'

/**
 * One level's assets, as the page uses them: made from the level's list and the JSON fetched for it (ADR 0169).
 *
 * The list is the whole database the page knows — what this level uses and nothing more, so an id the list does
 * not name greyboxes, as a dangling one always has. Its ids came from the `.meta` sidecars the editor's importer
 * wrote, so the page resolves the same ids the editor stored in a level.
 *
 * Prefab definitions (ADR 0091) and materials are held here before the level is built, because a level references
 * a prefab by asset id and `hydrate` must resolve it **before** `instantiateLevel`, which stays synchronous
 * (`baseIndex` goes on the wire, ADR 0021); the renderer asks for materials synchronously too.
 */
export interface LevelAssets {
  db: AssetDatabase
  /** An asset's path from `content/` → the absolute URL of its bytes. */
  urlOf: (path: string) => string
  materialOf: (assetId: string) => MaterialAsset | undefined
  prefabs: PrefabSource
}

const isMaterial = (v: unknown): v is MaterialAsset =>
  typeof v === 'object' && v !== null && typeof (v as { shader?: unknown }).shader === 'string'

/** Structural, as the editor's check is: a root node has a components array. A malformed file is an unresolved reference. */
const isPrefab = (v: unknown): v is Node => typeof v === 'object' && v !== null && Array.isArray((v as { components?: unknown }).components)

/**
 * `needs`: the level's list. `json`: each prefab's and material's JSON by asset id, as fetched; a missing or malformed
 * one is an unresolved reference, not a dead level. `base`: the game page's absolute address, which every `url` on
 * the list is relative to.
 */
export const levelAssets = (needs: LevelNeeds, json: ReadonlyMap<string, unknown>, base: string): LevelAssets => {
  const entries: AssetEntry[] = []
  const urls = new Map<string, string>()
  const materials = new Map<string, MaterialAsset>()
  const prefabs = new Map<string, Node>()
  for (const a of needs.assets) {
    const entry = entryFor(a.path, { id: a.id, kind: a.kind })
    if (entry === undefined) continue
    entries.push(entry)
    urls.set(a.path, new URL(a.url, base).href)
    const doc = json.get(a.id)
    if (entry.kind === 'material' && isMaterial(doc)) materials.set(a.id, doc)
    if (entry.kind === 'prefab' && isPrefab(doc)) prefabs.set(a.id, doc)
  }
  return {
    db: buildDatabase(entries),
    // A path the list does not name is where every server would put it; nothing will be there in a build.
    urlOf: (path) => urls.get(path) ?? new URL(`${PLAY_CONTENT_DIR}/${path}`, base).href,
    materialOf: (id) => materials.get(id),
    prefabs: { root: (id) => prefabs.get(id) },
  }
}

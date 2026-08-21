import {
  buildDatabase,
  entriesFrom,
  isAnimationAsset,
  kindForPath,
  META_SUFFIX,
  type AnimationAsset,
  type AssetDatabase,
  type AssetMeta,
  type ClipSource,
  type MaterialAsset,
} from '@mp/content'

/**
 * The game's view of the asset tree, bundled at build time.
 *
 * No server and no scan at runtime: `import.meta.glob` enumerates `content/assets/` when the app is built,
 * exactly as `levels.ts` does for level files. Ids come from the `.meta` sidecars the editor's importer
 * wrote — so the game resolves the same ids the editor stored in a level, and a missing sidecar means an
 * asset the editor has not imported yet rather than a guess.
 */
// `?raw`, because `.meta` is not an extension Vite knows: imported normally it would try to parse a
// sidecar as JavaScript and fail the build.
const METAS = import.meta.glob('../../../content/assets/**/*.meta', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>
const URLS = import.meta.glob('../../../content/assets/**/*', { eager: true, query: '?url', import: 'default' }) as Record<
  string,
  string
>
const MATERIALS = import.meta.glob('../../../content/assets/**/*.mat.json', { eager: true, import: 'default' }) as Record<
  string,
  unknown
>
const CLIPS = import.meta.glob('../../../content/assets/**/*.anim.json', { eager: true, import: 'default' }) as Record<
  string,
  unknown
>

const PREFIX = '../../../content/assets/'

const relativeOf = (globKey: string): string => (globKey.startsWith(PREFIX) ? globKey.slice(PREFIX.length) : globKey)

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
const clipsById = new Map<string, AnimationAsset>()

for (const [key, url] of Object.entries(URLS)) urlByPath.set(relativeOf(key), url)

for (const [metaKey, raw] of Object.entries(METAS)) {
  const meta = asMeta(raw)
  if (meta === undefined) continue
  const assetKey = metaKey.slice(0, -META_SUFFIX.length)
  const path = relativeOf(assetKey)
  // The extension decides the kind, as it does in the importer; the sidecar only carries identity.
  const kind = kindForPath(path)
  if (kind === undefined) continue
  pairs.push([path, meta])

  if (kind === 'material') {
    const material = MATERIALS[assetKey]
    if (typeof material === 'object' && material !== null && typeof (material as { shader?: unknown }).shader === 'string') {
      materialsById.set(meta.id, material as MaterialAsset)
    }
  } else if (kind === 'animation') {
    const clip = CLIPS[assetKey]
    if (isAnimationAsset(clip)) clipsById.set(meta.id, clip)
  }
}

export const ASSET_DB: AssetDatabase = buildDatabase(entriesFrom(pairs))

/** Bundled URL for an asset path, or the path itself if it was not bundled (nothing to serve it). */
export const assetUrlOf = (path: string): string => urlByPath.get(path) ?? path

export const materialOf = (assetId: string): MaterialAsset | undefined => materialsById.get(assetId)

/**
 * Animation clips, as the `ClipSource` the loader takes (ADR 0050). Bundled like everything else here, so a
 * clip a level references resolves without a fetch and `instantiateLevel` stays synchronous.
 */
export const CLIP_SOURCE: ClipSource = { keys: (assetId) => clipsById.get(assetId)?.keys }

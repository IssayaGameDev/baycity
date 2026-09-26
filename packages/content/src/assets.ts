import type { Vec3 } from '@mp/core'




/**
 * The asset layer: what content can reference besides its own authored primitives.
 *
 * **Assets are referenced by id, never by path.** A path breaks the moment a file is renamed or moved —
 * and it breaks at *load*, silently, in a level nobody was editing. The id lives in a `.meta` sidecar
 * beside the file (Unity's model), so renaming `crate.glb` leaves every reference to it intact. The cost
 * is a sidecar per asset and references that a person cannot read at a glance; the alternative is a class
 * of breakage that cannot be fixed later without migrating every level, prefab and material.
 *
 * Headless: this is the schema and the resolution rules. Loading a texture or compiling a material is a
 * renderer's job (`@mp/render-three`), and playing a sound is nobody's yet.
 */
export type AssetKind = 'prefab' | 'texture' | 'model' | 'material' | 'shader' | 'sound' | 'font'

/** Every kind, for iteration in a browser panel and for validation. */
export const ASSET_KINDS: readonly AssetKind[] = ['prefab', 'texture', 'model', 'material', 'shader', 'sound', 'font']

/**
 * What a `.meta` sidecar holds. Written once by the importer and then never regenerated — the id *is* the
 * asset's identity, so re-deriving it from anything (path, hash, contents) would defeat the point.
 */
export interface AssetMeta {
  id: string
  kind: AssetKind
}

/**
 * One asset as the database knows it. `path` is relative to `content/`, forward-slashed, and starts with its
 * library (`libraryDir`, ADR 0161): `assets/…` for the shared one, `<game>/assets/…` for a game's own.
 */
export interface AssetEntry {
  id: string
  kind: AssetKind
  path: string
  /** File name without its extension — what a panel shows and what a person calls it. */
  name: string
}

/**
 * The asset database: entries plus an id index. Built by the importer on the dev server and bundled for
 * the game, so both resolve the same ids without either scanning at runtime.
 */
export interface AssetDatabase {
  entries: readonly AssetEntry[]
  byId: Readonly<Record<string, AssetEntry>>
}

export const buildDatabase = (entries: readonly AssetEntry[]): AssetDatabase => {
  const byId: Record<string, AssetEntry> = {}
  for (const e of entries) byId[e.id] = e
  return { entries, byId }
}

/** Entries of one kind, name-sorted — the order a browser panel lists them in. */
export const assetsOfKind = (db: AssetDatabase, kind: AssetKind): AssetEntry[] =>
  db.entries.filter((e) => e.kind === kind).sort((a, b) => a.name.localeCompare(b.name))

/**
 * A parameter value in a material, tagged with its type.
 *
 * Tagged even though the shader already declares the type, so that a material stays inspectable when its
 * shader is missing or unknown — an editor can still show and edit what is there, rather than refusing to
 * open the file. `texture` holds an asset id, or `null` for an empty slot.
 */
export type MaterialValue =
  | { kind: 'color'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'vec2'; value: { x: number; y: number } }
  | { kind: 'vec3'; value: Vec3 }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'texture'; value: string | null }

/**
 * A **prefab asset** (`*.prefab.json`): a reusable prefab on disk, in a folder, with an id that survives being
 * renamed or moved. That id **is** what a level references (ADR 0091): placing one writes the id, the
 * definition stays in the file, and editing the prefab reaches every level that uses it. ADR 0023 interned a
 * copy per level instead, so that a deleted file could never leave a level without geometry; the trade was
 * made deliberately, and a reference with no file now leaves an empty object that says so rather than a copy
 * nobody can edit.
 *
 * Kit makers (`platform()`, `beam()`) are code, not files, and stay out of the tree: they are parametric,
 * which is exactly the reason to keep them that way.
 */

/**
 * A material asset: **a shader plus values for its parameters**. Materials are instances of shaders, so
 * the property set is the shader's, not the schema's — which is what keeps a custom shader from needing a
 * change here, and what lets one generic inspector edit any material.
 *
 * `shader` is a built-in name (`standard`, `unlit`) or the asset id of a shader. Unknown shaders are a
 * render-time fallback, not a load error: a material whose shader is missing should still open.
 */
export interface MaterialAsset {
  shader: string
  params: Record<string, MaterialValue>
}

/** Suffix of an identity sidecar: `crate.glb` is described by `crate.glb.meta`. */
export const META_SUFFIX = '.meta'

/**
 * Which kind a file is, by extension, or `undefined` for anything not an asset (a stray README, a
 * sidecar). One mapping, shared by the importer that writes sidecars and the browser that builds the
 * database from them, because two lists would drift and the symptom would be an asset that exists on disk
 * and not in the panel.
 *
 * Materials and shaders use compound extensions (`brick.mat.json`) rather than living in a magic folder, so
 * a file can be moved anywhere in a library and still be what it is.
 */
const BY_EXTENSION: Record<string, AssetKind> = {
  png: 'texture',
  jpg: 'texture',
  jpeg: 'texture',
  webp: 'texture',
  ktx2: 'texture',
  glb: 'model',
  gltf: 'model',
  wav: 'sound',
  mp3: 'sound',
  ogg: 'sound',
  ttf: 'font',
  otf: 'font',
  woff: 'font',
  woff2: 'font',
}

export const kindForPath = (path: string): AssetKind | undefined => {
  const lower = path.toLowerCase()
  if (lower.endsWith(META_SUFFIX)) return undefined
  if (lower.endsWith('.mat.json')) return 'material'
  if (lower.endsWith('.shader.json')) return 'shader'
  if (lower.endsWith('.prefab.json')) return 'prefab'
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return undefined
  return BY_EXTENSION[lower.slice(dot + 1)]
}

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ktx2: 'image/ktx2',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  json: 'application/json',
}

/** The HTTP content type a content file is served with: one table for the editor server and a game's dev server. */
export const contentTypeFor = (path: string): string => {
  const dot = path.lastIndexOf('.')
  return (dot >= 0 ? CONTENT_TYPES[path.slice(dot + 1).toLowerCase()] : undefined) ?? 'application/octet-stream'
}

/** Display name: the file name with its extension (compound ones included) removed. */
export const nameForPath = (path: string): string => {
  const file = path.slice(path.lastIndexOf('/') + 1)
  for (const suffix of ['.mat.json', '.shader.json', '.prefab.json']) {
    if (file.toLowerCase().endsWith(suffix)) return file.slice(0, -suffix.length)
  }
  const dot = file.lastIndexOf('.')
  return dot <= 0 ? file : file.slice(0, dot)
}

/**
 * One asset's entry, from its path and its sidecar, or `undefined` if the path is not an asset.
 *
 * The **kind comes from the path**, not from the sidecar: the file's extension is what a file *is*, and a
 * sidecar claiming otherwise is stale. The sidecar contributes identity and nothing else.
 */
export const entryFor = (path: string, meta: AssetMeta): AssetEntry | undefined => {
  const kind = kindForPath(path)
  if (kind === undefined) return undefined
  return { id: meta.id, kind, path, name: nameForPath(path) }
}

/**
 * Build a database's entries from `[assetPath, sidecar]` pairs, path-sorted.
 *
 * Shared by both builders on purpose. The importer walks the filesystem and the game enumerates a build-time
 * glob, and those are genuinely different ways of finding the same files — but *deriving an entry* from one
 * must not be two implementations, or the symptom is an asset the editor lists and the game cannot resolve.
 */
export const entriesFrom = (pairs: Iterable<readonly [string, AssetMeta]>): AssetEntry[] => {
  const out: AssetEntry[] = []
  for (const [path, meta] of pairs) {
    const entry = entryFor(path, meta)
    if (entry !== undefined) out.push(entry)
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** Ids a material depends on — its texture slots. What a preload pass has to fetch first. */
export const materialDependencies = (material: MaterialAsset): string[] => {
  const out: string[] = []
  for (const value of Object.values(material.params)) {
    if (value.kind === 'texture' && value.value !== null) out.push(value.value)
  }
  return out
}

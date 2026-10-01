import { isBuiltinModel, materialDependencies, textFontRefusal, type AssetDatabase, type MaterialAsset, type VisualItem } from '@mp/content'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

import { compileMaterial } from './shaders'

/**
 * Loads assets, then hands out what a scene needs synchronously.
 *
 * The split matters: `addLevel` builds a mesh per visual in one pass with no awaiting, and keeping it that
 * way is why loading is a **separate preload step** rather than a callback inside the level view. Anything
 * else means meshes that pop in after the level is walkable, and a `sync()` that has to cope with holes.
 *
 * Everything is cached by asset id, so a level with forty crates fetches one model and one material.
 * Instances are cloned; the cached original is never handed out, or the first piece to be scaled would
 * resize every other piece sharing it.
 */
export interface AssetRuntimeOptions {
  db: AssetDatabase
  /** URL to fetch an asset's bytes from. The editor serves them; the game bundles them. */
  urlOf: (path: string) => string
  /** Material JSON by asset id. Materials are content, so the caller owns reading them. */
  materialOf: (assetId: string) => MaterialAsset | undefined
}

export interface AssetRuntime {
  /**
   * Fetch every asset the given ids need, transitively — a material pulls in its textures. Safe to call
   * repeatedly: already-loaded ids are skipped, and concurrent calls for one id share a fetch.
   *
   * Resolves `true` when any of them was not held yet — fetched now, or already on its way for another call —
   * so a caller that drew before they arrived knows whether drawing again shows anything new.
   */
  load: (assetIds: readonly string[]) => Promise<boolean>
  /**
   * Compile a loaded material again from its asset **into the object meshes already hold**, so an edit shows on
   * the next frame with nothing rebuilt. `true` when it did, or had nothing to do — a material never loaded loads
   * as it now is. `false` when it could not: the shader became another class of Three material, so the new one
   * is cached and whatever draws the old one has to be rebuilt.
   */
  refreshMaterial: (assetId: string) => Promise<boolean>
  /**
   * Fetch a texture again — an upload replaced its bytes and kept its id — and recompile, in place, every loaded
   * material using it: each holds its own copy of the texture, so a new one reaches them only that way. Resolves
   * those materials' ids.
   */
  refreshTexture: (assetId: string) => Promise<string[]>
  /** Fetch a model again. The clones already placed are the caller's to rebuild; `model(id)` hands out the new one. */
  refreshModel: (assetId: string) => Promise<void>
  /** A compiled material, or `null` if the id is not a loaded material. */
  material: (assetId: string) => THREE.Material | null
  /** A fresh clone of a loaded model, or `null`. */
  model: (assetId: string) => THREE.Object3D | null
  texture: (assetId: string) => THREE.Texture | null
  /**
   * Where a font asset's file is (ADR 0190), for the text library, which fetches it itself — nothing to load.
   * `null` for no such font, or one it cannot read (a woff2).
   */
  fontUrl: (assetId: string) => string | null
  dispose: () => void
}

/** Asset ids a set of visuals depends on — what to hand `load` before building a level view. */
export const assetIdsIn = (visuals: readonly VisualItem[]): string[] => {
  const ids = new Set<string>()
  for (const v of visuals) {
    // A built-in shape is geometry this package builds, not a file to fetch (ADR 0090).
    if (v.model !== undefined && !isBuiltinModel(v.model)) ids.add(v.model)
    if (v.material !== undefined) ids.add(v.material)
  }
  return [...ids]
}

export const createAssetRuntime = (opts: AssetRuntimeOptions): AssetRuntime => {
  const textures = new Map<string, THREE.Texture>()
  const models = new Map<string, THREE.Object3D>()
  const materials = new Map<string, THREE.Material>()
  const inFlight = new Map<string, Promise<void>>()

  const textureLoader = new THREE.TextureLoader()
  const gltfLoader = new GLTFLoader()

  const loadTexture = async (id: string, url: string): Promise<void> => {
    const tex = await textureLoader.loadAsync(url)
    tex.colorSpace = THREE.SRGBColorSpace
    textures.set(id, tex)
  }

  const loadModel = async (id: string, url: string): Promise<void> => {
    const gltf = await gltfLoader.loadAsync(url)
    models.set(id, gltf.scene)
  }

  /** Fetch one id; `true` when it was not held yet. */
  const loadOne = (id: string): Promise<boolean> => {
    const existing = inFlight.get(id)
    if (existing !== undefined) return existing.then(() => true)
    if (textures.has(id) || models.has(id) || materials.has(id)) return Promise.resolve(false)

    // Belt for a caller that collected one anyway: it is geometry, and there is nothing to load.
    if (isBuiltinModel(id)) return Promise.resolve(false)

    const entry = opts.db.byId[id]
    if (entry === undefined) {
      // A dangling reference is a wrong-looking piece, not a dead level: greybox stands in.
      console.warn(`asset ${id}: not in the database`)
      return Promise.resolve(false)
    }

    const run = (async (): Promise<void> => {
      if (entry.kind === 'texture') await loadTexture(id, opts.urlOf(entry.path))
      else if (entry.kind === 'model') await loadModel(id, opts.urlOf(entry.path))
      else if (entry.kind === 'material') {
        const asset = opts.materialOf(id)
        if (asset === undefined) {
          console.warn(`material ${id}: ${entry.path} did not resolve`)
          return
        }
        // Textures first, then compile — the compiler is synchronous and expects them present.
        await Promise.all(materialDependencies(asset).map(loadOne))
        materials.set(id, compileMaterial(asset, (texId) => textures.get(texId) ?? null))
      }
      // sound and font are referenced and previewed, not loaded into the scene.
    })().finally(() => inFlight.delete(id))

    inFlight.set(id, run)
    return run.then(() => true)
  }

  /** A texture slot, on the material classes the shaders build. */
  const mapOf = (m: THREE.Material): THREE.Texture | null => (m as THREE.Material & { map?: THREE.Texture | null }).map ?? null

  const refreshMaterial = async (id: string): Promise<boolean> => {
    const existing = materials.get(id)
    const asset = opts.materialOf(id)
    if (existing === undefined || asset === undefined) return true
    await Promise.all(materialDependencies(asset).map(loadOne))
    const fresh = compileMaterial(asset, (texId) => textures.get(texId) ?? null)
    if (fresh.type !== existing.type) {
      materials.set(id, fresh)
      existing.dispose()
      return false
    }
    const before = mapOf(existing)
    existing.copy(fresh)
    // A texture slot filled or emptied changes the program; a colour alone does not, and the cache says so.
    existing.needsUpdate = true
    // Every compile clones its texture, so the one this material had is nobody's now.
    if (before !== null && before !== mapOf(existing)) before.dispose()
    return true
  }

  /** Bytes replaced at the same URL: asked for past any cache in between (the browser's, Cloudflare's). */
  const busted = (url: string): string => `${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}`

  return {
    load: async (assetIds) => (await Promise.all(assetIds.map(loadOne))).some(Boolean),
    refreshMaterial,
    refreshTexture: async (id) => {
      const old = textures.get(id)
      const entry = opts.db.byId[id]
      if (old === undefined || entry === undefined) return []
      await loadTexture(id, busted(opts.urlOf(entry.path)))
      old.dispose()
      const users = [...materials.keys()].filter((mid) => {
        const asset = opts.materialOf(mid)
        return asset !== undefined && materialDependencies(asset).includes(id)
      })
      await Promise.all(users.map(refreshMaterial))
      return users
    },
    refreshModel: async (id) => {
      const entry = opts.db.byId[id]
      if (!models.has(id) || entry === undefined) return
      await loadModel(id, busted(opts.urlOf(entry.path)))
    },
    material: (id) => materials.get(id) ?? null,
    model: (id) => {
      const original = models.get(id)
      return original === undefined ? null : original.clone(true)
    },
    texture: (id) => textures.get(id) ?? null,
    fontUrl: (id) => {
      const entry = opts.db.byId[id]
      return entry === undefined || entry.kind !== 'font' || textFontRefusal(entry.path) !== null ? null : opts.urlOf(entry.path)
    },
    dispose: () => {
      for (const t of textures.values()) t.dispose()
      for (const m of materials.values()) m.dispose()
      for (const model of models.values()) {
        model.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry.dispose()
            const mat = o.material as THREE.Material | THREE.Material[]
            if (Array.isArray(mat)) for (const m of mat) m.dispose()
            else mat.dispose()
          }
        })
      }
      textures.clear()
      models.clear()
      materials.clear()
    },
  }
}

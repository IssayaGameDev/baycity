import { isBuiltinModel, materialDependencies, type AssetDatabase, type MaterialAsset, type VisualItem } from '@mp/content'
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
   */
  load: (assetIds: readonly string[]) => Promise<void>
  /** A compiled material, or `null` if the id is not a loaded material. */
  material: (assetId: string) => THREE.Material | null
  /** A fresh clone of a loaded model, or `null`. */
  model: (assetId: string) => THREE.Object3D | null
  texture: (assetId: string) => THREE.Texture | null
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

  const loadOne = (id: string): Promise<void> => {
    const existing = inFlight.get(id)
    if (existing !== undefined) return existing
    if (textures.has(id) || models.has(id) || materials.has(id)) return Promise.resolve()

    // Belt for a caller that collected one anyway: it is geometry, and there is nothing to load.
    if (isBuiltinModel(id)) return Promise.resolve()

    const entry = opts.db.byId[id]
    if (entry === undefined) {
      // A dangling reference is a wrong-looking piece, not a dead level: greybox stands in.
      console.warn(`asset ${id}: not in the database`)
      return Promise.resolve()
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
    return run
  }

  return {
    load: async (assetIds) => {
      await Promise.all(assetIds.map(loadOne))
    },
    material: (id) => materials.get(id) ?? null,
    model: (id) => {
      const original = models.get(id)
      return original === undefined ? null : original.clone(true)
    },
    texture: (id) => textures.get(id) ?? null,
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

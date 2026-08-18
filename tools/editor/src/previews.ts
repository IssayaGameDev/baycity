import { visualStyle, type AssetDatabase, type MaterialAsset, type Prefab } from '@mp/content'
import { createStyleMaterial, createThumbnailer, geometryForCollider, THREE, type AssetRuntime, type Thumbnailer } from '@mp/render-three'

/**
 * Thumbnails for the Project panel, cached.
 *
 * The cost rule: a subject is rendered **once**, and every later request is a `Map` hit. The panel redraws
 * on every selection change, so anything that rendered per draw would be paying GL for a picture that did
 * not change. Generation is also **lazy** — a tile asks only when it is actually built, so switching to the
 * Textures tab never renders a model.
 *
 * A texture needs no renderer: its own file is the preview. Sounds and fonts have no visual form worth
 * inventing, so they keep their text tile.
 */
export interface PreviewHost {
  db: () => AssetDatabase | null
  runtime: () => AssetRuntime | null
  materialOf: (assetId: string) => MaterialAsset | undefined
  urlOf: (path: string) => string
  /** Build the prefab behind a palette name, for a prefab tile. */
  prefabFor: (name: string) => Prefab | undefined
  /**
   * Fetch an asset a preview needs but the runtime does not have. The runtime only preloads what the open
   * *document* references, and the Project panel shows the whole library — so a material nothing has placed
   * yet has never been compiled, and its tile would be blank for ever.
   */
  ensureLoaded: (assetId: string) => Promise<void>
  /** A previously-blank tile can now be drawn. Redraw the panel. */
  onReady: () => void
}

export interface Previews {
  /** A data URL for this tile, or `null` when the kind has no rendered preview. Cached. */
  of: (kind: 'prefab' | 'model' | 'material' | 'shader' | 'texture', key: string) => string | null
  /** Forget one entry (an edited material) or everything (a reimport). */
  invalidate: (key?: string) => void
  dispose: () => void
}

export const createPreviews = (host: PreviewHost): Previews => {
  const cache = new Map<string, string | null>()
  /** In flight, so a redraw does not queue the same fetch again. */
  const pending = new Set<string>()
  /** Fetched and still not there: a dangling id. Remembered, or the panel would ask on every redraw. */
  const failed = new Set<string>()
  let thumbnailer: Thumbnailer | null = null
  const lazy = (): Thumbnailer => (thumbnailer ??= createThumbnailer({ size: 96, fill: 0.8 }))

  /** A prefab's pieces as one group, drawn the way the editor draws them. */
  const prefabSubject = (prefab: Prefab): THREE.Object3D | null => {
    const runtime = host.runtime()
    const group = new THREE.Group()
    const disposables: THREE.BufferGeometry[] = []
    const owned: THREE.Material[] = []

    for (const piece of prefab.pieces) {
      const modelId = piece.visual?.kind === 'model' ? piece.visual.asset : undefined
      const materialId = piece.visual?.material
      const material = materialId !== undefined ? runtime?.material(materialId) : undefined
      const model = modelId !== undefined ? runtime?.model(modelId) : undefined

      let object: THREE.Object3D
      if (model != null) object = model
      else {
        const geometry = geometryForCollider(piece.collider)
        disposables.push(geometry)
        const mat = material ?? createStyleMaterial(visualStyle(piece.visual))
        if (material == null) owned.push(mat)
        object = new THREE.Mesh(geometry, mat)
      }
      const t = piece.transform
      object.position.set(t.position.x, t.position.y, t.position.z)
      if (t.rotation !== undefined) object.rotation.set(t.rotation.x, t.rotation.y, t.rotation.z)
      if (t.scale !== undefined) object.scale.set(t.scale.x, t.scale.y, t.scale.z)
      group.add(object)
    }
    if (group.children.length === 0) return null

    // Everything this built is thrown away after the shot; the runtime's cached models and materials are
    // not ours to free, which is why only what we created is tracked.
    group.userData.dispose = (): void => {
      for (const g of disposables) g.dispose()
      for (const m of owned) m.dispose()
    }
    return group
  }

  /** Whether the runtime can now answer for this id — the test for "did the fetch actually help". */
  const isLoaded = (kind: string, key: string): boolean =>
    kind === 'model' ? host.runtime()?.model(key) != null : host.runtime()?.material(key) != null

  /**
   * Fetch a missing asset once, then ask for a redraw. Nothing here retries: an id that is fetched and
   * still absent is dangling, and asking again on every redraw would be a loop.
   */
  const request = (kind: string, key: string): void => {
    if (pending.has(key) || failed.has(key)) return
    pending.add(key)
    void host
      .ensureLoaded(key)
      .catch(() => {})
      .finally(() => {
        pending.delete(key)
        if (!isLoaded(kind, key)) {
          failed.add(key)
          return
        }
        cache.delete(`${kind}:${key}`)
        host.onReady()
      })
  }

  const generate = (kind: string, key: string): string | null => {
    if (kind === 'texture') {
      const entry = host.db()?.byId[key]
      return entry === undefined ? null : host.urlOf(entry.path)
    }

    if (kind === 'material' || kind === 'shader') {
      // Only a material compiles to something previewable; a shader asset has no values of its own yet.
      const compiled = host.runtime()?.material(key)
      if (compiled != null) return lazy().renderMaterial(compiled)
      request(kind, key)
      return null
    }

    if (kind === 'model') {
      const model = host.runtime()?.model(key)
      if (model != null) return lazy().render(model)
      request(kind, key)
      return null
    }

    const prefab = host.prefabFor(key)
    if (prefab === undefined) return null
    const subject = prefabSubject(prefab)
    if (subject === null) return null
    const url = lazy().render(subject)
    ;(subject.userData.dispose as (() => void) | undefined)?.()
    return url
  }

  return {
    of: (kind, key) => {
      const id = `${kind}:${key}`
      const hit = cache.get(id)
      if (hit !== undefined) return hit
      let made: string | null = null
      try {
        made = generate(kind, key)
      } catch (e) {
        // A preview is decoration. A model that will not frame must not take the panel down with it.
        console.warn(`preview ${id}: ${String(e)}`)
      }
      cache.set(id, made)
      return made
    },
    invalidate: (key) => {
      // A reimport can turn a dangling id into a real one, so forget the failures too.
      failed.clear()
      if (key === undefined) cache.clear()
      else for (const id of [...cache.keys()]) if (id.endsWith(`:${key}`)) cache.delete(id)
    },
    dispose: () => {
      thumbnailer?.dispose()
      thumbnailer = null
      cache.clear()
    },
  }
}

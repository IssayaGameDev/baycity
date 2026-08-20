import { COLLIDER, MESH, RENDERER, stringParam, vec3Param, type AssetDatabase, type ColliderDesc, type MaterialAsset, type Node } from '@mp/content'
import { createGreyboxMaterial, createThumbnailer, geometryForCollider, THREE, type AssetRuntime, type Thumbnailer } from '@mp/render-three'

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
  prefabFor: (name: string) => Node | undefined
  /**
   * Fetch an asset a preview needs but the runtime does not have. The runtime only preloads what the open
   * *document* references, and the Project panel shows the whole library — so a material nothing has placed
   * yet has never been compiled, and its tile would be blank for ever.
   */
  ensureLoaded: (assetId: string) => Promise<void>
}

export type PreviewKind = 'prefab' | 'model' | 'material' | 'shader' | 'texture'

export interface Previews {
  /** A data URL for this tile, or `null` when the kind has no rendered preview. Cached. */
  of: (kind: PreviewKind, key: string) => string | null
  /**
   * Ask for a preview and be called back once, whether it was cached, had to be rendered, or had to be
   * fetched first. One tile's answer fills one tile — a newly loaded asset does not redraw the panel.
   */
  request: (kind: PreviewKind, key: string, done: (url: string | null) => void) => void
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

  /**
   * A prefab's node tree as one group, drawn the way the editor draws it.
   *
   * Walks the tree rather than a flat piece list, and reads the `Collider` and `Visual` components: a node
   * with several colliders draws several meshes, each at its own centre. Transforms compose through
   * `THREE.Group` nesting, so the arithmetic stays where Three already does it.
   */
  const prefabSubject = (root: Node): THREE.Object3D | null => {
    const runtime = host.runtime()
    const group = new THREE.Group()
    const disposables: THREE.BufferGeometry[] = []
    const owned: THREE.Material[] = []

    const walk = (node: Node, parent: THREE.Object3D): void => {
      const holder = new THREE.Group()
      const t = node.transform
      holder.position.set(t.position.x, t.position.y, t.position.z)
      if (t.rotation !== undefined) holder.rotation.set(t.rotation.x, t.rotation.y, t.rotation.z)
      if (t.scale !== undefined) holder.scale.set(t.scale.x, t.scale.y, t.scale.z)
      parent.add(holder)

      const enabled = node.components.filter((c) => c.enabled !== false)
      const renderer = enabled.find((c) => c.type === RENDERER)
      if (renderer !== undefined) {
        const materialId = stringParam(renderer, 'material', '')
        const material = materialId === '' ? undefined : runtime?.material(materialId)
        const mesh = enabled.find((c) => c.type === MESH)
        const modelId = mesh === undefined ? '' : stringParam(mesh, 'model', '')
        const model = modelId === '' ? undefined : runtime?.model(modelId)
        if (model != null) {
          holder.add(model)
        } else {
          for (const c of enabled.filter((x) => x.type === COLLIDER)) {
            const geometry = geometryForCollider(c.params.shape as ColliderDesc)
            disposables.push(geometry)
            const mat = material ?? createGreyboxMaterial()
            if (material == null) owned.push(mat)
            const mesh = new THREE.Mesh(geometry, mat)
            const centre = vec3Param(c, 'center', { x: 0, y: 0, z: 0 })
            mesh.position.set(centre.x, centre.y, centre.z)
            holder.add(mesh)
          }
        }
      }
      for (const kid of node.children ?? []) walk(kid, holder)
    }
    walk(root, group)
    if (group.getObjectByProperty('type', 'Mesh') === undefined) return null
    // Everything this built is thrown away after the shot; the runtime's cached models and materials are
    // not ours to free, which is why only what we created is tracked.
    group.userData.dispose = (): void => {
      for (const g of disposables) g.dispose()
      for (const m of owned) m.dispose()
    }
    return group
  }

  /** Whether the runtime can now answer for this id — the test for "did the fetch actually help". */
  const isLoaded = (kind: PreviewKind, key: string): boolean =>
    kind === 'model' ? host.runtime()?.model(key) != null : host.runtime()?.material(key) != null

  /** Callers waiting on the same asset, so one fetch answers all of them. */
  const waiting = new Map<string, ((url: string | null) => void)[]>()

  /**
   * Fetch a missing asset once, then answer everyone who asked. Nothing retries: an id that is fetched and
   * still absent is dangling, and asking again on every redraw would be a loop.
   */
  const fetchThen = (kind: PreviewKind, key: string, done: (url: string | null) => void): void => {
    if (failed.has(key)) {
      done(null)
      return
    }
    const id = `${kind}:${key}`
    const queue = waiting.get(id)
    if (queue !== undefined) {
      queue.push(done)
      return
    }
    waiting.set(id, [done])
    pending.add(key)
    void host
      .ensureLoaded(key)
      .catch(() => {})
      .finally(() => {
        pending.delete(key)
        const callbacks = waiting.get(id) ?? []
        waiting.delete(id)
        if (!isLoaded(kind, key)) {
          failed.add(key)
          for (const cb of callbacks) cb(null)
          return
        }
        cache.delete(id)
        const url = of(kind, key)
        for (const cb of callbacks) cb(url)
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
      return compiled == null ? null : lazy().renderMaterial(compiled)
    }

    if (kind === 'model') {
      const model = host.runtime()?.model(key)
      return model == null ? null : lazy().render(model)
    }

    const prefab = host.prefabFor(key)
    if (prefab === undefined) return null
    const subject = prefabSubject(prefab)
    if (subject === null) return null
    const url = lazy().render(subject)
    ;(subject.userData.dispose as (() => void) | undefined)?.()
    return url
  }

  const of = (kind: PreviewKind, key: string): string | null => {
    {
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
    }
  }

  return {
    of,
    request: (kind, key, done) => {
      const made = of(kind, key)
      // Null with nothing loaded yet means "not fetched", which is worth one fetch. Null after a fetch is
      // a dangling id, and `fetchThen` remembers that so a redraw cannot loop on it.
      if (made !== null || kind === 'prefab' || kind === 'texture' || isLoaded(kind, key)) {
        done(made)
        return
      }
      fetchThen(kind, key, done)
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

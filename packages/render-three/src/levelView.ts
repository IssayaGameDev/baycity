import type { VisualItem, WorldMarker } from '@mp/content'
import * as THREE from 'three'

import type { AssetRuntime } from './assetRuntime'
import { colorForStyle, createStyleMaterial, geometryForCollider } from './materials'

/**
 * Realizes the loader's renderer-agnostic outputs into Three.js meshes (content pipeline
 * C3). `addLevel` builds a mesh per visual (shadow-casting, styled by the visual language)
 * and returns a `sync()` that re-poses clock-driven pieces each frame from the (loader-
 * mutated) visual objects. `addMarkers` draws gameplay markers as translucent pads.
 * Shared by the game and the viewer.
 */
export interface LevelView {
  group: THREE.Group
  /** Copy each visual's current position/rotation onto its mesh (moving/rotating pieces). */
  sync: () => void
  dispose: () => void
}

export interface LevelViewOptions {
  shadows?: boolean
  /**
   * Loaded assets, for visuals that reference a model or a material. Omit it and everything greyboxes —
   * which is also what happens per-piece when a reference is dangling, so a missing asset costs one wrong
   * surface rather than a hole in the level.
   *
   * Assets must already be loaded (`AssetRuntime.load`): this pass is synchronous by design, so that a
   * level is never briefly walkable with its geometry still arriving.
   */
  assets?: AssetRuntime
}

export const addLevel = (scene: THREE.Scene, visuals: VisualItem[], opts: LevelViewOptions = {}): LevelView => {
  const shadows = opts.shadows ?? true
  const assets = opts.assets
  const group = new THREE.Group()
  const pairs: { v: VisualItem; object: THREE.Object3D }[] = []
  // Only what this view created gets disposed. A model instance's geometry belongs to the runtime's cached
  // original, and a material may be shared by every piece using it, so neither is this view's to free.
  const owned: { geometries: THREE.BufferGeometry[]; materials: THREE.Material[] } = { geometries: [], materials: [] }

  for (const v of visuals) {
    const model = v.model !== undefined ? (assets?.model(v.model) ?? null) : null
    let object: THREE.Object3D

    if (model !== null) {
      // A model replaces the greybox shape but not the collider: the prop still collides as the primitive
      // somebody authored, which is the whole point of visual != collision.
      const material = v.material !== undefined ? assets?.material(v.material) : undefined
      if (material != null) {
        model.traverse((o) => {
          if (o instanceof THREE.Mesh) o.material = material
        })
      }
      object = model
    } else {
      const geometry = geometryForCollider(v.collider)
      owned.geometries.push(geometry)
      const assigned = v.material !== undefined ? assets?.material(v.material) : undefined
      let material: THREE.Material
      if (assigned != null) material = assigned // shared, owned by the runtime
      else {
        material = createStyleMaterial(v.style)
        owned.materials.push(material)
      }
      object = new THREE.Mesh(geometry, material)
    }

    object.position.set(v.position.x, v.position.y, v.position.z)
    object.quaternion.set(v.rotation.x, v.rotation.y, v.rotation.z, v.rotation.w)
    object.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = shadows
        o.receiveShadow = shadows
      }
    })
    group.add(object)
    pairs.push({ v, object })
  }
  scene.add(group)

  return {
    group,
    sync: () => {
      for (const { v, object } of pairs) {
        object.position.set(v.position.x, v.position.y, v.position.z)
        object.quaternion.set(v.rotation.x, v.rotation.y, v.rotation.z, v.rotation.w)
      }
    },
    dispose: () => {
      for (const g of owned.geometries) g.dispose()
      for (const m of owned.materials) m.dispose()
      scene.remove(group)
    },
  }
}

export interface MarkersView {
  group: THREE.Group
  dispose: () => void
}

// A flat translucent pad + a brighter ring, coloured by marker kind, laid on the surface.
export const addMarkers = (scene: THREE.Scene, markers: WorldMarker[], _opts: LevelViewOptions = {}): MarkersView => {
  const group = new THREE.Group()

  for (const m of markers) {
    const color = colorForStyle(m.kind === 'spawn' ? 'spawn' : m.kind)
    const radius = m.radius ?? 0.8
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, 0.06, 40),
      new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.28, emissive: color, emissiveIntensity: 0.4, depthWrite: false }),
    )
    pad.position.set(m.position.x, m.position.y + 0.04, m.position.z)
    group.add(pad)

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.9, radius, 40),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.set(m.position.x, m.position.y + 0.08, m.position.z)
    group.add(ring)
  }
  scene.add(group)

  return {
    group,
    dispose: () => {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose()
          ;(o.material as THREE.Material).dispose()
        }
      })
      scene.remove(group)
    },
  }
}

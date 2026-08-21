import type { VisualItem, WorldMarker } from '@mp/content'
import * as THREE from 'three'

import type { AssetRuntime } from './assetRuntime'
import type { CutoutMask } from './cutout'
import { colorForMarker, createGreyboxMaterial, geometryForCollider } from './materials'

/**
 * Realizes the loader's renderer-agnostic outputs into Three.js meshes (content pipeline
 * C3). `addLevel` builds a mesh per visual (shadow-casting, surfaced by its material asset)
 * and returns a `sync()` that re-poses clock-driven pieces each frame from the (loader-
 * mutated) visual objects. `addMarkers` draws gameplay markers as translucent pads.
 * Shared by the game and the viewer.
 */
export interface LevelView {
  group: THREE.Group
  /** Copy each visual's current position/rotation onto its mesh (moving/rotating pieces). */
  sync: () => void
  /**
   * Which colliders are between the eye and the character right now (ADR 0055). Their meshes get a masked
   * copy of their material and dither a hole; everything else keeps the plain one and is untouched.
   *
   * Handles, because that is what a physics cast answers with. A no-op unless a `cutout` was supplied.
   * Cheap to call every frame: it diffs against what is already swapped.
   */
  setOccluders: (handles: readonly number[]) => void
  /**
   * The meshes currently wearing a hole. For the ambient-occlusion pass, which has to skip exactly these
   * and nothing else — see `PostFXOptions.aoIgnores`.
   */
  occluding: () => readonly THREE.Object3D[]
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
  /**
   * The see-through hole (ADR 0055). Supplying one enables `setOccluders`; without it that call does
   * nothing and no material is ever copied, so a tool that wants to look at the level as it is — the
   * editor, the viewer — pays nothing at all.
   *
   * Level geometry only. The character rig, the markers and the sky are built elsewhere and stay solid,
   * which is the point: the hole exists so you can see the character *through* the level.
   */
  cutout?: CutoutMask
}

export const addLevel = (scene: THREE.Scene, visuals: VisualItem[], opts: LevelViewOptions = {}): LevelView => {
  const shadows = opts.shadows ?? true
  const assets = opts.assets
  const cutout = opts.cutout
  const group = new THREE.Group()
  const pairs: { v: VisualItem; object: THREE.Object3D }[] = []
  /**
   * A cast answers with a collider handle; this is the way back to what is on screen. A node drawing a
   * model lists all of its colliders against the one mesh, and a mesh can appear under several handles.
   */
  const meshesByHandle = new Map<number, THREE.Mesh[]>()
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
        // No material chosen, or one whose asset is missing: greybox rather than nothing, so an unfinished
        // level is still walkable and a dangling reference costs one wrong surface (see LevelViewOptions).
        material = createGreyboxMaterial()
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
        if (cutout !== undefined) {
          for (const handle of v.colliderHandles) {
            const list = meshesByHandle.get(handle)
            if (list === undefined) meshesByHandle.set(handle, [o])
            else list.push(o)
          }
        }
      }
    })
    group.add(object)
    pairs.push({ v, object })
  }
  scene.add(group)

  /**
   * The masked copy of each material, built on first need and kept — a mesh goes in and out of occluding
   * many times a second, and cloning per frame would be a new compiled program's worth of bookkeeping
   * every time. Keyed by the plain material, so every piece sharing one shares its copy too.
   */
  const variants = new Map<THREE.Material, THREE.Material>()
  /** What each swapped mesh had before, so it can be put back exactly. */
  const plain = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
  let masked: THREE.Mesh[] = []

  const variantOf = (m: THREE.Material): THREE.Material => {
    const found = variants.get(m)
    if (found !== undefined) return found
    const made = (cutout as CutoutMask).variant(m)
    variants.set(m, made)
    return made
  }

  return {
    group,
    sync: () => {
      for (const { v, object } of pairs) {
        object.position.set(v.position.x, v.position.y, v.position.z)
        object.quaternion.set(v.rotation.x, v.rotation.y, v.rotation.z, v.rotation.w)
      }
    },
    setOccluders: (handles) => {
      if (cutout === undefined) return
      const wanted: THREE.Mesh[] = []
      for (const handle of handles) {
        for (const mesh of meshesByHandle.get(handle) ?? []) if (!wanted.includes(mesh)) wanted.push(mesh)
      }
      // Restore first, so a mesh that is in both sets is left alone rather than restored after swapping.
      for (const mesh of masked) {
        if (wanted.includes(mesh)) continue
        const was = plain.get(mesh)
        if (was !== undefined) mesh.material = was
        plain.delete(mesh)
      }
      for (const mesh of wanted) {
        if (plain.has(mesh)) continue
        plain.set(mesh, mesh.material)
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(variantOf) : variantOf(mesh.material)
      }
      masked = wanted
    },
    occluding: () => masked,
    dispose: () => {
      for (const g of owned.geometries) g.dispose()
      for (const m of owned.materials) m.dispose()
      // The copies are this view's, unlike the originals, which the asset runtime owns.
      for (const m of variants.values()) m.dispose()
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
    const color = colorForMarker(m.kind)
    // A fixed size: a marker is a point now. Its radius went with the authored `Marker`, whose non-spawn kinds
    // were dead data and became inert nodes when the schema did (ADR 0035).
    const radius = 0.8
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

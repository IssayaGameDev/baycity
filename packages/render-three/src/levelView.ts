import type { VisualItem, WorldMarker } from '@mp/content'
import * as THREE from 'three'

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
}

export const addLevel = (scene: THREE.Scene, visuals: VisualItem[], opts: LevelViewOptions = {}): LevelView => {
  const shadows = opts.shadows ?? true
  const group = new THREE.Group()
  const pairs: { v: VisualItem; mesh: THREE.Mesh }[] = []

  for (const v of visuals) {
    const mesh = new THREE.Mesh(geometryForCollider(v.collider), createStyleMaterial(v.style))
    mesh.position.set(v.position.x, v.position.y, v.position.z)
    mesh.quaternion.set(v.rotation.x, v.rotation.y, v.rotation.z, v.rotation.w)
    mesh.castShadow = shadows
    mesh.receiveShadow = shadows
    group.add(mesh)
    pairs.push({ v, mesh })
  }
  scene.add(group)

  return {
    group,
    sync: () => {
      for (const { v, mesh } of pairs) {
        mesh.position.set(v.position.x, v.position.y, v.position.z)
        mesh.quaternion.set(v.rotation.x, v.rotation.y, v.rotation.z, v.rotation.w)
      }
    },
    dispose: () => {
      for (const { mesh } of pairs) {
        mesh.geometry.dispose()
        ;(mesh.material as THREE.Material).dispose()
      }
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

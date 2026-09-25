import type { VisualItem } from '@mp/content'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { createCutoutMask } from './cutout'
import { addLevel } from './levelView'

/**
 * `setOccluders` — the part of the see-through hole that decides *which* surfaces wear it (ADR 0055).
 *
 * This is where the third design lives. The shader cannot tell the platform overhead from the floor beside
 * the character's feet, because nothing about a fragment's position distinguishes them; a cast can, and its
 * answer is a collider handle. So the swap has to be exact: the meshes named get a masked copy, everything
 * else keeps the shared original, and putting it back has to restore the very same material object.
 */
const box: VisualItem['collider'] = { kind: 'box', halfExtents: { x: 1, y: 1, z: 1 } }

const visual = (colliderHandles: number[]): VisualItem => ({
  collider: box,
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  scale: { x: 1, y: 1, z: 1 },
  model: undefined,
  material: undefined,
  visible: true,
  opacity: 1,
  fades: false,
  animated: false,
  drawScale: { x: 1, y: 1, z: 1 },
  colliderHandles,
})

const mask = (): ReturnType<typeof createCutoutMask> =>
  createCutoutMask({ camera: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 1 }, radius: 1, feather: 0.5, strength: 1 })

const built = (...handles: number[][]) => {
  const scene = new THREE.Scene()
  const view = addLevel(scene, handles.map(visual), { cutout: mask() })
  const meshes = view.group.children.map((o) => o as THREE.Mesh)
  return { view, meshes, plain: meshes.map((m) => m.material) }
}

describe('setOccluders', () => {
  it('masks the named surface and nothing else', () => {
    const { view, meshes, plain } = built([10], [20])
    view.setOccluders([10])
    expect(meshes[0]?.material).not.toBe(plain[0])
    expect(meshes[1]?.material, 'a mesh nothing hit keeps its own material').toBe(plain[1])
    view.dispose()
  })

  it('puts the original material back, not a copy of it', () => {
    const { view, meshes, plain } = built([10])
    view.setOccluders([10])
    view.setOccluders([])
    expect(meshes[0]?.material).toBe(plain[0])
    view.dispose()
  })

  // Called every frame, so it has to be idempotent and it has to reuse the copy — a clone per frame is a
  // compiled program's worth of bookkeeping sixty times a second.
  it('reuses the same copy across frames', () => {
    const { view, meshes } = built([10])
    view.setOccluders([10])
    const first = meshes[0]?.material
    view.setOccluders([10])
    expect(meshes[0]?.material).toBe(first)
    view.dispose()
  })

  it('leaves a mesh alone when it stays occluding between two calls', () => {
    const { view, meshes, plain } = built([10], [20])
    view.setOccluders([10])
    const kept = meshes[0]?.material
    view.setOccluders([20, 10])
    expect(meshes[0]?.material, 'restored and re-swapped instead of left alone').toBe(kept)
    expect(meshes[1]?.material).not.toBe(plain[1])
    view.dispose()
  })

  /**
   * The shadow pass is deliberately untouched. A surface whose pixels are gone still shades the level, so
   * the world does not brighten as the camera moves — a hole in a shadow is not a thing. The character
   * standing under it is in shade, which is correct, and the AO pass is what needed fixing instead.
   */
  it('leaves the shadow pass alone', () => {
    const { view, meshes } = built([10])
    view.setOccluders([10])
    expect(meshes[0]?.customDepthMaterial).toBeUndefined()
    expect(meshes[0]?.castShadow).toBe(true)
    view.dispose()
  })

  /** What the AO pass has to skip, and only that: the surfaces actually wearing a hole. */
  it('reports which meshes are wearing a hole', () => {
    const { view, meshes } = built([10], [20])
    expect(view.occluding()).toEqual([])
    view.setOccluders([20])
    expect(view.occluding()).toEqual([meshes[1]])
    view.setOccluders([])
    expect(view.occluding()).toEqual([])
    view.dispose()
  })

  it('ignores a handle that draws nothing', () => {
    const { view, meshes, plain } = built([10])
    expect(() => view.setOccluders([999])).not.toThrow()
    expect(meshes[0]?.material).toBe(plain[0])
    view.dispose()
  })

  // A node drawing a model has one visual for all of its colliders, so a hit on any of them is a hit on
  // that mesh. Greybox pieces list one apiece; this is the case that would silently do nothing.
  it('masks a mesh that several colliders point at', () => {
    const { view, meshes, plain } = built([1, 2, 3])
    view.setOccluders([3])
    expect(meshes[0]?.material).not.toBe(plain[0])
    view.dispose()
  })

  it('does nothing at all without a mask, so the editor and the viewer pay nothing', () => {
    const scene = new THREE.Scene()
    const view = addLevel(scene, [visual([10])])
    const mesh = view.group.children[0] as THREE.Mesh
    const before = mesh.material
    view.setOccluders([10])
    expect(mesh.material).toBe(before)
    view.dispose()
  })
})

/** What a sequence does to a drawn piece (ADR 0137): shown or not, stretched, faded on a copy of its own. */
describe('sync', () => {
  const two = () => {
    const scene = new THREE.Scene()
    const faded = { ...visual([1]), fades: true }
    const other = visual([2])
    const view = addLevel(scene, [faded, other], { cutout: mask() })
    const meshes = view.group.children.map((o) => o as THREE.Mesh)
    return { view, faded, other, meshes }
  }

  it('gives a fadeable piece its own transparent material, and leaves the rest shared', () => {
    const { view, meshes } = two()
    const own = meshes[0]!.material as THREE.Material
    expect(own.transparent).toBe(true)
    expect((meshes[1]!.material as THREE.Material).transparent).toBe(false)
    view.dispose()
  })

  it('fades, stretches and hides from the visual it draws', () => {
    const { view, faded, other, meshes } = two()
    faded.opacity = 0.25
    faded.drawScale = { x: 2, y: 1, z: 3 }
    other.visible = false
    view.sync()
    expect((meshes[0]!.material as THREE.Material).opacity).toBeCloseTo(0.25, 9)
    expect(meshes[0]!.scale.toArray()).toEqual([2, 1, 3])
    expect(meshes[1]!.visible).toBe(false)
    view.dispose()
  })

  /** A transparent mesh still casts a full shadow, so faded all the way out it is not drawn at all. */
  it('draws nothing of a piece faded all the way out', () => {
    const { view, faded, meshes } = two()
    faded.opacity = 0
    view.sync()
    expect(meshes[0]!.visible).toBe(false)
    view.dispose()
  })

  it('fades the see-through hole’s copy along with it', () => {
    const { view, faded, meshes } = two()
    view.setOccluders([1])
    faded.opacity = 0.5
    view.sync()
    expect((meshes[0]!.material as THREE.Material).opacity).toBeCloseTo(0.5, 9)
    view.dispose()
  })
})

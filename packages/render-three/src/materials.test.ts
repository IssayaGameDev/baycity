import type { ColliderDesc } from '@mp/content'
import { vec3 } from '@mp/core'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { BEVEL_RADIUS, bevelFor, geometryForBuiltin, geometryForCollider, outlineGeometryForCollider } from './materials'

/**
 * The standard bevel (ADR 0044).
 *
 * Two properties matter and neither is visible by eye: a beveled box must still *fill* its collider, and the
 * bevel must never eat a whole face.
 */

const box = (hx: number, hy: number, hz: number): ColliderDesc => ({ kind: 'box', halfExtents: vec3(hx, hy, hz) })

const sizeOf = (g: THREE.BufferGeometry): THREE.Vector3 => {
  g.computeBoundingBox()
  const b = g.boundingBox
  if (b === null) throw new Error('no bounding box')
  return b.getSize(new THREE.Vector3())
}

/** Line segments a wireframe overlay would draw. A sharp box has twelve. */
const edgeCount = (g: THREE.BufferGeometry): number => new THREE.EdgesGeometry(g).attributes.position!.count / 2

describe('bevelFor', () => {
  // Sized off the constant rather than hardcoded, so tuning `BEVEL_RADIUS` cannot make this a lie.
  it('gives the standard radius to anything thick enough to carry it', () => {
    const thick = BEVEL_RADIUS * 10
    expect(bevelFor(thick, thick, thick)).toBe(BEVEL_RADIUS)
  })

  /**
   * The one that matters. Three clamps at *half* the shortest side, which is where the flat face disappears
   * and a plate becomes a pill; a quarter keeps half of every face flat.
   */
  it('backs off on a thin plate instead of rounding it into a tube', () => {
    expect(bevelFor(4, 0.06, 4)).toBeCloseTo(0.015, 6)
    expect(bevelFor(4, 0.06, 4)).toBeLessThan(0.06 / 2)
  })

  it('honours a caller that wants less, which is how the rig overrides it', () => {
    expect(bevelFor(4, 1, 4, 0)).toBe(0)
    expect(bevelFor(4, 1, 4, 0.01)).toBe(0.01)
  })

  it('never goes negative on a degenerate collider', () => {
    expect(bevelFor(0, 0, 0)).toBe(0)
  })
})

describe('geometryForCollider', () => {
  it('draws a box as a rounded cuboid', () => {
    expect(edgeCount(geometryForCollider(box(2, 0.5, 2)))).toBeGreaterThan(12)
  })

  // A bevel is cut *inward*, so the mesh still reaches every face of the collider it stands in for. If this
  // ever fails, solids stop meeting flush and every seam in a level shows a gap.
  it('keeps the collider silhouette exactly', () => {
    const size = sizeOf(geometryForCollider(box(2, 0.5, 3)))
    expect(size.x).toBeCloseTo(4, 6)
    expect(size.y).toBeCloseTo(1, 6)
    expect(size.z).toBeCloseTo(6, 6)
  })

  it('leaves a plate too thin to bevel dimensionally correct too', () => {
    const size = sizeOf(geometryForCollider(box(2, 0.01, 2)))
    expect(size.y).toBeCloseTo(0.02, 6)
  })

  it('leaves the already-round kinds alone', () => {
    expect(geometryForCollider({ kind: 'ball', radius: 1 })).toBeInstanceOf(THREE.SphereGeometry)
    expect(geometryForCollider({ kind: 'capsule', radius: 0.4, halfHeight: 0.5 })).toBeInstanceOf(THREE.CapsuleGeometry)
    expect(geometryForCollider({ kind: 'cylinder', radius: 0.4, halfHeight: 0.5 })).toBeInstanceOf(THREE.CylinderGeometry)
  })
})

describe('outlineGeometryForCollider', () => {
  /** What the viewer's collider x-ray is built from: the bevel seams would read as hatching. */
  it('gives a box twelve edges', () => {
    expect(edgeCount(outlineGeometryForCollider(box(2, 0.5, 2)))).toBe(12)
  })

  it('is the same shape for everything else', () => {
    const c: ColliderDesc = { kind: 'ball', radius: 1 }
    expect(sizeOf(outlineGeometryForCollider(c))).toEqual(sizeOf(geometryForCollider(c)))
  })
})

/** A quad (ADR 0189) is one face toward +Z at its scale, its texture once — not its centimetre-thick collider. */
describe('the built-in quad', () => {
  it('is a single plane facing +Z, sized by the scale', () => {
    const g = geometryForBuiltin('builtin:quad', { x: 4, y: 2, z: 1 })
    g.computeBoundingBox()
    const size = g.boundingBox!.getSize(new THREE.Vector3())
    expect([size.x, size.y, size.z]).toEqual([4, 2, 0])
    expect(g.getAttribute('normal').getZ(0)).toBe(1)
    expect(g.getAttribute('position').count).toBe(4)
  })
})

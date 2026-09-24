import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { geometryForBuiltin, geometryForCollider } from './materials'
import { shapeEdges } from './shapeEdges'

/** A shape's edges for the selection (ADR 0146): where its faces meet, never its triangles. */

const segments = (g: THREE.BufferGeometry | null): number => (g === null ? 0 : g.getAttribute('position').count / 2)
const pointsOf = (g: THREE.BufferGeometry): THREE.Vector3[] => {
  const p = g.getAttribute('position')
  return Array.from({ length: p.count }, (_, i) => new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)))
}

describe('a shape’s edges', () => {
  it('gives a box its twelve edges', () => {
    expect(segments(shapeEdges(geometryForBuiltin('builtin:box', { x: 2, y: 1, z: 3 })))).toBe(12)
  })

  it('gives a rounded box one line along the middle of each rounded edge, on its surface', () => {
    const geometry = geometryForBuiltin('builtin:rounded-box', { x: 2, y: 1, z: 3 })
    const edges = shapeEdges(geometry)!
    expect(segments(edges)).toBe(12)
    // A quarter of the 1 m side is the bevel (`bevelFor`); an edge sits where its arc is at 45°, and runs the
    // straight length between the corners.
    const r = 0.25
    const out = (half: number): number => half - r + r * Math.SQRT1_2
    const along = (half: number): number => half - r
    const key = (p: THREE.Vector3): string => [p.x, p.y, p.z].map((v) => Math.abs(v).toFixed(4)).join(',')
    expect(new Set(pointsOf(edges).map(key))).toEqual(
      new Set([
        [along(1), out(0.5), out(1.5)],
        [out(1), along(0.5), out(1.5)],
        [out(1), out(0.5), along(1.5)],
      ].map(([x, y, z]) => key(new THREE.Vector3(x, y, z)))),
    )
  })

  it('gives a cylinder its two rims, and a sphere or a capsule nothing — they have no edges', () => {
    expect(segments(shapeEdges(geometryForCollider({ kind: 'cylinder', radius: 0.5, halfHeight: 1 })))).toBe(56)
    expect(shapeEdges(geometryForBuiltin('builtin:sphere', { x: 1, y: 1, z: 1 }))).toBeNull()
    expect(shapeEdges(geometryForBuiltin('builtin:capsule', { x: 1, y: 2, z: 1 }))).toBeNull()
  })
})

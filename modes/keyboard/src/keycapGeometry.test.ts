import { THREE } from '@mp/render-three'
import { describe, expect, it } from 'vitest'

import { DEFAULT_KEYCAP_SHAPE, keycapGeometry } from './keycapGeometry'

/**
 * The keycap, as arithmetic (ADR 0069).
 *
 * Worth testing headlessly because every way this fails is **invisible or baffling on screen**: an off-by-one
 * index draws nothing, reversed winding turns the cap inside out, a stray `NaN` deletes the whole instanced
 * mesh, and a wrong y range floats every cap above its platform or sinks it inside.
 */

const S = DEFAULT_KEYCAP_SHAPE

const points = (g: THREE.BufferGeometry): { x: number; y: number; z: number }[] => {
  const a = g.getAttribute('position')
  return Array.from({ length: a.count }, (_, i) => ({ x: a.getX(i), y: a.getY(i), z: a.getZ(i) }))
}

describe('the keycap geometry', () => {
  it('is a unit cap: base at y 0, rim at y 1, half a unit across', () => {
    const p = points(keycapGeometry())
    const ys = p.map((v) => v.y)
    expect(Math.min(...ys)).toBeCloseTo(0, 6)
    expect(Math.max(...ys)).toBeCloseTo(1, 6)
    // The instance matrix scales by (capSize, capHeight, capSize), so anything wider than half a unit would
    // make caps overlap their neighbours.
    for (const v of p) {
      expect(Math.abs(v.x)).toBeLessThanOrEqual(0.5 + 1e-6)
      expect(Math.abs(v.z)).toBeLessThanOrEqual(0.5 + 1e-6)
    }
  })

  it('tapers: the top is narrower than the base', () => {
    const p = points(keycapGeometry())
    const widestAtBase = Math.max(...p.filter((v) => v.y < 1e-6).map((v) => Math.abs(v.x)))
    const widestAtRim = Math.max(...p.filter((v) => Math.abs(v.y - 1) < 1e-6).map((v) => Math.abs(v.x)))
    expect(widestAtBase).toBeCloseTo(0.5, 6)
    expect(widestAtRim).toBeCloseTo(0.5 * S.taper, 6)
  })

  it('is dished: the middle of the top sits below the rim', () => {
    const p = points(keycapGeometry())
    // The centre vertex is the only one on the axis.
    const middle = p.filter((v) => Math.hypot(v.x, v.z) < 1e-6)
    expect(middle).toHaveLength(1)
    expect(middle[0]!.y).toBeCloseTo(1 - S.dish, 6)
  })

  it('has rounded corners: the diagonal is pulled in from a square', () => {
    const p = points(keycapGeometry({ ...S, roundness: 4 }))
    const base = p.filter((v) => v.y < 1e-6)
    const corner = Math.max(...base.map((v) => Math.hypot(v.x, v.z)))
    // A square corner would be 0.5√2 ≈ 0.707. Rounded, it has to be meaningfully less.
    expect(corner).toBeLessThan(0.68)
    expect(corner).toBeGreaterThan(0.5)
  })

  it('approaches a square as roundness rises', () => {
    const cornerOf = (roundness: number): number => {
      const base = points(keycapGeometry({ ...S, roundness })).filter((v) => v.y < 1e-6)
      return Math.max(...base.map((v) => Math.hypot(v.x, v.z)))
    }
    expect(cornerOf(20)).toBeGreaterThan(cornerOf(3))
  })

  it('has no NaN anywhere, which would silently delete the whole mesh', () => {
    const g = keycapGeometry()
    for (const name of ['position', 'uv', 'normal']) {
      const a = g.getAttribute(name)
      expect(a).toBeDefined()
      for (let i = 0; i < a.array.length; i += 1) expect(Number.isFinite(a.array[i] as number)).toBe(true)
    }
  })

  it('indexes only vertices it has', () => {
    const g = keycapGeometry()
    const count = g.getAttribute('position').count
    const idx = g.getIndex()
    expect(idx).not.toBeNull()
    for (let i = 0; i < idx!.count; i += 1) {
      const v = idx!.getX(i)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(count)
    }
    // Whole triangles only.
    expect(idx!.count % 3).toBe(0)
  })

  /**
   * Reversed winding turns the cap inside out, which reads as a hole rather than as an error.
   *
   * Split by **index**, not by height: the dish brings the inner top rings down to y 0.73, so classifying by
   * height counts them as wall and the assertion asks the top's normals to point sideways. The wall is the
   * first `2 × segments` vertices by construction — base ring then rim ring — and everything after is the top.
   */
  it('winds outward on the wall and upward on the top', () => {
    const g = keycapGeometry()
    const p = points(g)
    const n = g.getAttribute('normal')
    const wallCount = S.segments * 2

    for (let i = 0; i < wallCount; i += 1) {
      const v = p[i]!
      const radial = Math.hypot(v.x, v.z)
      expect(radial).toBeGreaterThan(0)
      // Away from the axis.
      expect((n.getX(i) * v.x + n.getZ(i) * v.z) / radial).toBeGreaterThan(0)
    }
    for (let i = wallCount; i < p.length; i += 1) expect(n.getY(i)).toBeGreaterThan(0)
  })

  it('keeps the legend on the top and one flat point on the walls', () => {
    const g = keycapGeometry()
    const uv = g.getAttribute('uv')
    const wallCount = S.segments * 2

    // Every wall vertex on the same texel: flat colour, nothing to stretch.
    const wallUvs = new Set<string>()
    for (let i = 0; i < wallCount; i += 1) wallUvs.add(`${uv.getX(i)},${uv.getY(i)}`)
    expect(wallUvs.size).toBe(1)

    // Every top vertex inside the legend tile, which is the left half.
    for (let i = wallCount; i < uv.count; i += 1) {
      expect(uv.getX(i)).toBeGreaterThanOrEqual(0)
      expect(uv.getX(i)).toBeLessThanOrEqual(0.5 + 1e-6)
    }
  })

  /**
   * Which way round the legend reads.
   *
   * A player runs along +z with the camera behind, so the camera's right is world −x. `u` therefore has to
   * fall as `x` rises; the other way draws every letter mirrored, which is exactly what shipped first.
   */
  it('maps the legend the way the camera reads it', () => {
    const g = keycapGeometry()
    const p = points(g)
    const uv = g.getAttribute('uv')
    const wallCount = S.segments * 2

    let east = { u: 0, x: -Infinity }
    let west = { u: 0, x: Infinity }
    let north = { v: 0, z: -Infinity }
    let south = { v: 0, z: Infinity }
    for (let i = wallCount; i < p.length; i += 1) {
      const v = p[i]!
      if (v.x > east.x) east = { u: uv.getX(i), x: v.x }
      if (v.x < west.x) west = { u: uv.getX(i), x: v.x }
      if (v.z > north.z) north = { v: uv.getY(i), z: v.z }
      if (v.z < south.z) south = { v: uv.getY(i), z: v.z }
    }
    // Screen-right is world −x, so more x means less u.
    expect(east.u).toBeLessThan(west.u)
    // Screen-up is world +z, and v 1 is the canvas's top row.
    expect(north.v).toBeGreaterThan(south.v)
  })

  /**
   * The budget, and it is a real one.
   *
   * Instancing shares the upload, not the drawing: every cap is drawn in the shadow map, the GTAO prepass and
   * the colour pass. 352 triangles a cap put 384k a frame through a 364-cap level and tanked the frame rate.
   */
  it('stays inside the triangle budget for a whole level', () => {
    const tris = keycapGeometry().getIndex()!.count / 3
    expect(tris).toBeLessThanOrEqual(100)
    // Two passes now that the caps do not cast shadows.
    expect(tris * 364 * 2).toBeLessThan(80_000)
  })
})

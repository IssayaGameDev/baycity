import { vec3, type Vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { curvedBeam, curvedBeamExit, padChain, spiralStaircase, staircase } from './generators'

describe('generators', () => {
  it('staircase emits N steps ascending along +x and +y', () => {
    const s = staircase({ steps: 6, stepRun: 1.5, stepRise: 0.5 })
    expect(s.pieces).toHaveLength(6)
    const ys = s.pieces.map((p) => p.transform.position.y)
    const xs = s.pieces.map((p) => p.transform.position.x)
    // strictly ascending in both x and y
    for (let i = 1; i < s.pieces.length; i++) {
      expect(ys[i]!).toBeGreaterThan(ys[i - 1]!)
      expect(xs[i]!).toBeGreaterThan(xs[i - 1]!)
    }
    expect(ys[5]).toBeCloseTo(2.5, 6) // 5 * 0.5
    expect(xs[5]).toBeCloseTo(7.5, 6) // 5 * 1.5
  })

  it('padChain leaves the requested gap between pad edges, not between centres', () => {
    const padSize = 1.2
    const gap = 2.5
    const c = padChain({ pads: 4, padSize, gap })
    expect(c.pieces).toHaveLength(4)
    const halfX = (i: number): number => {
      const col = c.pieces[i]!.collider
      if (col.kind !== 'box') throw new Error('pads are boxes')
      return col.halfExtents.x
    }
    for (let i = 1; i < c.pieces.length; i++) {
      const trailingEdge = c.pieces[i - 1]!.transform.position.x + halfX(i - 1)
      const leadingEdge = c.pieces[i]!.transform.position.x - halfX(i)
      // The number the player's jump has to cover.
      expect(leadingEdge - trailingEdge).toBeCloseTo(gap, 6)
    }
  })

  it('padChain rises and zig-zags, and the zig-zag lengthens the real jump', () => {
    const gap = 2.2
    const lateral = 2
    const c = padChain({ pads: 5, padSize: 1.2, gap, rise: 1, lateral })
    const zs = c.pieces.map((p) => p.transform.position.z)
    const ys = c.pieces.map((p) => p.transform.position.y)
    // Alternating either side of the centre line, so consecutive pads differ by the full offset.
    expect(zs[0]).toBeCloseTo(-lateral / 2, 6)
    expect(zs[1]).toBeCloseTo(lateral / 2, 6)
    for (let i = 1; i < zs.length; i++) expect(Math.abs(zs[i]! - zs[i - 1]!)).toBeCloseTo(lateral, 6)
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeCloseTo(1, 6)
    // The jump is the diagonal, which is what has to fit the movement envelope.
    expect(Math.hypot(gap, lateral)).toBeCloseTo(2.973, 3)
  })

  it('curvedBeam segments are convex prisms whose centres lie on the arc', () => {
    const radius = 8
    const c = curvedBeam({ radius, sweepDeg: 90, width: 0.8, segments: 12 })
    expect(c.pieces).toHaveLength(12)
    for (const p of c.pieces) {
      const q = p.transform.position
      // Segment origin is its mid-arc point: distance to the arc centre (0,0,radius) is the radius.
      expect(Math.hypot(q.x, q.z - radius)).toBeCloseTo(radius, 6)
      expect(p.collider.kind).toBe('convex')
      if (p.collider.kind !== 'convex') return
      expect(p.collider.points).toHaveLength(8) // two cross-sections of four corners
    }
  })

  it('curvedBeam is watertight: neighbouring prisms share their end-face corners exactly', () => {
    // This is the property a box chain cannot have. A swept segment's end faces are perpendicular to
    // the tangent, so they are not parallel to each other; boxes therefore meet at an angle and
    // leave a notch at every join, no matter how finely subdivided.
    const c = curvedBeam({ radius: 5, sweepDeg: 120, width: 0.9, segments: 10 })
    const world = (i: number): Vec3[] => {
      const p = c.pieces[i]!
      if (p.collider.kind !== 'convex') throw new Error('expected convex')
      const o = p.transform.position
      return p.collider.points.map((q) => vec3(q.x + o.x, q.y + o.y, q.z + o.z))
    }
    for (let i = 1; i < c.pieces.length; i++) {
      const prevFar = world(i - 1).slice(4) // second cross-section of the previous prism
      const curNear = world(i).slice(0, 4) // first cross-section of this one
      for (let k = 0; k < 4; k++) {
        expect(prevFar[k]!.x).toBeCloseTo(curNear[k]!.x, 9)
        expect(prevFar[k]!.y).toBeCloseTo(curNear[k]!.y, 9)
        expect(prevFar[k]!.z).toBeCloseTo(curNear[k]!.z, 9)
      }
    }
  })

  it('curvedBeam subdivision bounds both surface deviation and facet angle at every radius', () => {
    // The two limits bind at opposite ends — deviation grows with radius, facet angle with
    // tightness — so both have to be asserted, at a wide sweep and at a hairpin.
    for (const radius of [2, 4, 8, 12, 30]) {
      const prefab = curvedBeam({ radius, sweepDeg: 90 })
      const delta = (90 * Math.PI) / 180 / prefab.pieces.length
      expect(radius * (1 - Math.cos(delta / 2)), `deviation at r=${radius}`).toBeLessThan(0.005) // 5 mm underfoot
      expect(delta, `facet angle at r=${radius}`).toBeLessThan((4.5 * Math.PI) / 180) // visible smoothness
    }
    // Per metre of surface, a tighter turn is more finely divided.
    const perMetre = (radius: number): number => curvedBeam({ radius, sweepDeg: 90 }).pieces.length / ((radius * Math.PI) / 2)
    expect(perMetre(4)).toBeGreaterThan(perMetre(12))
  })

  it('curvedBeamExit reports where the arc ends and how far it turned', () => {
    const opts = { radius: 6, sweepDeg: -120 }
    const e = curvedBeamExit(opts)
    const total = (120 * Math.PI) / 180
    expect(e.headingRad).toBeCloseTo(-total, 6) // negative sweep turns toward -z
    expect(e.position.x).toBeCloseTo(6 * Math.sin(total), 6)
    expect(e.position.z).toBeCloseTo(-6 * (1 - Math.cos(total)), 6)

    // A full circle returns to the start.
    const loop = curvedBeamExit({ radius: 5, sweepDeg: 360 })
    expect(Math.hypot(loop.position.x, loop.position.z)).toBeCloseTo(0, 6)
  })

  it('spiralStaircase winds around the axis at a constant radius, rising each step', () => {
    const radius = 5
    const s = spiralStaircase({ steps: 12, radius, stepRise: 0.5, stepAngleDeg: 30 })
    expect(s.pieces).toHaveLength(12)
    for (let i = 0; i < s.pieces.length; i++) {
      const p = s.pieces[i]!.transform.position
      expect(Math.hypot(p.x, p.z)).toBeCloseTo(radius, 6) // on the circle
      expect(p.y).toBeCloseTo(i * 0.5, 6) // rising
      expect(s.pieces[i]!.transform.rotation?.y).toBeCloseTo((-i * 30 * Math.PI) / 180, 6)
    }
  })
})

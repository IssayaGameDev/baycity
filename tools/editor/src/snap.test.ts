import { describe, expect, it } from 'vitest'

import { cornerSnapDelta, snapAnglesDeg, snapToGrid, worldHalfExtents } from './snap'

const deg = (radians: number): number => Number(((radians * 180) / Math.PI).toFixed(6))

describe('snapToGrid', () => {
  it('rounds to the nearest multiple, anchored at zero', () => {
    expect(snapToGrid(0.62, 0.5)).toBeCloseTo(0.5, 10)
    expect(snapToGrid(0.76, 0.5)).toBeCloseTo(1, 10)
    expect(snapToGrid(-0.76, 0.5)).toBeCloseTo(-1, 10)
  })

  /**
   * The point of anchoring at zero. Tweakpane's step and `TransformControls`'s rotation both anchor to the
   * value you started from, which means an off-grid value can never be brought back onto the grid (ADR 0113,
   * ADR 0114).
   */
  it('reaches a round number from an off-grid start', () => {
    expect(snapToGrid(32.9825, 0.5)).toBeCloseTo(33, 10)
    expect(snapToGrid(0.9999, 0.5)).toBeCloseTo(1, 10)
  })

  it('passes the value through when there is no step', () => {
    expect(snapToGrid(1.234, 0)).toBe(1.234)
    expect(snapToGrid(1.234, -1)).toBe(1.234)
  })
})

describe('snapAnglesDeg', () => {
  const at = (degrees: number) => (degrees * Math.PI) / 180

  it('lands on a multiple of the increment, not a multiple away from where it started', () => {
    // The case TransformControls cannot do. From 22° with a 15° increment, incremental snapping adds a round
    // amount and gives 37; absolute rounds to the nearest grid point and gives 15.
    expect(deg(snapAnglesDeg({ x: 0, y: at(22), z: 0 }, 15).y)).toBeCloseTo(15, 4)
    expect(deg(snapAnglesDeg({ x: 0, y: at(23), z: 0 }, 15).y)).toBeCloseTo(30, 4)
    // And nearest means nearest: 7° is closer to 0 than to 15.
    expect(deg(snapAnglesDeg({ x: 0, y: at(7), z: 0 }, 15).y)).toBeCloseTo(0, 4)
  })

  it('straightens a nearly-axis-aligned angle to zero', () => {
    // The stray -0.0004 rad kind of value: on a 15° grid it rounds away to nothing.
    expect(Math.abs(snapAnglesDeg({ x: -0.0004, y: 0, z: 0 }, 15).x)).toBe(0)
  })

  it('snaps each axis independently', () => {
    const out = snapAnglesDeg({ x: at(44), y: at(7), z: at(91) }, 45)
    expect(deg(out.x)).toBeCloseTo(45, 4)
    expect(deg(out.y)).toBeCloseTo(0, 4)
    expect(deg(out.z)).toBeCloseTo(90, 4)
  })

  it('keeps a right angle exactly where it is', () => {
    // 90° on a 15° grid is already a grid point, so snapping is the identity — no drift per drag.
    const out = snapAnglesDeg({ x: at(90), y: 0, z: at(90) }, 15)
    expect(deg(out.x)).toBeCloseTo(90, 4)
    expect(deg(out.z)).toBeCloseTo(90, 4)
  })

  it('passes through with no increment', () => {
    expect(snapAnglesDeg({ x: 1.23, y: 0, z: 0 }, 0)).toEqual({ x: 1.23, y: 0, z: 0 })
  })
})

describe('worldHalfExtents', () => {
  /** A rotation matrix's 3x3 part, column-major, as THREE.Matrix4.elements gives it. */
  const yaw = (deg: number): number[] => {
    const r = (deg * Math.PI) / 180
    const c = Math.cos(r)
    const s = Math.sin(r)
    // Column-major: columns are the rotated basis vectors.
    return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]
  }

  it('is the box itself when there is no rotation', () => {
    const out = worldHalfExtents(yaw(0), { x: 2, y: 0.5, z: 3 })
    expect(out.x).toBeCloseTo(2, 6)
    expect(out.y).toBeCloseTo(0.5, 6)
    expect(out.z).toBeCloseTo(3, 6)
  })

  it('swaps the two axes at a right angle, which is what a wall on its edge needs', () => {
    const out = worldHalfExtents(yaw(90), { x: 2, y: 0.5, z: 3 })
    expect(out.x).toBeCloseTo(3, 6)
    expect(out.y).toBeCloseTo(0.5, 6)
    expect(out.z).toBeCloseTo(2, 6)
  })

  it('reaches further along both axes at 45°, as a rotated box does', () => {
    const out = worldHalfExtents(yaw(45), { x: 1, y: 1, z: 1 })
    expect(out.x).toBeCloseTo(Math.SQRT2, 6)
    expect(out.z).toBeCloseTo(Math.SQRT2, 6)
  })
})

describe('cornerSnapDelta', () => {
  it('moves the minimum corner onto the grid', () => {
    const d = cornerSnapDelta({ x: 2.3, y: 0, z: -1.2 }, 1)
    // Nearest line, so 2.3 comes back to 2 and -1.2 goes out to -1.
    expect(d.x).toBeCloseTo(-0.3, 6)
    expect(d.z).toBeCloseTo(0.2, 6)
  })

  it('does nothing when the corner is already on it', () => {
    expect(cornerSnapDelta({ x: 3, y: 0, z: -2 }, 1)).toEqual({ x: 0, y: 0, z: 0 })
  })

  /**
   * The whole point (ADR 0117). A box an odd number of cells wide, centre-snapped, has its edges halfway
   * between grid lines; corner-snapped it fills whole cells whatever its size.
   */
  it('fills whole cells at any size, where centre snapping cannot', () => {
    for (const cells of [1, 2, 3, 4, 5, 7]) {
      const size = cells * 1
      // Centre snapping: put the centre on a line and see where the edges land.
      const centreLo = snapToGrid(4.37, 1) - size / 2
      const centreOnGrid = Math.abs(centreLo - Math.round(centreLo)) < 1e-9
      // Corner snapping: the low edge is on a line by construction, so the high edge is too.
      const cornerLo = 4.37 - size / 2 + cornerSnapDelta({ x: 4.37 - size / 2, y: 0, z: 0 }, 1).x
      expect(Math.abs(cornerLo - Math.round(cornerLo)), `${cells} cells`).toBeLessThan(1e-9)
      expect(Math.abs(cornerLo + size - Math.round(cornerLo + size)), `${cells} cells, far edge`).toBeLessThan(1e-9)
      // And centre snapping only manages it for the even ones.
      expect(centreOnGrid, `${cells} cells under centre snapping`).toBe(cells % 2 === 0)
    }
  })
})

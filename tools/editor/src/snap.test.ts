import { THREE } from '@mp/render-three'
import { describe, expect, it } from 'vitest'

import { roundAngle, snapAnglesDeg, snapMove, snapToGrid } from './snap'

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

describe('roundAngle', () => {
  /** What the Inspector shows: the group's quaternion read back as XYZ degrees, to four places. */
  const shown = (radians: { x: number; y: number; z: number }): { x: number; y: number; z: number } => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(radians.x, radians.y, radians.z, 'XYZ'))
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ')
    const r4 = (n: number): number => Math.round(THREE.MathUtils.radToDeg(n) * 1e4) / 1e4 + 0
    return { x: r4(e.x), y: r4(e.y), z: r4(e.z) }
  }
  const stored = (degrees: number): number => roundAngle(THREE.MathUtils.degToRad(degrees))

  /** Kodjo's report: 0 90 0 typed, 0 89.9998 0 on reselect. 90° about Y is XYZ's gimbal lock. */
  it('keeps 90 about Y at 90', () => {
    expect(shown({ x: 0, y: stored(90), z: 0 })).toEqual({ x: 0, y: 90, z: 0 })
  })

  it('is what rounding the radians got wrong', () => {
    const r4 = (n: number): number => Math.round(n * 1e4) / 1e4
    expect(shown({ x: 0, y: r4(Math.PI / 2), z: 0 }).y, 'the old storage').toBe(89.9998)
  })

  /** ±180 left out: the same angle, and the read-back is free to pick either sign. */
  it('reads back every whole degree as typed', () => {
    for (let d = -179; d <= 179; d++) {
      expect(shown({ x: 0, y: 0, z: stored(d) }).z, `${d}° about Z`).toBe(d)
      expect(shown({ x: stored(d), y: 0, z: 0 }).x, `${d}° about X`).toBe(d)
    }
    for (let d = -90; d <= 90; d++) expect(shown({ x: 0, y: stored(d), z: 0 }).y, `${d}° about Y`).toBe(d)
  })

  it('still rounds to four places of a degree', () => {
    expect(THREE.MathUtils.radToDeg(roundAngle(THREE.MathUtils.degToRad(12.345678)))).toBeCloseTo(12.3457, 10)
  })
})

describe('snapMove', () => {
  const v = (x: number, y: number, z: number) => ({ x, y, z })

  /**
   * Kodjo's case (ADR 0179): at 20, 41, 55 with a 0.5 step, one tick along X. The centre goes to 20.5 and Y and Z
   * stay put. Before, the corner was snapped on every axis, and a 0.35 m object ended at 20.175, 41.148, 55.153.
   */
  it('puts the centre on the grid along the axis dragged, and leaves the others where they were', () => {
    expect(snapMove(v(20.4, 41, 55), v(20, 41, 55), 0.5)).toEqual(v(20.5, 41, 55))
  })

  it('leaves an axis off the grid if the drag did not move it', () => {
    expect(snapMove(v(3.3, 41.148, 55.153), v(2.9, 41.148, 55.153), 0.5)).toEqual(v(3.5, 41.148, 55.153))
  })

  it('snaps both axes of a plane handle', () => {
    expect(snapMove(v(1.2, 7.13, 2.8), v(0, 7.13, 0), 0.5)).toEqual(v(1, 7.13, 3))
  })

  it('takes a trip through the matrices as not having moved', () => {
    expect(snapMove(v(4.6, 41 + 1e-13, 55 - 1e-13), v(4, 41, 55), 0.5)).toEqual(v(4.5, 41, 55))
  })

  it('passes the move through with no step', () => {
    expect(snapMove(v(1.23, 4, 5), v(1, 4, 5), 0)).toEqual(v(1.23, 4, 5))
  })

  /**
   * Local handles on a turned object (ADR 0179): whole steps along the handle from where it started — Unity's
   * increment snap — since a world grid cannot be followed along a tilted axis.
   */
  it('steps along a turned object’s own axis with local handles, from where it started', () => {
    const yaw45 = { x: 0, y: Math.sin(Math.PI / 8), z: 0, w: Math.cos(Math.PI / 8) }
    const along = (d: number) => v(10 + d * Math.SQRT1_2, 2, 5 - d * Math.SQRT1_2) // local +X turned 45° about Y
    const out = snapMove(along(0.7), v(10, 2, 5), 0.5, yaw45)
    const want = along(0.5)
    expect(out.x).toBeCloseTo(want.x, 9)
    expect(out.y).toBeCloseTo(2, 9)
    expect(out.z).toBeCloseTo(want.z, 9)
  })
})

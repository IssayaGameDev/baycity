import { describe, expect, it } from 'vitest'

import { snapAnglesDeg, snapToGrid } from './snap'

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

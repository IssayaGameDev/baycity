import { describe, expect, it } from 'vitest'

import { lastRatio, normalizePoints, sampleCurve } from './curve'

const LIN = { interpolation: 'linear', beyond: 'extend' } as const
const HOLD = { interpolation: 'linear', beyond: 'hold' } as const
const RATIO = { interpolation: 'ratio', beyond: 'extend' } as const

describe('normalizePoints', () => {
  it('sorts, dedupes equal x (later wins), refuses anything that is not a point list', () => {
    expect(normalizePoints([{ x: 5, y: 1 }, { x: 0, y: 2 }, { x: 5, y: 9 }])).toEqual([{ x: 0, y: 2 }, { x: 5, y: 9 }])
    expect(normalizePoints([])).toBeNull()
    expect(normalizePoints([{ x: 'a', y: 1 }])).toBeNull()
    expect(normalizePoints([{ x: 1, y: Number.NaN }])).toBeNull()
    expect(normalizePoints(3)).toBeNull()
  })
})

describe('sampleCurve', () => {
  const pts = [{ x: 0, y: 10 }, { x: 100, y: 210 }]
  it('is linear between points and extends the slope, or holds', () => {
    expect(sampleCurve(pts, 50, LIN)).toBe(110)
    expect(sampleCurve(pts, 150, LIN)).toBe(310)
    expect(sampleCurve(pts, 150, HOLD)).toBe(210)
    expect(sampleCurve(pts, -5, LIN)).toBe(10)
  })
  it('ratio: constant growth per unit x, exactly the geometric curve it replaces', () => {
    const cost = [{ x: 0, y: 100 }, { x: 1, y: 115 }]
    for (const L of [0, 1, 2, 10, 45, 200]) expect(sampleCurve(cost, L, RATIO)).toBeCloseTo(100 * 1.15 ** L, 6)
    // Two far-apart points give the same per-level ratio.
    const wide = [{ x: 0, y: 100 }, { x: 100, y: 100 * 1.15 ** 100 }]
    expect(sampleCurve(wide, 45, RATIO) / (100 * 1.15 ** 45)).toBeCloseTo(1, 9)
    expect(lastRatio(wide)).toBeCloseTo(1.15, 9)
  })
  it('a single point is constant; ratio never divides by zero', () => {
    expect(sampleCurve([{ x: 3, y: 7 }], 99, RATIO)).toBe(7)
    expect(Number.isFinite(sampleCurve([{ x: 0, y: 0 }, { x: 10, y: 100 }], 5, RATIO))).toBe(true)
  })
  it('finds the right segment among many', () => {
    const many = [0, 10, 20, 30, 40].map((x) => ({ x, y: x * x }))
    expect(sampleCurve(many, 25, LIN)).toBe(650)
    expect(sampleCurve(many, 10, LIN)).toBe(100)
  })
})

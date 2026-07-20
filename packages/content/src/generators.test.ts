import { describe, expect, it } from 'vitest'

import { spiralStaircase, staircase } from './generators'

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

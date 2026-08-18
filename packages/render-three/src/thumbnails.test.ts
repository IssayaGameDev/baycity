import { describe, expect, it } from 'vitest'

import { fitDistance } from './thumbnails'

/** Half-angle a sphere of `radius` subtends from `distance` — what must not exceed the camera's. */
const subtended = (radius: number, distance: number): number => Math.asin(radius / distance)

describe('fitDistance', () => {
  it('puts the sphere exactly at the frame edge when fill is 1', () => {
    const vFov = 35
    const d = fitDistance(1, vFov, 1, 1)
    expect(subtended(1, d)).toBeCloseTo((vFov * Math.PI) / 360, 6)
  })

  it('scales linearly with the subject', () => {
    const small = fitDistance(1, 35, 1, 0.85)
    expect(fitDistance(4, 35, 1, 0.85)).toBeCloseTo(small * 4, 6)
  })

  it('pulls back for a lower fill, leaving air around the subject', () => {
    expect(fitDistance(1, 35, 1, 0.5)).toBeGreaterThan(fitDistance(1, 35, 1, 0.9))
  })

  it('moves closer as the field of view widens', () => {
    expect(fitDistance(1, 60, 1, 0.9)).toBeLessThan(fitDistance(1, 30, 1, 0.9))
  })

  // The reason this uses sin and not tan: what has to fit is the silhouette of a sphere, which is a
  // tangent line from the eye, not a plane through the centre. `tan` would sit too close and crop it.
  it('fits the silhouette, not a slice through the centre', () => {
    const vFov = 35
    const d = fitDistance(1, vFov, 1, 1)
    const tanDistance = 1 / Math.tan((vFov * Math.PI) / 360)
    expect(d).toBeGreaterThan(tanDistance)
  })

  it('respects the tighter axis of a non-square frame', () => {
    // A wide frame is tight vertically, so widening it must not let the subject creep out of the top.
    const wide = fitDistance(1, 35, 2, 1)
    const square = fitDistance(1, 35, 1, 1)
    expect(wide).toBeCloseTo(square, 6)

    // A tall frame is tight horizontally, so it has to pull back further than the square case.
    expect(fitDistance(1, 35, 0.5, 1)).toBeGreaterThan(square)
  })

  it('does not divide by zero for a degenerate subject', () => {
    expect(fitDistance(0, 35, 1, 0.9)).toBe(1)
    expect(Number.isFinite(fitDistance(1, 35, 1, 0))).toBe(true)
  })
})

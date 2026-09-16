import { describe, expect, it } from 'vitest'

import { distanceAlongAxis, faceFromNormal, pulled, snappedPull } from './facePull'

const v = (x: number, y: number, z: number) => ({ x, y, z })

describe('faceFromNormal', () => {
  it('names each of the six faces', () => {
    expect(faceFromNormal(v(1, 0, 0))).toEqual({ axis: 'x', sign: 1 })
    expect(faceFromNormal(v(-1, 0, 0))).toEqual({ axis: 'x', sign: -1 })
    expect(faceFromNormal(v(0, 1, 0))).toEqual({ axis: 'y', sign: 1 })
    expect(faceFromNormal(v(0, -1, 0))).toEqual({ axis: 'y', sign: -1 })
    expect(faceFromNormal(v(0, 0, 1))).toEqual({ axis: 'z', sign: 1 })
    expect(faceFromNormal(v(0, 0, -1))).toEqual({ axis: 'z', sign: -1 })
  })

  /** A rounded box's fillets point between two axes, and a rounded box is one of the two shapes this works on. */
  it('picks the face a fillet belongs to', () => {
    expect(faceFromNormal(v(0.9, 0.4, 0.1))).toEqual({ axis: 'x', sign: 1 })
    expect(faceFromNormal(v(-0.2, -0.95, 0.2))).toEqual({ axis: 'y', sign: -1 })
    expect(faceFromNormal(v(0.3, 0.3, -0.9))).toEqual({ axis: 'z', sign: -1 })
  })

  it('gives null for no direction at all', () => {
    expect(faceFromNormal(v(0, 0, 0))).toBeNull()
  })
})

describe('distanceAlongAxis', () => {
  it('measures along the line, not along the ray', () => {
    // A ray straight down at x = 3, against the x axis through the origin: nearest point is x = 3.
    const t = distanceAlongAxis(v(3, 5, 0), v(0, -1, 0), v(0, 0, 0), v(1, 0, 0))
    expect(t).toBeCloseTo(3, 6)
  })

  it('is signed', () => {
    expect(distanceAlongAxis(v(-2, 5, 0), v(0, -1, 0), v(0, 0, 0), v(1, 0, 0))).toBeCloseTo(-2, 6)
  })

  it('measures from the line origin, not from the world origin', () => {
    expect(distanceAlongAxis(v(3, 5, 0), v(0, -1, 0), v(1, 0, 0), v(1, 0, 0))).toBeCloseTo(2, 6)
  })

  it('works at an angle', () => {
    // Ray from above-left heading down-right at 45 degrees crosses x = 4 at y = 0.
    const t = distanceAlongAxis(v(0, 4, 0), v(Math.SQRT1_2, -Math.SQRT1_2, 0), v(0, 0, 0), v(1, 0, 0))
    expect(t).toBeCloseTo(4, 6)
  })

  /** Looking straight down the axis there is no nearest point; the caller holds its last value. */
  it('gives null when the ray runs along the line', () => {
    expect(distanceAlongAxis(v(-5, 0, 0), v(1, 0, 0), v(0, 0, 0), v(1, 0, 0))).toBeNull()
  })
})

describe('snappedPull', () => {
  /**
   * Snapping where the face **lands**, not how far it moved. Snapping the movement would anchor the grid to
   * wherever the face started, which is the fault ADR 0113, ADR 0114 and ADR 0117 each fixed in turn.
   */
  it('lands the face on the grid from an off-grid start', () => {
    // Face at 2.3, dragged 0.4 -> would be 2.7, snaps to 3, so the delta is 0.7.
    expect(snappedPull(2.3, 0.4, 1)).toBeCloseTo(0.7, 6)
  })

  it('can bring a face back onto the grid with a tiny drag', () => {
    expect(snappedPull(2.3, 0.05, 1)).toBeCloseTo(-0.3, 6)
  })

  it('passes the raw distance through with no step', () => {
    expect(snappedPull(2.3, 0.41, 0)).toBeCloseTo(0.41, 6)
  })
})

describe('pulled', () => {
  const scale = v(2, 1, 4)
  const position = v(10, 0, 0)

  it('grows the size by the distance and the centre by half, toward the face pulled', () => {
    const out = pulled(scale, position, { axis: 'x', sign: 1 }, 2, 0.1)
    expect(out.scale.x).toBeCloseTo(4, 6)
    expect(out.position.x).toBeCloseTo(11, 6)
  })

  it('moves the centre the other way for the opposite face', () => {
    const out = pulled(scale, position, { axis: 'x', sign: -1 }, 2, 0.1)
    expect(out.scale.x).toBeCloseTo(4, 6)
    expect(out.position.x).toBeCloseTo(9, 6)
  })

  /** The face that was not grabbed must not move. That is the whole difference from scaling. */
  it('leaves the opposite face exactly where it was', () => {
    for (const sign of [1, -1] as const) {
      const far = position.x - (sign * scale.x) / 2
      const out = pulled(scale, position, { axis: 'x', sign }, 1.7, 0.1)
      expect(out.position.x - (sign * out.scale.x) / 2, `sign ${sign}`).toBeCloseTo(far, 6)
    }
  })

  it('pulls inward too', () => {
    const out = pulled(scale, position, { axis: 'x', sign: 1 }, -1, 0.1)
    expect(out.scale.x).toBeCloseTo(1, 6)
    expect(out.position.x).toBeCloseTo(9.5, 6)
  })

  it('stops at the minimum instead of inverting', () => {
    const out = pulled(scale, position, { axis: 'x', sign: 1 }, -50, 0.5)
    expect(out.scale.x).toBe(0.5)
    // And the far face still has not moved, even though the pull was refused partway.
    expect(out.position.x - out.scale.x / 2).toBeCloseTo(position.x - scale.x / 2, 6)
  })

  it('touches only the axis pulled', () => {
    const out = pulled(scale, position, { axis: 'z', sign: 1 }, 1, 0.1)
    expect(out.scale.x).toBe(2)
    expect(out.scale.y).toBe(1)
    expect(out.scale.z).toBeCloseTo(5, 6)
    expect(out.position.x).toBe(10)
    expect(out.position.z).toBeCloseTo(0.5, 6)
  })
})

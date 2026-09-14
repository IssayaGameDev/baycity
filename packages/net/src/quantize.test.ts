import { describe, expect, it } from 'vitest'

import { boundOf, dequantizeAxis, quantizeAxis, QUANT_BOUND } from './quantize'

/** One step of the u16 scale. Asserted against rather than a fixed decimal place, so widening the
 * bound (ADR 0092) changes the tolerance with it instead of failing. */
const STEP = (2 * QUANT_BOUND) / 65535

describe('position quantization', () => {
  it('round-trips within 1 quantization step', () => {
    for (const v of [0, 1.5, -2.25, 10.123, -37.9, 540.5, -812.25, QUANT_BOUND, -QUANT_BOUND]) {
      expect(Math.abs(dequantizeAxis(quantizeAxis(v)) - v)).toBeLessThanOrEqual(STEP)
    }
  })

  it('clamps out-of-range values to the bound', () => {
    expect(dequantizeAxis(quantizeAxis(50_000))).toBeCloseTo(QUANT_BOUND, 2)
    expect(dequantizeAxis(quantizeAxis(-50_000))).toBeCloseTo(-QUANT_BOUND, 2)
  })

  it('takes a per-level bound, and carries further with a bigger one', () => {
    // A level that reaches 4 km: clamped at the default, carried when the level says so (ADR 0093).
    expect(dequantizeAxis(quantizeAxis(3200), QUANT_BOUND)).toBeCloseTo(QUANT_BOUND, 2)
    expect(dequantizeAxis(quantizeAxis(3200, 4000), 4000)).toBeCloseTo(3200, 0)
  })

  it('buys precision back when a level is small', () => {
    // The trade runs the other way too: a 100 m level gets a 3 mm step instead of 3 cm.
    const fine = (2 * 100) / 65535
    expect(Math.abs(dequantizeAxis(quantizeAxis(37.913, 100), 100) - 37.913)).toBeLessThanOrEqual(fine)
    expect(fine).toBeLessThan(0.004)
  })

  it('falls back to the default for a bound that is absent or nonsense', () => {
    // validateConfig refuses these at the door; boundOf exists so a relay never divides by zero or NaNs
    // every position in the room if one gets through anyway.
    for (const v of [undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(boundOf(v)).toBe(QUANT_BOUND)
    expect(boundOf(250)).toBe(250)
  })

  it('carries a level that used to clamp', () => {
    // The swing level runs to z = 54 and keyboard's last board sits at z = 51.5; both were pinned at
    // 40 on the wire before ADR 0092.
    for (const z of [51.5, 54]) expect(dequantizeAxis(quantizeAxis(z))).toBeCloseTo(z, 1)
  })

  it('produces u16 values', () => {
    expect(quantizeAxis(-QUANT_BOUND)).toBe(0)
    expect(quantizeAxis(QUANT_BOUND)).toBe(65535)
    expect(quantizeAxis(0)).toBeGreaterThan(0)
    expect(quantizeAxis(0)).toBeLessThan(65535)
  })
})

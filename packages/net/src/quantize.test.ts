import { describe, expect, it } from 'vitest'

import { dequantizeAxis, quantizeAxis, QUANT_BOUND } from './quantize'

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

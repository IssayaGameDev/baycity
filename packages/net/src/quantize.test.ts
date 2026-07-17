import { describe, expect, it } from 'vitest'

import { dequantizeAxis, quantizeAxis, QUANT_BOUND } from './quantize'

describe('position quantization', () => {
  it('round-trips within ~1 quantization step', () => {
    for (const v of [0, 1.5, -2.25, 10.123, -37.9, QUANT_BOUND, -QUANT_BOUND]) {
      expect(dequantizeAxis(quantizeAxis(v))).toBeCloseTo(v, 2)
    }
  })

  it('clamps out-of-range values to the bound', () => {
    expect(dequantizeAxis(quantizeAxis(1000))).toBeCloseTo(QUANT_BOUND, 2)
    expect(dequantizeAxis(quantizeAxis(-1000))).toBeCloseTo(-QUANT_BOUND, 2)
  })

  it('produces u16 values', () => {
    expect(quantizeAxis(-QUANT_BOUND)).toBe(0)
    expect(quantizeAxis(QUANT_BOUND)).toBe(65535)
    expect(quantizeAxis(0)).toBeGreaterThan(0)
    expect(quantizeAxis(0)).toBeLessThan(65535)
  })
})

import { describe, expect, it } from 'vitest'

import { tickStep, visibleSpan } from './timeline'

describe('visibleSpan', () => {
  // Headroom is what makes "drag a key to the right to make the track longer" work: without it the last key
  // sits on the edge of the strip with nowhere to go.
  it('shows more than the track lasts, so a key can be dragged past the end', () => {
    expect(visibleSpan(4000)).toBeGreaterThan(4000)
  })

  it('never collapses below a second, so a fresh one-key track has a readable ruler', () => {
    expect(visibleSpan(0)).toBe(1000)
    expect(visibleSpan(200)).toBe(1000)
  })

  it('grows with the track', () => {
    expect(visibleSpan(20_000)).toBeGreaterThan(visibleSpan(4000))
  })
})

describe('tickStep', () => {
  // A ruler labelled every 137ms is worse than no ruler, so the step comes from a 1/2/5 series.
  it('picks a round number', () => {
    for (const span of [1000, 3000, 4000, 12_000, 60_000]) {
      const step = tickStep(span, 800)
      const mantissa = step / Math.pow(10, Math.floor(Math.log10(step)))
      expect([1, 2, 5, 10], `span ${span} gave step ${step}`).toContain(Math.round(mantissa))
    }
  })

  it('keeps the label count sane at either width', () => {
    for (const width of [200, 400, 800, 2000]) {
      const ticks = 1000 / tickStep(1000, width)
      expect(ticks, `${width}px`).toBeGreaterThanOrEqual(1)
      expect(ticks, `${width}px`).toBeLessThanOrEqual(24)
    }
  })

  it('uses a coarser step for a longer track at the same width', () => {
    expect(tickStep(60_000, 800)).toBeGreaterThan(tickStep(2000, 800))
  })

  it('never returns zero, whatever it is handed', () => {
    expect(tickStep(0, 800)).toBeGreaterThan(0)
    expect(tickStep(1000, 0)).toBeGreaterThan(0)
  })
})

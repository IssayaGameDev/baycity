import { describe, expect, it } from 'vitest'

import { clampStart, fitSpan, tickStep } from './timeline'

describe('fitSpan', () => {
  // Headroom is what makes "drag a key to the right to make the track longer" work: without it the last key
  // sits on the edge of the strip with nowhere to go.
  it('shows more than the track lasts, so a key can be dragged past the end', () => {
    expect(fitSpan(4000)).toBeGreaterThan(4000)
  })

  it('never collapses below a second, so a fresh one-key track has a readable ruler', () => {
    expect(fitSpan(0)).toBe(1000)
    expect(fitSpan(200)).toBe(1000)
  })

  it('grows with the track', () => {
    expect(fitSpan(20_000)).toBeGreaterThan(fitSpan(4000))
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

/**
 * The view window may sit a little outside the track — that headroom is what lets a key be dragged past the
 * end to lengthen it — but never so far that the keys leave the panel entirely (ADR 0051).
 */
describe('clampStart', () => {
  it('allows a little slack before zero, so a key at t=0 is grabbable', () => {
    expect(clampStart(-50, 4000, 4000)).toBe(-50)
    expect(clampStart(-100_000, 4000, 4000), 'but not unbounded').toBe(-200)
  })

  it('refuses to pan past the end of the track', () => {
    expect(clampStart(999_999, 4000, 4000)).toBe(4200)
  })

  it('leaves a window inside the track alone', () => {
    expect(clampStart(1500, 1000, 4000)).toBe(1500)
  })

  it('still allows a window on an empty track, so a fresh one can be scrolled and zoomed', () => {
    expect(clampStart(0, 1000, 0)).toBe(0)
    expect(clampStart(500, 1000, 0)).toBe(50)
  })
})

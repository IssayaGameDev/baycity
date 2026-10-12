import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { SLIDE_SECONDS, slideOut, stepSlide, teleportRows } from './teleportWindow'

/** The teleport window (ADR 0203): what it lists, and how it slides. */
describe('the teleport window', () => {
  it('lists Start, facing kept, then every gate by number, facing its way', () => {
    const rows = teleportRows(vec3(0, 1, 0), [
      { number: 1, position: vec3(0, 2, 90), yaw: 0 },
      { number: 2, position: vec3(-160, 5, 440), yaw: Math.PI / 2 },
    ])
    expect(rows.map((r) => r.label)).toEqual(['Start', 'Checkpoint 1', 'Checkpoint 2'])
    expect(rows[0]!.to).toEqual({ position: vec3(0, 1, 0) })
    expect(rows[2]!.to).toEqual({ position: vec3(-160, 5, 440), yaw: Math.PI / 2 })
  })

  it('slides out in a quarter second, eased to a stop, and back the same way', () => {
    expect(SLIDE_SECONDS).toBe(0.25)
    expect(stepSlide(0, true, 0.125)).toBeCloseTo(0.5, 9)
    expect(stepSlide(0.5, true, 1), 'never past out').toBe(1)
    expect(stepSlide(0.5, false, 1), 'never past shut').toBe(0)
    // Out-cubic: most of the way in the first half, settling at the end.
    expect(slideOut(0.5)).toBeCloseTo(0.875, 9)
    expect(slideOut(1)).toBe(1)
  })

  it('turns back from wherever it is when closed mid-slide', () => {
    const half = stepSlide(0, true, 0.1)
    expect(stepSlide(half, false, 0.1)).toBeCloseTo(0, 9)
  })
})

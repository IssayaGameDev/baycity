import { describe, expect, it } from 'vitest'

import { easeCurvePath, easeName } from './easeCurve'
import { parseTyped, scrubbed, shownNumber } from './controls'

/** The sequence editor's controls (ADR 0147): how a dragged number moves, and how a typed one is read. */

describe('dragging a number', () => {
  const metres = { perPixel: 0.02, grain: 0.01 }

  it('moves by its rate per pixel and lands on its grain, with no float dust', () => {
    expect(scrubbed(1, 50, metres)).toBe(2)
    expect(scrubbed(0.1, 1, { perPixel: 0.1, grain: 0.1 })).toBe(0.2)
    expect(scrubbed(0, 7, { perPixel: 1, grain: 5 })).toBe(5)
  })

  it('is ten times finer with Shift, on a tenth of the grain', () => {
    expect(scrubbed(1, 50, metres, true)).toBe(1.1)
    expect(scrubbed(0, 3, { perPixel: 0.01, grain: 0.05 }, true)).toBe(0.005)
  })

  it('stays inside its bounds, and never shows a negative zero', () => {
    expect(scrubbed(0.5, -500, { perPixel: 0.01, grain: 0.05, min: 0 })).toBe(0)
    expect(Object.is(scrubbed(0.01, -1, metres), -0)).toBe(false)
    expect(scrubbed(90, 50, { perPixel: 0.5, grain: 1, min: 0, max: 100 })).toBe(100)
  })
})

describe('typing a number', () => {
  it('reads a real minus sign and a decimal comma, and refuses what is not a number', () => {
    expect([parseTyped('−2.5'), parseTyped('1,5'), parseTyped(' 3 '), parseTyped(''), parseTyped('abc')]).toEqual([-2.5, 1.5, 3, null, null])
  })

  it('shows at most three decimals', () => {
    expect([shownNumber(-9.61749), shownNumber(2), shownNumber(-0)]).toEqual(['-9.617', '2', '0'])
  })
})

describe('an ease’s picture', () => {
  const points = (d: string): [number, number][] => d.split(/[ML]/).filter((p) => p.trim() !== '').map((p) => p.trim().split(' ').map(Number) as [number, number])

  it('runs from the bottom left to the top right', () => {
    const p = points(easeCurvePath('linear', 20, 10, 1))
    expect(p[0]).toEqual([1, 9])
    expect(p.at(-1)).toEqual([19, 1])
  })

  it('keeps an overshoot inside the box instead of clipping it', () => {
    for (const ease of ['in-back', 'out-elastic', 'in-out-back'] as const) {
      for (const [x, y] of points(easeCurvePath(ease, 34, 22, 1.5))) {
        expect(x).toBeGreaterThanOrEqual(1.5)
        expect(y).toBeGreaterThanOrEqual(1.5 - 1e-9)
        expect(y).toBeLessThanOrEqual(20.5 + 1e-9)
      }
    }
  })

  it('is named the way a person says it', () => {
    expect([easeName('linear'), easeName('in-out-sine'), easeName('out-bounce')]).toEqual(['Linear', 'Sine in-out', 'Bounce out'])
  })
})

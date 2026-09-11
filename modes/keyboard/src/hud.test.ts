import { describe, expect, it } from 'vitest'

import { barWidthFor, hudScale } from './hud'

/** The HUD's response to the overlay's size: one scale factor, and a bar that never overflows the width. */
describe('hudScale', () => {
  it('is 1 at the desktop size it was laid out for, and never larger', () => {
    expect(hudScale(960, 540)).toBe(1)
    expect(hudScale(2560, 1440)).toBe(1)
  })

  it('shrinks with the tighter dimension', () => {
    // A landscape phone: height is the tight one.
    expect(hudScale(844, 390)).toBeCloseTo(390 / 540, 6)
    // The same phone in portrait: width is.
    expect(hudScale(390, 844)).toBeCloseTo(0.55, 6) // 390/960 = 0.41, floored at the readable minimum
  })

  it('never goes below the readable minimum', () => {
    expect(hudScale(200, 200)).toBe(0.55)
  })
})

describe('barWidthFor', () => {
  it('is the desktop bar, scaled, when the width allows', () => {
    expect(barWidthFor(960, 1)).toBe(520)
    expect(barWidthFor(844, 390 / 540)).toBeCloseTo(520 * (390 / 540), 6)
  })

  it('never exceeds the overlay less its margins', () => {
    // A portrait phone: the scaled bar (286 px) already fits, so that is what you get.
    const k = hudScale(390, 844)
    expect(barWidthFor(390, k)).toBeCloseTo(520 * k, 6)
    expect(barWidthFor(390, k)).toBeLessThan(390 - 2 * 18 * k)
    // Narrower still, and the width is the limit: the bar is clipped to it rather than shrunk further.
    expect(barWidthFor(300, k)).toBeCloseTo(300 - 2 * 18 * k, 6)
  })
})

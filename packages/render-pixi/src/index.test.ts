import { describe, expect, it } from 'vitest'

import { clampListScroll, listRowAt, RENDER_PIXI_VERSION } from './index'

describe('@mp/render-pixi', () => {
  it('exposes a version banner', () => {
    expect(RENDER_PIXI_VERSION).toBe('0.0.0')
  })
})

describe('a list that scrolls (ADR 0203)', () => {
  it('scrolls no further than its last row, and not at all when it all fits', () => {
    expect(clampListScroll(-500, 200, 600), 'past the end').toBe(-400)
    expect(clampListScroll(40, 200, 600), 'above the top').toBe(0)
    expect(clampListScroll(-120, 200, 600)).toBe(-120)
    expect(clampListScroll(-50, 200, 150), 'fits').toBe(0)
  })

  it('finds the row under a point, scrolled', () => {
    expect(listRowAt(10, 0, 40, 5)).toBe(0)
    expect(listRowAt(10, -80, 40, 5), 'two rows scrolled up').toBe(2)
    expect(listRowAt(199, 0, 40, 5)).toBe(4)
    expect(listRowAt(205, 0, 40, 5), 'below the last').toBe(-1)
  })
})

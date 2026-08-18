import { describe, expect, it } from 'vitest'

import { clampSize } from './splitter'

describe('clampSize', () => {
  it('adds the delta when there is room', () => {
    expect(clampSize(240, 50, 120, 600)).toBe(290)
    expect(clampSize(240, -50, 120, 600)).toBe(190)
  })

  it('stops at the minimum instead of collapsing the panel', () => {
    expect(clampSize(240, -500, 120, 600)).toBe(120)
  })

  it('stops at the maximum instead of squeezing the viewport out', () => {
    expect(clampSize(240, 5000, 120, 600)).toBe(600)
  })

  // A narrow window can leave no room at all: the panel's minimum then exceeds what is available.
  // Minimum has to win, or the panel inverts and the grid track goes negative.
  it('keeps the minimum when the window is too small to honour both', () => {
    expect(clampSize(240, 0, 120, 40)).toBe(120)
    expect(clampSize(240, -500, 120, 40)).toBe(120)
  })

  it('is exact at the boundaries', () => {
    expect(clampSize(120, 0, 120, 600)).toBe(120)
    expect(clampSize(600, 0, 120, 600)).toBe(600)
  })
})

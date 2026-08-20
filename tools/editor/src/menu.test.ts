import { describe, expect, it } from 'vitest'

import { menuPlacement, submenuPlacement } from './menu'

/**
 * Only the placement is tested here: it is the part that is pure, and the part whose failure is invisible
 * until somebody right-clicks near an edge — which, in a panel pinned to the right of the window, is most of
 * the time.
 */
const VIEW = { width: 1000, height: 800 }
const SIZE = { width: 180, height: 120 }

describe('where a menu opens', () => {
  it('sits at the pointer when there is room', () => {
    expect(menuPlacement({ x: 100, y: 200 }, SIZE, VIEW)).toEqual({ left: 100, top: 200 })
  })

  /**
   * Flipped, not clamped. A clamped menu sits *under* the pointer, so the first item is whatever the cursor
   * happens to be over — which is how a right-click near the edge becomes an accidental delete.
   */
  it('flips back over the pointer rather than sliding along the edge', () => {
    expect(menuPlacement({ x: 950, y: 200 }, SIZE, VIEW).left).toBe(950 - 180)
    expect(menuPlacement({ x: 100, y: 760 }, SIZE, VIEW).top).toBe(760 - 120)
  })

  it('flips both ways at once in the bottom-right corner, where the Inspector lives', () => {
    expect(menuPlacement({ x: 990, y: 790 }, SIZE, VIEW)).toEqual({ left: 810, top: 670 })
  })

  it('never goes off the top or the left, however small the window', () => {
    const tiny = { width: 120, height: 90 }
    const at = menuPlacement({ x: 10, y: 10 }, SIZE, tiny)
    expect(at.left).toBeGreaterThanOrEqual(4)
    expect(at.top).toBeGreaterThanOrEqual(4)
  })

  it('counts the margin as part of the overhang, so a menu never touches the edge', () => {
    // 820 + 180 = 1000 exactly, which fits only if the margin is ignored.
    expect(menuPlacement({ x: 820, y: 0 }, SIZE, VIEW).left).toBe(640)
    expect(menuPlacement({ x: 810, y: 0 }, SIZE, VIEW).left, 'ten pixels earlier there is room').toBe(810)
  })
})

describe('where a submenu opens', () => {
  const ITEM = { left: 100, right: 280, top: 200 }

  /**
   * Beside its parent item, not under the pointer: the pointer is somewhere on its way across the item, and
   * anchoring to it would put the child in a different place every time.
   */
  it('sits at the parent item’s right edge, overlapping it slightly', () => {
    const at = submenuPlacement(ITEM, SIZE, VIEW)
    expect(at.left, 'three pixels of overlap, so the diagonal travel has no gap to fall through').toBe(277)
    expect(at.top).toBe(200)
  })

  // A panel docked to the right of the window is where this happens, which is most of this editor.
  it('flips to the parent’s left when there is no room on the right', () => {
    const at = submenuPlacement({ left: 800, right: 980, top: 100 }, SIZE, VIEW)
    expect(at.left).toBe(800 - 180 + 3)
  })

  it('slides up rather than flipping when it would overhang the bottom', () => {
    const at = submenuPlacement({ left: 100, right: 280, top: 760 }, SIZE, VIEW)
    expect(at.top, 'a submenu that flipped upward would cover its own parent').toBe(800 - 120 - 4)
    expect(at.left, 'and it stays beside the item').toBe(277)
  })

  it('never goes off the left, however narrow the window', () => {
    expect(submenuPlacement({ left: 10, right: 40, top: 10 }, SIZE, { width: 100, height: 400 }).left).toBeGreaterThanOrEqual(4)
  })
})

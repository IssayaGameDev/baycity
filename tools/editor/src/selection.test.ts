import { describe, expect, it } from 'vitest'

import { applySelect, clampTo, defersToClick, modeFor, primaryOf, rangeIn, rootsOf, toggleIn } from './selection'

const mods = (over: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) => ({
  ctrlKey: over.ctrl ?? false,
  metaKey: over.meta ?? false,
  shiftKey: over.shift ?? false,
})

describe('modeFor', () => {
  it('is a plain replace with no modifier', () => {
    expect(modeFor(mods())).toBe('replace')
  })

  it('toggles on Ctrl, and on Cmd for the same reason shortcuts fold them', () => {
    expect(modeFor(mods({ ctrl: true }))).toBe('toggle')
    expect(modeFor(mods({ meta: true }))).toBe('toggle')
  })

  it('ranges on Shift', () => {
    expect(modeFor(mods({ shift: true }))).toBe('range')
  })

  it('lets Shift win when both are held, which is what a list does', () => {
    expect(modeFor(mods({ ctrl: true, shift: true }))).toBe('range')
  })
})

describe('primaryOf', () => {
  it('is the last entry, which is the most recently clicked', () => {
    expect(primaryOf([3, 1, 7])).toBe(7)
  })

  it('is null for an empty selection', () => {
    expect(primaryOf([])).toBeNull()
  })
})

describe('toggleIn', () => {
  it('adds what is absent', () => {
    expect(toggleIn([1, 2], 5)).toEqual([1, 2, 5])
  })

  it('removes what is present', () => {
    expect(toggleIn([1, 2, 5], 2)).toEqual([1, 5])
  })

  // A Ctrl-click is still a click: the thing just clicked is what the Inspector should be showing.
  it('makes what it adds the primary', () => {
    expect(primaryOf(toggleIn([1, 2], 5))).toBe(5)
  })

  it('leaves a new primary behind when the primary is removed', () => {
    expect(primaryOf(toggleIn([1, 2, 5], 5))).toBe(2)
  })

  it('can empty the selection', () => {
    expect(toggleIn([4], 4)).toEqual([])
  })
})

describe('rangeIn', () => {
  // Display order, not index order: with a collapsed subtree the visible rows are a subset, and their
  // depth-first indices are not contiguous.
  const order = [0, 1, 5, 6, 9]

  it('selects the run between the primary and the target, in display order', () => {
    expect(rangeIn([1], order, 9)).toEqual([1, 5, 6, 9])
  })

  it('ranges upward as well, ending on the target', () => {
    expect(rangeIn([9], order, 1)).toEqual([9, 6, 5, 1])
    expect(primaryOf(rangeIn([9], order, 1)), 'the far end is the new primary').toBe(1)
  })

  it('skips indices that are not on screen, because a range is what the eye sees', () => {
    expect(rangeIn([1], order, 9)).not.toContain(2)
  })

  it('is a single row when the range is one row', () => {
    expect(rangeIn([5], order, 5)).toEqual([5])
  })

  // Shift-clicking again re-ranges from the same anchor, which is why the anchor is the primary.
  it('re-ranges from the primary rather than accumulating', () => {
    const first = rangeIn([1], order, 6)
    expect(first).toEqual([1, 5, 6])
    expect(rangeIn([6], order, 5), 'a second shift-click from the new primary').toEqual([6, 5])
  })

  it('degenerates to one row with nothing selected to anchor from', () => {
    expect(rangeIn([], order, 6)).toEqual([6])
  })

  it('degenerates when the anchor has scrolled out of the visible order', () => {
    expect(rangeIn([99], order, 6)).toEqual([6])
  })

  it('degenerates when the target is not in the visible order', () => {
    expect(rangeIn([1], order, 99)).toEqual([99])
  })
})

describe('applySelect', () => {
  it('replaces by default', () => {
    expect(applySelect([1, 2, 3], 7, 'replace')).toEqual([7])
  })

  it('toggles', () => {
    expect(applySelect([1, 2], 2, 'toggle')).toEqual([1])
  })

  it('ranges with the display order it is given', () => {
    expect(applySelect([1], 5, 'range', [1, 3, 5])).toEqual([1, 3, 5])
  })
})

describe('clampTo', () => {
  it('drops indices past the end of a shrunken document', () => {
    expect(clampTo([0, 3, 7], 4)).toEqual([0, 3])
  })

  it('drops negatives, which is what a failed lookup leaves behind', () => {
    expect(clampTo([-1, 0], 2)).toEqual([0])
  })

  it('empties when the document did', () => {
    expect(clampTo([0, 1], 0)).toEqual([])
  })
})

describe('rootsOf', () => {
  /**
   * A tree, depth-first:
   *   0 deck            d0
   *   1   crate         d1
   *   2     bolt        d2
   *   3   rail          d1
   *   4 lift            d0
   *   5   platform      d1
   */
  const depth = (i: number): number => [0, 1, 2, 1, 0, 1][i]!

  it('keeps siblings, which are independent', () => {
    expect(rootsOf([1, 3], depth)).toEqual([1, 3])
    expect(rootsOf([0, 4], depth)).toEqual([0, 4])
  })

  // Deleting a parent takes its children with it, so a selection of both would delete the child twice — and
  // duplicating both would produce the child twice, once inside the copied parent.
  it('drops a child selected alongside its parent', () => {
    expect(rootsOf([0, 1], depth)).toEqual([0])
    expect(rootsOf([0, 1, 2, 3], depth)).toEqual([0])
  })

  it('drops a grandchild too, not only a direct child', () => {
    expect(rootsOf([0, 2], depth)).toEqual([0])
  })

  it('keeps a deeper node that belongs to a different parent', () => {
    expect(rootsOf([1, 5], depth)).toEqual([1, 5])
  })

  it('resets when it reaches a shallower root', () => {
    expect(rootsOf([1, 2, 4, 5], depth)).toEqual([1, 4])
  })

  it('sorts, so click order does not change the answer', () => {
    expect(rootsOf([3, 1, 0], depth)).toEqual([0])
    expect(rootsOf([5, 4], depth)).toEqual([4])
  })

  it('passes a single item and an empty selection straight through', () => {
    expect(rootsOf([2], depth)).toEqual([2])
    expect(rootsOf([], depth)).toEqual([])
  })
})

describe('defersToClick', () => {
  /**
   * A press that becomes a drag selects nothing: collapsing a multi-selection made a drag carry one row (ADR 0134),
   * and selecting the pressed row swapped the Inspector away from the field it was being dragged to (ADR 0176).
   */
  it('holds every plain press until it turns out to be a click', () => {
    expect(defersToClick('replace', 0)).toBe(true)
  })

  it('leaves Ctrl and Shift presses alone', () => {
    expect(defersToClick('toggle', 0)).toBe(false)
    expect(defersToClick('range', 0)).toBe(false)
  })

  it('leaves a right-click alone', () => {
    expect(defersToClick('replace', 2)).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'

import { dropAt, type DropRow } from './hierarchyDrag'

/**
 * Where a row dragged in the Hierarchy lands (ADR 0150), over rows 24 px tall:
 *
 * ```
 *   0  A            open
 *  24    A1
 *  48    A2         open
 *  72      A2a
 *  96  B            a placement, open
 * 120    piece      a prefab's, which takes a child like anything else (ADR 0151)
 * ```
 */
const H = 24
const row = (at: number, index: number, depth: number, parent: number | null, siblingIndex: number): DropRow => ({
  index,
  depth,
  parent,
  siblingIndex,
  top: at * H,
  bottom: (at + 1) * H,
})
const ROWS: readonly DropRow[] = [row(0, 0, 0, null, 0), row(1, 1, 1, 0, 0), row(2, 2, 1, 0, 1), row(3, 3, 2, 2, 0), row(4, 4, 0, null, 1), row(5, 5, 1, 4, 0)]
const ANY = (): boolean => true
const NONE = (): boolean => false

describe('dropAt', () => {
  it('goes into the row whose middle the pointer is over', () => {
    expect(dropAt(ROWS, 1 * H + 12, 9, ANY)).toEqual({ kind: 'onto', index: 1 })
  })

  it('goes beside it over its top or bottom edge', () => {
    // The top of A1: before it, as A's first child — the only depth there, whatever the pointer's x.
    expect(dropAt(ROWS, 1 * H + 3, 0, ANY)).toEqual({ kind: 'between', parent: 0, at: 0, y: 24, depth: 1 })
    // The bottom of A1: before A2, at A2's depth.
    expect(dropAt(ROWS, 1 * H + 21, 9, ANY)).toEqual({ kind: 'between', parent: 0, at: 1, y: 48, depth: 1 })
  })

  /** After the last child of a group, the drop could stay in it or leave any of the groups it closes. */
  it('lets the pointer’s x choose the depth where a group ends', () => {
    const y = 3 * H + 21 // the bottom of A2a, with B below
    expect(dropAt(ROWS, y, 9, ANY), 'far right: stays beside A2a').toEqual({ kind: 'between', parent: 2, at: 1, y: 96, depth: 2 })
    expect(dropAt(ROWS, y, 1, ANY), 'one level out: after A2').toEqual({ kind: 'between', parent: 0, at: 2, y: 96, depth: 1 })
    expect(dropAt(ROWS, y, -3, ANY), 'all the way out: before B').toEqual({ kind: 'between', parent: null, at: 1, y: 96, depth: 0 })
  })

  it('splits a row in halves where nothing can go into it', () => {
    expect(dropAt(ROWS, 1 * H + 10, 9, NONE)).toEqual({ kind: 'between', parent: 0, at: 0, y: 24, depth: 1 })
    expect(dropAt(ROWS, 1 * H + 14, 9, NONE)).toEqual({ kind: 'between', parent: 0, at: 1, y: 48, depth: 1 })
  })

  // A piece takes a child into its placement's record (ADR 0151), so the drag offers it as anything else.
  it('goes into a prefab’s piece too', () => {
    expect(dropAt(ROWS, 5 * H + 12, 9, ANY)).toEqual({ kind: 'onto', index: 5 })
    expect(dropAt(ROWS, 5 * H + 21, 0, ANY), 'and out to the top level after B, below it').toEqual({ kind: 'between', parent: null, at: 2, y: 144, depth: 0 })
  })

  it('takes a pointer past either end to that end', () => {
    expect(dropAt(ROWS, -5, 4, ANY)).toEqual({ kind: 'between', parent: null, at: 0, y: 0, depth: 0 })
    expect(dropAt(ROWS, 900, 0, ANY)).toEqual({ kind: 'between', parent: null, at: 2, y: 144, depth: 0 })
  })

  it('has nowhere to go in an empty list', () => {
    expect(dropAt([], 10, 0, ANY)).toBeNull()
  })
})

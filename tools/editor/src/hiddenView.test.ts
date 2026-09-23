import { refKey, type NodeRef } from '@mp/content'
import { describe, expect, it } from 'vitest'

import { createHiddenView, keysUnder, type HiddenDoc } from './hiddenView'

/**
 * A tree by depth, named `n0`, `n1`, … — enough for `keysUnder` and `hiddenAt`, which is all either reads.
 * `owners` marks a node as a prefab piece under a placement, so the two keying rules are both exercised.
 */
const tree = (depths: number[], owners: Record<number, string> = {}): HiddenDoc => ({
  count: () => depths.length,
  depthOf: (i) => depths[i] ?? 0,
  refAt: (i): NodeRef | null => {
    if (i < 0 || i >= depths.length) return null
    const owner = owners[i]
    return owner === undefined ? { id: `n${i}` } : { owner, node: `n${i}` }
  },
})

describe('keysUnder', () => {
  //  0
  //  ├ 1
  //  │ └ 2
  //  └ 3
  //  4
  const depths = [0, 1, 2, 1, 0]

  it('takes the node and everything under it', () => {
    expect(keysUnder(tree(depths), 0)).toEqual(['n:n0', 'n:n1', 'n:n2', 'n:n3'])
  })

  it('stops at the end of the subtree, not the end of the document', () => {
    expect(keysUnder(tree(depths), 1), 'n3 is a sibling, n4 is a root').toEqual(['n:n1', 'n:n2'])
  })

  it('takes a leaf alone', () => {
    expect(keysUnder(tree(depths), 2)).toEqual(['n:n2'])
  })

  /** Alt-click: hide the parent and leave the children where they are. */
  it('takes only the node when asked', () => {
    expect(keysUnder(tree(depths), 0, true)).toEqual(['n:n0'])
  })

  /**
   * A prefab's piece is keyed by the placement it sits under, exactly as a hold is. Keyed by node id alone,
   * hiding one wall would hide it in every placement of that prefab.
   */
  it('keys a prefab piece by its placement', () => {
    const keys = keysUnder(tree(depths, { 1: 'place-a', 2: 'place-a' }), 0)
    expect(keys).toEqual(['n:n0', 'i:place-a:n1', 'i:place-a:n2', 'n:n3'])
    expect(keys[1], 'the same piece under another placement is a different key').not.toBe(
      refKey({ owner: 'place-b', node: 'n1' }),
    )
  })

  it('has nothing to say about an index that is not there', () => {
    expect(keysUnder(tree(depths), 99)).toEqual([])
  })
})

describe('the hidden view', () => {
  const depths = [0, 1, 0]
  const doc = tree(depths)

  it('hides nothing until told', () => {
    const view = createHiddenView()
    expect(view.hiddenAt(doc, 0)).toBe(false)
    expect(view.any()).toBe(false)
  })

  it('hides exactly the keys it was given', () => {
    const view = createHiddenView()
    view.set(keysUnder(doc, 0))
    expect(view.hiddenAt(doc, 0), 'the node').toBe(true)
    expect(view.hiddenAt(doc, 1), 'its child, named by the same toggle').toBe(true)
    expect(view.hiddenAt(doc, 2), 'a different root').toBe(false)
  })

  /** Alt-click's whole point: the parent goes, the children stay. */
  it('leaves the children visible when only the node was named', () => {
    const view = createHiddenView()
    view.set(keysUnder(doc, 0, true))
    expect(view.hiddenAt(doc, 0)).toBe(true)
    expect(view.hiddenAt(doc, 1)).toBe(false)
  })

  /** The server sends the whole set every time, so a dropped event cannot leave two editors disagreeing. */
  it('replaces the set rather than merging into it', () => {
    const view = createHiddenView()
    view.set(['n:n0'])
    view.set(['n:n2'])
    expect(view.hiddenAt(doc, 0)).toBe(false)
    expect(view.hiddenAt(doc, 2)).toBe(true)
  })

  it('shows everything while showing all, and forgets nothing', () => {
    const view = createHiddenView()
    view.set(['n:n0'])
    view.setShowingAll(true)
    expect(view.hiddenAt(doc, 0), 'revealed').toBe(false)
    expect(view.any(), 'but still hidden underneath').toBe(true)
    view.setShowingAll(false)
    expect(view.hiddenAt(doc, 0), 'and back').toBe(true)
  })
})

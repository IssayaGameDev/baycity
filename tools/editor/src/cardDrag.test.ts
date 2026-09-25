import { describe, expect, it } from 'vitest'

import { slotFor } from './cardDrag'

/** Where a dragged component card lands (ADR 0152): before the first other card whose middle is below the pointer. */
describe('slotFor', () => {
  const mids = [140, 240, 340]

  it('goes before the first card whose middle is below the pointer', () => {
    expect([slotFor(0, mids), slotFor(150, mids), slotFor(239, mids)]).toEqual([0, 1, 1])
  })

  it('goes last past every middle, and first with nothing to pass', () => {
    expect(slotFor(900, mids)).toBe(3)
    expect(slotFor(900, [])).toBe(0)
  })
})

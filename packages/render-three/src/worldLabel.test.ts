import { describe, expect, it } from 'vitest'

import { layoutLabel, type LabelLine } from './worldLabel'

/** The layout half of a world label (ADR 0082), the half that needs no canvas. */
describe('layoutLabel', () => {
  // A fake measurer: eight pixels a character, scaled by the line's size over 32.
  const measure = (line: LabelLine): number => (line.text.length * 8 * line.size) / 32

  it('stacks lines top to bottom, each centred on its own row', () => {
    const { rows } = layoutLabel([{ text: '+1/step', size: 40 }, { text: 'Requires 0 Wins', size: 22 }], 12, measure)
    expect(rows[0]!.y).toBe(12 + 20)
    expect(rows[1]!.y).toBe(12 + 40 + 4 + 11)
  })

  it('is as wide as the widest line plus padding, and even on both sides', () => {
    const out = layoutLabel([{ text: 'ab', size: 32 }, { text: 'abcdefghij', size: 32 }], 10, measure)
    expect(out.width).toBe(100) // 10 chars × 8 px + 2 × 10
    expect(out.width % 2).toBe(0)
    expect(out.height % 2).toBe(0)
  })

  it('is one row tall for one line', () => {
    const out = layoutLabel([{ text: 'Kodjo', size: 32 }], 12, measure)
    expect(out.height).toBe(32 + 24)
  })
})

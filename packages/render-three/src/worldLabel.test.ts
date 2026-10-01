import { describe, expect, it } from 'vitest'

import { stackLines } from './worldLabel'

/** The layout half of a world label (ADR 0082, ADR 0189), the half that needs no renderer. */
describe('stackLines', () => {
  it('stacks lines top to bottom about the label’s centre, padding above and below', () => {
    const { total, rows } = stackLines([{ text: '+1/step', size: 40 }, { text: 'Requires 0 Wins', size: 22 }], 12)
    expect(total).toBe(12 + 40 + 4 + 22 + 12)
    // The first line's middle is half its own height below the top padding; the second follows the gap.
    expect(rows[0]!.y).toBe(total / 2 - 12 - 20)
    expect(rows[1]!.y).toBe(total / 2 - 12 - 40 - 4 - 11)
  })

  it('centres one line on the origin', () => {
    const { total, rows } = stackLines([{ text: 'Kodjo', size: 32 }], 12)
    expect(total).toBe(32 + 24)
    expect(rows[0]!.y).toBe(0)
  })
})

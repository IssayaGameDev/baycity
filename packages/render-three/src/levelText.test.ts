import { describe, expect, it } from 'vitest'

import { textStyleOf } from './levelText'

/** The game and the editor draw a `Text` from one style (ADR 0189). */
describe('a Text as a drawing style', () => {
  it('is in the world, hidden behind what is in front of it, and bold as a weight', () => {
    const style = textStyleOf({ text: 'Hi', size: 1, color: '#00ff00', align: 'right', width: 3, bold: true, facing: 'camera', back: 'hidden' })
    expect(style).toEqual({ text: 'Hi', size: 1, color: '#00ff00', align: 'right', width: 3, weight: 'bold', facing: 'camera', back: 'hidden', depth: 'world' })
  })
})

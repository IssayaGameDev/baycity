import { describe, expect, it } from 'vitest'

import { textStyleOf } from './levelText'

/** The game and the editor draw a `Text` from one style (ADR 0189, ADR 0190). */
describe('a Text as a drawing style', () => {
  const desc = { text: 'Hi', font: '', size: 1, color: '#00ff00', align: 'right', width: 3, bold: true, facing: 'camera', back: 'hidden' } as const

  it('is in the world, hidden behind what is in front of it, and bold as a weight', () => {
    expect(textStyleOf(desc)).toEqual({ text: 'Hi', font: null, size: 1, color: '#00ff00', align: 'right', width: 3, weight: 'bold', facing: 'camera', back: 'hidden', depth: 'world' })
  })

  it('draws with an uploaded font’s file, and Roboto when there is none or it cannot be read', () => {
    const files: Record<string, string> = { f1: 'https://x/content/Shared/fonts/Pixel.ttf' }
    const urlOf = (id: string): string | null => files[id] ?? null
    expect(textStyleOf({ ...desc, font: 'f1' }, urlOf).font).toBe('https://x/content/Shared/fonts/Pixel.ttf')
    expect(textStyleOf({ ...desc, font: 'gone' }, urlOf).font).toBeNull()
    expect(textStyleOf(desc, urlOf).font).toBeNull()
  })
})

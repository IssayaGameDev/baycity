import { describe, expect, it } from 'vitest'

import { ESC_UNLOCK_MS, escapeAction } from './shell'

/** Esc, one state back at a time (ADR 0205). */
describe('what Esc does', () => {
  const at = (over: Partial<Parameters<typeof escapeAction>[0]> = {}) =>
    escapeAction({ locked: false, msSinceUnlock: 10_000, window: false, paused: false, ...over })

  it('only shows the mouse when it lets the lock go — the menu waits for a second Esc', () => {
    expect(at({ locked: true }), 'still locked as the key arrives').toBe('ignore')
    expect(at({ msSinceUnlock: ESC_UNLOCK_MS - 1 }), 'just let go by this very key').toBe('ignore')
    expect(at(), 'the mouse showing: the pause screen').toBe('open-pause')
  })

  it('closes a game window first, then the pause screen goes back to the mouse', () => {
    expect(at({ window: true })).toBe('close-window')
    expect(at({ paused: true })).toBe('close-pause')
  })
})

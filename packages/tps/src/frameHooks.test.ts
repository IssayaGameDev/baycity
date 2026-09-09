import { describe, expect, it } from 'vitest'

import { createFrameHooks } from './frameHooks'

/**
 * The per-frame seam (ADR 0066).
 *
 * A game's component can already run logic every tick and move the character (ADR 0061), so simulation was
 * never the gap. **Drawing was**: every component hook is fixed-tick, and a thing drawn at 30 Hz attached to a
 * rig animated per frame comes apart visibly. This is that seam, and the tests are about the one rule in it.
 */
describe('frame hooks', () => {
  it('runs every hook with the frame delta, in registration order', () => {
    const hooks = createFrameHooks()
    const seen: string[] = []
    hooks.add((dt) => seen.push(`a${dt}`))
    hooks.add((dt) => seen.push(`b${dt}`))

    hooks.run(0.5)

    expect(seen).toEqual(['a0.5', 'b0.5'])
  })

  it('unregisters through the call it handed back', () => {
    const hooks = createFrameHooks()
    let count = 0
    const off = hooks.add(() => {
      count += 1
    })
    hooks.run(0.016)
    off()
    hooks.run(0.016)

    expect(count).toBe(1)
    expect(hooks.size()).toBe(0)
  })

  it('registers the same function once', () => {
    const hooks = createFrameHooks()
    let count = 0
    const fn = (): void => {
      count += 1
    }
    hooks.add(fn)
    hooks.add(fn)
    hooks.run(0.016)

    expect(count).toBe(1)
  })

  /**
   * The reason this file exists. A rope that lets go removes its own hook mid-pass; iterating the live `Set`
   * while deleting from it skips whatever came next, which looks like a second effect flickering rather than
   * like a bug in here.
   */
  it('lets a hook remove itself without skipping the next one', () => {
    const hooks = createFrameHooks()
    const seen: string[] = []
    const off = hooks.add(() => {
      seen.push('first')
      off()
    })
    hooks.add(() => seen.push('second'))

    hooks.run(0.016)

    expect(seen).toEqual(['first', 'second'])
    expect(hooks.size()).toBe(1)

    // And it really is gone next frame.
    hooks.run(0.016)
    expect(seen).toEqual(['first', 'second', 'second'])
  })

  it('lets a hook add another without running it this frame', () => {
    const hooks = createFrameHooks()
    const seen: string[] = []
    hooks.add(() => {
      seen.push('first')
      hooks.add(() => seen.push('late'))
    })

    hooks.run(0.016)
    expect(seen).toEqual(['first'])

    hooks.run(0.016)
    expect(seen).toEqual(['first', 'first', 'late'])
  })

  it('drops everything on clear', () => {
    const hooks = createFrameHooks()
    hooks.add(() => {})
    hooks.add(() => {})
    hooks.clear()

    expect(hooks.size()).toBe(0)
  })
})

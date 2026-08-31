import { STATE_DEAD, STATE_GAME_MASK, STATE_GROUNDED, STATE_RISING } from './state'
import { describe, expect, it } from 'vitest'

import { MAX_GAME_STATES, TooManyStatesError, packStates, unpackStates } from './gameStates'

/**
 * A game's own states on the wire (ADR 0064).
 *
 * These bits are the only way a peer's game-specific state reaches anybody, so a mistake here is a peer drawn
 * doing the wrong thing — and the two halves of the byte must never bleed into each other.
 */

const set = (...names: string[]): ReadonlySet<string> => new Set(names)

describe('packStates', () => {
  it('is nothing for a game that declared no states', () => {
    expect(packStates(undefined, set('dash'))).toBe(0)
    expect(packStates([], set('dash'))).toBe(0)
  })

  /** Order is bit order, starting above the platform's three. */
  it('assigns bits in declaration order, above the platform bits', () => {
    expect(packStates(['dash'], set('dash'))).toBe(1 << 3)
    expect(packStates(['dash', 'swing'], set('swing'))).toBe(1 << 4)
    expect(packStates(['dash', 'swing'], set('dash', 'swing'))).toBe((1 << 3) | (1 << 4))
  })

  it('never touches the platform bits', () => {
    const bits = packStates(['a', 'b', 'c', 'd', 'e'], set('a', 'b', 'c', 'd', 'e'))
    expect(bits & (STATE_GROUNDED | STATE_RISING | STATE_DEAD)).toBe(0)
    expect(bits).toBe(STATE_GAME_MASK)
  })

  it('fits in the byte', () => {
    expect(packStates(['a', 'b', 'c', 'd', 'e'], set('a', 'b', 'c', 'd', 'e'))).toBeLessThanOrEqual(0xff)
  })

  /** A typo in `playerStates` costs an animation, not the session. */
  it('ignores a state the game never declared', () => {
    expect(packStates(['dash'], set('dahs'))).toBe(0)
  })

  /** Loud, because silently dropping the sixth would be a state that works locally and never for a peer. */
  it('throws when a game declares more than the wire holds', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f']
    expect(six).toHaveLength(MAX_GAME_STATES + 1)
    expect(() => packStates(six, set())).toThrow(TooManyStatesError)
  })
})

describe('unpackStates', () => {
  it('is empty for a game that declared no states', () => {
    expect([...unpackStates(undefined, 0xff)]).toEqual([])
    expect([...unpackStates([], 0xff)]).toEqual([])
  })

  it('reads back exactly what was packed', () => {
    const declared = ['dash', 'swing', 'glide']
    for (const active of [set(), set('dash'), set('glide'), set('dash', 'glide'), set('dash', 'swing', 'glide')]) {
      const round = unpackStates(declared, packStates(declared, active))
      expect([...round].sort()).toEqual([...active].sort())
    }
  })

  /** The half that matters: a platform flag must never surface as somebody's dash. */
  it('ignores the platform bits entirely', () => {
    const declared = ['dash']
    expect([...unpackStates(declared, STATE_GROUNDED | STATE_RISING | STATE_DEAD)]).toEqual([])
    // Set alongside them, the game's bit still reads.
    expect([...unpackStates(declared, STATE_DEAD | (1 << 3))]).toEqual(['dash'])
  })

  /** A peer on an older build may set a bit this build has no name for. It is dropped, not guessed at. */
  it('ignores bits the game has no name for', () => {
    expect([...unpackStates(['dash'], (1 << 3) | (1 << 7))]).toEqual(['dash'])
  })
})

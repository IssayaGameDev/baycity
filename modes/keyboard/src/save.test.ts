import { beforeEach, describe, expect, it } from 'vitest'

import { BASE_PER_STEP } from './progression'
import { localKeyboardSave, withReached } from './save'

// An in-memory localStorage (this runs in the node test env).
let store: Map<string, string>
beforeEach(() => {
  store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage
})

describe("the game's save, through its adapter", () => {
  it('starts from nothing when nothing was saved', () => {
    expect(localKeyboardSave().load()).toEqual({ experience: 0, wins: 0, perStep: BASE_PER_STEP, reached: {} })
  })

  it('round-trips, whole numbers for the two counts', () => {
    localKeyboardSave().save({ experience: 345510.7, wins: 42.9, perStep: 25, reached: { Roblox_World_1: ['a', 'b'] } })
    expect(localKeyboardSave().load()).toEqual({ experience: 345510, wins: 42, perStep: 25, reached: { Roblox_World_1: ['a', 'b'] } })
  })

  /** Kodjo's real save was written before the adapter existed: same keys, same numbers. */
  it('reads a save written before the adapter', () => {
    store.set('keyboard.experience', '345510')
    store.set('keyboard.wins', '1000')
    store.set('keyboard.perStep', '50')
    expect(localKeyboardSave().load()).toEqual({ experience: 345510, wins: 1000, perStep: 50, reached: {} })
  })

  it('takes the default for a value it cannot use', () => {
    store.set('keyboard.experience', 'lots')
    store.set('keyboard.wins', '-3')
    store.set('keyboard.perStep', '0')
    store.set('keyboard.reached', '{not json')
    expect(localKeyboardSave().load()).toEqual({ experience: 0, wins: 0, perStep: BASE_PER_STEP, reached: {} })
    store.set('keyboard.reached', JSON.stringify({ good: ['a'], bad: [1], worse: 'a' }))
    expect(localKeyboardSave().load().reached, 'only lists of keys').toEqual({ good: ['a'] })
  })

  it('adds a reached checkpoint once, per level', () => {
    const one = withReached({}, 'w1', 'a')
    expect(one).toEqual({ w1: ['a'] })
    expect(withReached(one, 'w1', 'a'), 'already there: the same object').toBe(one)
    expect(withReached(one, 'w2', 'a')).toEqual({ w1: ['a'], w2: ['a'] })
  })
})

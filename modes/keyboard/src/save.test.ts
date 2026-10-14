import { beforeEach, describe, expect, it } from 'vitest'

import { BASE_PER_STEP } from './progression'
import { localCheckpointSpots, localKeyboardSave, withReached } from './save'

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
    expect(localKeyboardSave().load()).toEqual({ experience: 0, wins: 0, perStep: BASE_PER_STEP, reached: {}, rebirths: 0 })
  })

  it('round-trips, whole numbers for the two counts', () => {
    localKeyboardSave().save({ experience: 345510.7, wins: 42.9, perStep: 25, reached: { Roblox_World_1: ['a', 'b'] }, rebirths: 2 })
    expect(localKeyboardSave().load()).toEqual({ experience: 345510, wins: 42, perStep: 25, reached: { Roblox_World_1: ['a', 'b'] }, rebirths: 2 })
  })

  /** Kodjo's real save was written before the adapter existed: same keys, same numbers. */
  it('reads a save written before the adapter', () => {
    store.set('keyboard.experience', '345510')
    store.set('keyboard.wins', '1000')
    store.set('keyboard.perStep', '50')
    expect(localKeyboardSave().load()).toEqual({ experience: 345510, wins: 1000, perStep: 50, reached: {}, rebirths: 0 })
  })

  it('takes the default for a value it cannot use', () => {
    store.set('keyboard.experience', 'lots')
    store.set('keyboard.wins', '-3')
    store.set('keyboard.perStep', '0')
    store.set('keyboard.reached', '{not json')
    store.set('keyboard.rebirths', '-1')
    expect(localKeyboardSave().load()).toEqual({ experience: 0, wins: 0, perStep: BASE_PER_STEP, reached: {}, rebirths: 0 })
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

/** Where `respawn at checkpoint` starts the next visit (Kodjo's call): the last checkpoint, per level. */
describe('the checkpoint a tester was last on', () => {
  it('keeps a key per level, and nothing from an unreadable store', () => {
    expect(localCheckpointSpots().load()).toEqual({})
    localCheckpointSpots().save({ Roblox_World_1: 'b', keyboard: 'a#2' })
    expect(localCheckpointSpots().load()).toEqual({ Roblox_World_1: 'b', keyboard: 'a#2' })
    store.set('keyboard.debugSpot', JSON.stringify({ good: 'x', bad: 3 }))
    expect(localCheckpointSpots().load()).toEqual({ good: 'x' })
    store.set('keyboard.debugSpot', '{nope')
    expect(localCheckpointSpots().load()).toEqual({})
  })
})

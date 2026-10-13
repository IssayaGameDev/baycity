import { beforeEach, describe, expect, it } from 'vitest'

import { BASE_PER_STEP } from './progression'
import { localKeyboardSave } from './save'

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
    expect(localKeyboardSave().load()).toEqual({ experience: 0, wins: 0, perStep: BASE_PER_STEP })
  })

  it('round-trips, whole numbers for the two counts', () => {
    localKeyboardSave().save({ experience: 345510.7, wins: 42.9, perStep: 25 })
    expect(localKeyboardSave().load()).toEqual({ experience: 345510, wins: 42, perStep: 25 })
  })

  /** Kodjo's real save was written before the adapter existed: same keys, same numbers. */
  it('reads a save written before the adapter', () => {
    store.set('keyboard.experience', '345510')
    store.set('keyboard.wins', '1000')
    store.set('keyboard.perStep', '50')
    expect(localKeyboardSave().load()).toEqual({ experience: 345510, wins: 1000, perStep: 50 })
  })

  it('takes the default for a value it cannot use', () => {
    store.set('keyboard.experience', 'lots')
    store.set('keyboard.wins', '-3')
    store.set('keyboard.perStep', '0')
    expect(localKeyboardSave().load()).toEqual({ experience: 0, wins: 0, perStep: BASE_PER_STEP })
  })
})

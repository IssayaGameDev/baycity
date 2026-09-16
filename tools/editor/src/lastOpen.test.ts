import { beforeEach, describe, expect, it } from 'vitest'

import { bootLevel, lastLevel, rememberLevel } from './lastOpen'

/** In-memory `localStorage`, as `packages/game-client/src/persistence.test.ts` does — this runs in node. */
const stub = (): void => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage
}

const ENTRIES = [
  { name: 'keyboard/default', mode: 'keyboard' },
  { name: 'keyboard/keyboard2', mode: 'keyboard' },
  { name: 'parkour/default', mode: 'parkour' },
]

describe('remembering the level', () => {
  beforeEach(stub)

  it('is empty before anything is opened', () => {
    expect(lastLevel()).toBeNull()
  })

  it('round-trips the qualified name', () => {
    rememberLevel('keyboard/keyboard2')
    expect(lastLevel()).toBe('keyboard/keyboard2')
  })

  it('survives a write that throws, because remembering is best-effort', () => {
    globalThis.localStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    } as unknown as Storage
    expect(() => rememberLevel('keyboard/default')).not.toThrow()
    expect(lastLevel()).toBeNull()
  })
})

describe('which level boots', () => {
  it('reopens the remembered one', () => {
    expect(bootLevel('parkour/default', ENTRIES, 'keyboard')).toBe('parkour/default')
  })

  it('falls back to the active game when nothing is remembered', () => {
    expect(bootLevel(null, ENTRIES, 'parkour')).toBe('parkour/default')
  })

  it('falls back to any game when there is no active one', () => {
    expect(bootLevel(null, ENTRIES, undefined)).toBe('keyboard/default')
  })

  it('ignores a remembered level that is no longer there', () => {
    // Deleted, renamed, or in a game this build dropped: booting into a load error every time is worse, and
    // the stale name is the one thing the person cannot see in order to fix it.
    expect(bootLevel('keyboard/gone', ENTRIES, 'keyboard')).toBe('keyboard/default')
    expect(bootLevel('oldgame/thing', ENTRIES, undefined)).toBe('keyboard/default')
  })

  it('has nothing to open when there are no levels at all', () => {
    expect(bootLevel('keyboard/default', [], 'keyboard')).toBeUndefined()
    expect(bootLevel(null, [], undefined)).toBeUndefined()
  })
})

import { beforeEach, describe, expect, it } from 'vitest'

import { localProgress } from './persistence'

// Minimal in-memory localStorage stub (this runs in the node test env).
beforeEach(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage
})

describe('progress persistence', () => {
  it('defaults to no checkpoint when empty', () => {
    expect(localProgress('parkour').load()).toEqual({ checkpoint: -1 })
  })

  it('round-trips saved state', () => {
    const p = localProgress('parkour')
    p.save({ checkpoint: 3 })
    expect(p.load()).toEqual({ checkpoint: 3 })
  })

  it('falls back to default on unparseable or invalid data', () => {
    localStorage.setItem('parkour.state', '{not json')
    expect(localProgress('parkour').load()).toEqual({ checkpoint: -1 })
    localStorage.setItem('parkour.state', '{"checkpoint":"nope"}')
    expect(localProgress('parkour').load()).toEqual({ checkpoint: -1 })
  })
})

// Two games on one platform, one browser. Sharing a key would let a parkour checkpoint resume a swing run.
it('keeps each game separate', () => {
  localProgress('parkour').save({ checkpoint: 3 })
  expect(localProgress('swing').load()).toEqual({ checkpoint: -1 })
  expect(localProgress('parkour').load()).toEqual({ checkpoint: 3 })
})

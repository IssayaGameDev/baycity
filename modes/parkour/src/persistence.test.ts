import { beforeEach, describe, expect, it } from 'vitest'

import { localParkourPersistence } from './persistence'

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

describe('parkour persistence', () => {
  it('defaults to no checkpoint when empty', () => {
    expect(localParkourPersistence().load()).toEqual({ checkpoint: -1 })
  })

  it('round-trips saved state', () => {
    const p = localParkourPersistence()
    p.save({ checkpoint: 3 })
    expect(p.load()).toEqual({ checkpoint: 3 })
  })

  it('falls back to default on unparseable or invalid data', () => {
    localStorage.setItem('parkour.state', '{not json')
    expect(localParkourPersistence().load()).toEqual({ checkpoint: -1 })
    localStorage.setItem('parkour.state', '{"checkpoint":"nope"}')
    expect(localParkourPersistence().load()).toEqual({ checkpoint: -1 })
  })
})

import { describe, expect, it } from 'vitest'

import { createManualInputSource, keysToMovement } from './input'

describe('keysToMovement', () => {
  it('maps WASD and arrows to a movement vector', () => {
    expect(keysToMovement(new Set(['d']))).toEqual({ x: 1, z: 0 })
    expect(keysToMovement(new Set(['a']))).toEqual({ x: -1, z: 0 })
    expect(keysToMovement(new Set(['w']))).toEqual({ x: 0, z: -1 })
    expect(keysToMovement(new Set(['arrowdown']))).toEqual({ x: 0, z: 1 })
  })

  it('cancels opposite keys and combines axes', () => {
    expect(keysToMovement(new Set(['a', 'd']))).toEqual({ x: 0, z: 0 })
    expect(keysToMovement(new Set(['d', 's']))).toEqual({ x: 1, z: 1 })
  })

  it('is empty with no keys', () => {
    expect(keysToMovement(new Set())).toEqual({ x: 0, z: 0 })
  })
})

describe('createManualInputSource', () => {
  it('returns the set movement (for bots/tests)', () => {
    const src = createManualInputSource()
    expect(src.movement()).toEqual({ x: 0, z: 0 })
    src.set({ x: 0.5, z: -1 })
    expect(src.movement()).toEqual({ x: 0.5, z: -1 })
  })
})

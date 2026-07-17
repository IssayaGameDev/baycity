import { describe, expect, it } from 'vitest'

import { createManualInputSource, keysToMovement } from './input'

describe('keysToMovement', () => {
  it('maps physical WASD and arrow codes to a movement vector', () => {
    expect(keysToMovement(new Set(['KeyD']))).toEqual({ x: 1, z: 0 })
    expect(keysToMovement(new Set(['KeyA']))).toEqual({ x: -1, z: 0 })
    expect(keysToMovement(new Set(['KeyW']))).toEqual({ x: 0, z: -1 })
    expect(keysToMovement(new Set(['ArrowDown']))).toEqual({ x: 0, z: 1 })
  })

  it('cancels opposite keys and combines axes', () => {
    expect(keysToMovement(new Set(['KeyA', 'KeyD']))).toEqual({ x: 0, z: 0 })
    expect(keysToMovement(new Set(['KeyD', 'KeyS']))).toEqual({ x: 1, z: 1 })
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

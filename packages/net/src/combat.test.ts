import { entityId } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { decodeFire, decodeHit, encodeFire, encodeHit } from './combat'
import { MSG_FIRE, MSG_HIT } from './messages'

describe('combat codec', () => {
  it('round-trips a fire claim (f32-exact values)', () => {
    const fire = {
      fireTimeMs: 987654,
      origin: { x: 1.5, y: 12, z: -20.25 },
      direction: { x: 0, y: -0.5, z: 0.5 },
    }
    expect(decodeFire(encodeFire(fire))).toEqual(fire)
  })

  it('round-trips a hit', () => {
    const decoded = decodeHit(encodeHit({ shooterId: entityId(1000), targetId: entityId(1001) }))
    expect(decoded).toEqual({ shooterId: 1000, targetId: 1001 })
  })

  it('tags the message types and sizes', () => {
    const fireBuf = encodeFire({ fireTimeMs: 1, origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } })
    expect(fireBuf.byteLength).toBe(30)
    expect(new Uint8Array(fireBuf)[1]).toBe(MSG_FIRE)
    const hitBuf = encodeHit({ shooterId: entityId(1), targetId: entityId(2) })
    expect(hitBuf.byteLength).toBe(6)
    expect(new Uint8Array(hitBuf)[1]).toBe(MSG_HIT)
  })
})

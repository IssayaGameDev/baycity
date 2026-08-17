import { describe, expect, it } from 'vitest'

import { MSG_STATE } from './messages'
import { decodeState, encodeState, STATE_GROUNDED, STATE_RISING } from './state'

describe('state codec', () => {
  it('round-trips a position at full float precision', () => {
    const s = { position: { x: 1.5, y: 12.25, z: -20.125 }, flags: 0 }
    expect(decodeState(encodeState(s))).toEqual(s)
  })

  it('round-trips the state flags alongside the position', () => {
    for (const flags of [0, STATE_GROUNDED, STATE_RISING, STATE_GROUNDED | STATE_RISING, 0xff]) {
      const s = { position: { x: -3, y: 0.5, z: 7 }, flags }
      expect(decodeState(encodeState(s)).flags).toBe(flags)
    }
  })

  it('is a 15-byte state message tagged MSG_STATE', () => {
    const buf = encodeState({ position: { x: 0, y: 1, z: 0 }, flags: STATE_GROUNDED })
    expect(buf.byteLength).toBe(15) // 2 header + 3 floats + 1 flags
    expect(new Uint8Array(buf)[1]).toBe(MSG_STATE)
  })
})

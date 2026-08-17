import { describe, expect, it } from 'vitest'

import { MSG_STATE } from './messages'
import { decodeState, encodeState, STATE_DEAD, STATE_GROUNDED, STATE_RISING } from './state'

describe('state codec', () => {
  it('round-trips a position at full float precision', () => {
    const s = { position: { x: 1.5, y: 12.25, z: -20.125 }, flags: 0, yaw: 0.5, speed: 4.25 }
    expect(decodeState(encodeState(s))).toEqual(s)
  })

  it('round-trips the state flags alongside the position', () => {
    for (const flags of [
      0,
      STATE_GROUNDED,
      STATE_RISING,
      STATE_DEAD,
      STATE_GROUNDED | STATE_RISING,
      STATE_GROUNDED | STATE_DEAD,
      0xff,
    ]) {
      const s = { position: { x: -3, y: 0.5, z: 7 }, flags, yaw: 0, speed: 0 }
      expect(decodeState(encodeState(s)).flags).toBe(flags)
    }
  })

  it('gives each state flag its own bit', () => {
    // A death is a distinct event from a pose, so it cannot share a bit with either of the others: a
    // viewer has to be able to read "dead" off a player who is also grounded.
    expect(STATE_GROUNDED & STATE_RISING).toBe(0)
    expect(STATE_GROUNDED & STATE_DEAD).toBe(0)
    expect(STATE_RISING & STATE_DEAD).toBe(0)
  })

  it('is a 23-byte state message tagged MSG_STATE', () => {
    const buf = encodeState({ position: { x: 0, y: 1, z: 0 }, flags: STATE_GROUNDED, yaw: 1, speed: 2 })
    expect(buf.byteLength).toBe(23) // 2 header + 3 floats + 1 flags + 2 floats
    expect(new Uint8Array(buf)[1]).toBe(MSG_STATE)
  })

  it('keeps facing and speed at full precision upstream — quantization happens once, on relay', () => {
    const s = { position: { x: 0, y: 0, z: 0 }, flags: 0, yaw: -2.3456789, speed: 5.4321 }
    const back = decodeState(encodeState(s))
    // f32, so exact to about 7 digits rather than the byte the snapshot will later round it to.
    expect(back.yaw).toBeCloseTo(s.yaw, 5)
    expect(back.speed).toBeCloseTo(s.speed, 5)
  })
})

import { entityId } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { MSG_WELCOME } from './messages'
import { QUANT_BOUND } from './quantize'
import { decodeWelcome, encodeWelcome } from './welcome'

describe('welcome codec', () => {
  it('round-trips the assigned player id', () => {
    const decoded = decodeWelcome(encodeWelcome({ playerId: entityId(7), bound: QUANT_BOUND }))
    expect(decoded.playerId).toBe(7)
  })

  it('round-trips the room quantization bound', () => {
    // A level's own bound, not the default — this is the whole point of the field (ADR 0093), and an f32
    // holds a metre count exactly at these magnitudes.
    expect(decodeWelcome(encodeWelcome({ playerId: entityId(1), bound: 250 })).bound).toBe(250)
    expect(decodeWelcome(encodeWelcome({ playerId: entityId(1), bound: 4096 })).bound).toBe(4096)
  })

  it('is an 8-byte welcome message', () => {
    const buf = encodeWelcome({ playerId: entityId(1), bound: QUANT_BOUND })
    expect(buf.byteLength).toBe(8)
    expect(new Uint8Array(buf)[1]).toBe(MSG_WELCOME)
  })
})

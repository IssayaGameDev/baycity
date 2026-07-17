import { describe, expect, it } from 'vitest'

import { decodeInput, encodeInput, type InputCommand } from './input'
import { MSG_INPUT } from './messages'

describe('input codec', () => {
  it('round-trips a directional input', () => {
    const cmd: InputCommand = { seq: 12345, moveX: 1, moveZ: -1 }
    const decoded = decodeInput(encodeInput(cmd))
    expect(decoded.seq).toBe(12345)
    expect(decoded.moveX).toBeCloseTo(1)
    expect(decoded.moveZ).toBeCloseTo(-1)
  })

  it('preserves zero movement and large sequence numbers', () => {
    const cmd: InputCommand = { seq: 4_000_000_000, moveX: 0, moveZ: 0 }
    const decoded = decodeInput(encodeInput(cmd))
    expect(decoded.seq).toBe(4_000_000_000)
    expect(decoded.moveX).toBe(0)
    expect(decoded.moveZ).toBe(0)
  })

  it('is an 8-byte input message', () => {
    const buf = encodeInput({ seq: 1, moveX: 0.5, moveZ: 0.5 })
    expect(buf.byteLength).toBe(8)
    expect(new Uint8Array(buf)[1]).toBe(MSG_INPUT)
  })
})

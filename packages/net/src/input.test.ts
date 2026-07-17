import { describe, expect, it } from 'vitest'

import { decodeInput, encodeInput, type InputCommand } from './input'
import { MSG_INPUT } from './messages'

describe('input codec', () => {
  it('round-trips a directional input', () => {
    const cmd: InputCommand = { seq: 12345, moveX: 1, moveZ: -1, jump: false }
    const decoded = decodeInput(encodeInput(cmd))
    expect(decoded.seq).toBe(12345)
    expect(decoded.moveX).toBeCloseTo(1)
    expect(decoded.moveZ).toBeCloseTo(-1)
    expect(decoded.jump).toBe(false)
  })

  it('carries the jump flag and large sequence numbers', () => {
    const cmd: InputCommand = { seq: 4_000_000_000, moveX: 0, moveZ: 0, jump: true }
    const decoded = decodeInput(encodeInput(cmd))
    expect(decoded.seq).toBe(4_000_000_000)
    expect(decoded.moveX).toBe(0)
    expect(decoded.moveZ).toBe(0)
    expect(decoded.jump).toBe(true)
  })

  it('is a 9-byte input message', () => {
    const buf = encodeInput({ seq: 1, moveX: 0.5, moveZ: 0.5, jump: false })
    expect(buf.byteLength).toBe(9)
    expect(new Uint8Array(buf)[1]).toBe(MSG_INPUT)
  })
})

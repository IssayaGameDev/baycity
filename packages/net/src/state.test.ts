import { describe, expect, it } from 'vitest'

import { MSG_STATE } from './messages'
import { decodeState, encodeState } from './state'

describe('state codec', () => {
  it('round-trips a position at full float precision', () => {
    const p = { x: 1.5, y: 12.25, z: -20.125 }
    const decoded = decodeState(encodeState(p))
    expect(decoded).toEqual(p)
  })

  it('is a 14-byte state message tagged MSG_STATE', () => {
    const buf = encodeState({ x: 0, y: 1, z: 0 })
    expect(buf.byteLength).toBe(14)
    expect(new Uint8Array(buf)[1]).toBe(MSG_STATE)
  })
})

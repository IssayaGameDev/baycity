import { entityId } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { MSG_WELCOME } from './messages'
import { decodeWelcome, encodeWelcome } from './welcome'

describe('welcome codec', () => {
  it('round-trips the assigned player id', () => {
    const decoded = decodeWelcome(encodeWelcome({ playerId: entityId(7) }))
    expect(decoded.playerId).toBe(7)
  })

  it('is a 4-byte welcome message', () => {
    const buf = encodeWelcome({ playerId: entityId(1) })
    expect(buf.byteLength).toBe(4)
    expect(new Uint8Array(buf)[1]).toBe(MSG_WELCOME)
  })
})

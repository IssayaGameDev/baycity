import { describe, expect, it } from 'vitest'

import { MSG_PING, MSG_PONG } from './messages'
import { decodePing, decodePong, encodePing, encodePong } from './timesync'

describe('timesync codec', () => {
  it('round-trips a ping', () => {
    const decoded = decodePing(encodePing({ clientTimeMs: 1234567 }))
    expect(decoded.clientTimeMs).toBe(1234567)
  })

  it('round-trips a pong', () => {
    const decoded = decodePong(encodePong({ clientTimeMs: 111, serverTimeMs: 222 }))
    expect(decoded).toEqual({ clientTimeMs: 111, serverTimeMs: 222 })
  })

  it('tags the message types', () => {
    expect(new Uint8Array(encodePing({ clientTimeMs: 1 }))[1]).toBe(MSG_PING)
    expect(new Uint8Array(encodePong({ clientTimeMs: 1, serverTimeMs: 2 }))[1]).toBe(MSG_PONG)
  })
})

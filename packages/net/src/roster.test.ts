import { entityId } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { MSG_ROSTER } from './messages'
import { decodeRoster, encodeRoster, type RosterEntry } from './roster'

describe('roster codec', () => {
  it('round-trips id → name entries', () => {
    const entries: RosterEntry[] = [
      { id: entityId(1000), name: 'Swift Fox' },
      { id: entityId(1001), name: 'Brave Otter' },
    ]
    const decoded = decodeRoster(encodeRoster(entries))
    expect(decoded).toEqual(entries)
    expect(new Uint8Array(encodeRoster(entries))[1]).toBe(MSG_ROSTER)
  })

  it('round-trips an empty roster', () => {
    expect(decodeRoster(encodeRoster([]))).toEqual([])
  })

  it('preserves unicode names', () => {
    const entries: RosterEntry[] = [{ id: entityId(1000), name: 'Renée 🎮' }]
    expect(decodeRoster(encodeRoster(entries))).toEqual(entries)
  })
})

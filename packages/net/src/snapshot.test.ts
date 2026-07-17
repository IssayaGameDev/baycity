import { entityId } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { PROTOCOL_VERSION } from './messages'
import { decodeSnapshot, encodeSnapshot, type Snapshot } from './snapshot'

describe('snapshot codec', () => {
  // All values are exactly representable in float32, so round-trip is exact.
  const sample: Snapshot = {
    serverTimeMs: 123456,
    lastProcessedInputSeq: 42,
    entities: [
      { id: entityId(1), position: { x: 1.5, y: -2.25, z: 0.125 } },
      { id: entityId(2), position: { x: 100.5, y: 0, z: -50.75 } },
    ],
  }

  it('round-trips a snapshot exactly', () => {
    expect(decodeSnapshot(encodeSnapshot(sample))).toEqual(sample)
  })

  it('writes the protocol version as the first byte', () => {
    expect(new Uint8Array(encodeSnapshot(sample))[0]).toBe(PROTOCOL_VERSION)
  })

  it('encodes to the expected byte length', () => {
    expect(encodeSnapshot(sample).byteLength).toBe(12 + 2 * 14)
  })

  it('handles an empty entity list', () => {
    const empty: Snapshot = { serverTimeMs: 7, lastProcessedInputSeq: 0, entities: [] }
    expect(decodeSnapshot(encodeSnapshot(empty))).toEqual(empty)
  })

  it('rejects an unknown protocol version', () => {
    const buf = encodeSnapshot(sample)
    new DataView(buf).setUint8(0, 99)
    expect(() => decodeSnapshot(buf)).toThrow(/unsupported protocol version/)
  })
})

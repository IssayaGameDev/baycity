import { entityId } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { PROTOCOL_VERSION } from './messages'
import {
  decodeSnapshot,
  encodeSnapshot,
  fullSnapshotMessage,
  type Snapshot,
  type SnapshotMessage,
} from './snapshot'

describe('snapshot codec', () => {
  const full: Snapshot = {
    serverTimeMs: 123456,
    entities: [
      { id: entityId(1), position: { x: 1.5, y: 12, z: -20.25 } },
      { id: entityId(1000), position: { x: -5.5, y: 0.5, z: 8 } },
    ],
  }

  it('round-trips a full snapshot (quantized, ~1cm tolerance)', () => {
    const decoded = decodeSnapshot(encodeSnapshot(fullSnapshotMessage(full)))
    expect(decoded.isFull).toBe(true)
    expect(decoded.serverTimeMs).toBe(123456)
    expect(decoded.removed).toEqual([])
    expect(decoded.changed).toHaveLength(2)
    for (let i = 0; i < full.entities.length; i++) {
      const a = full.entities[i]!
      const b = decoded.changed[i]!
      expect(b.id).toBe(a.id)
      expect(b.position.x).toBeCloseTo(a.position.x, 2)
      expect(b.position.y).toBeCloseTo(a.position.y, 2)
      expect(b.position.z).toBeCloseTo(a.position.z, 2)
    }
  })

  it('round-trips a delta with changed + removed', () => {
    const delta: SnapshotMessage = {
      isFull: false,
      serverTimeMs: 200,
      changed: [{ id: entityId(1), position: { x: 2, y: 0, z: 0 } }],
      removed: [entityId(1000), entityId(1001)],
    }
    const decoded = decodeSnapshot(encodeSnapshot(delta))
    expect(decoded.isFull).toBe(false)
    expect(decoded.changed).toHaveLength(1)
    expect(decoded.changed[0]!.position.x).toBeCloseTo(2, 2)
    expect(decoded.removed).toEqual([1000, 1001])
  })

  it('quantized full snapshot is smaller than the old f32 layout', () => {
    // 9 header + 2*8 changed + 2 removedCount = 27 B for 2 entities
    expect(encodeSnapshot(fullSnapshotMessage(full)).byteLength).toBe(9 + 2 * 8 + 2)
  })

  it('writes the protocol version as the first byte', () => {
    expect(new Uint8Array(encodeSnapshot(fullSnapshotMessage(full)))[0]).toBe(PROTOCOL_VERSION)
  })
})

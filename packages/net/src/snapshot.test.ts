import { entityId } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { PROTOCOL_VERSION } from './messages'
import { QUANT_BOUND } from './quantize'
import { STATE_GROUNDED, STATE_RISING } from './state'
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
      { id: entityId(1), position: { x: 1.5, y: 12, z: -20.25 }, flags: STATE_GROUNDED, yaw: 1.25, speed: 5.5, base: 0, teleports: 0 },
      { id: entityId(1000), position: { x: -5.5, y: 0.5, z: 8 }, flags: STATE_RISING, yaw: -2.5, speed: 0, base: 0, teleports: 0 },
    ],
  }

  it('round-trips a full snapshot (quantized, within one step per axis)', () => {
    const decoded = decodeSnapshot(encodeSnapshot(fullSnapshotMessage(full)))
    expect(decoded.isFull).toBe(true)
    expect(decoded.serverTimeMs).toBe(123456)
    expect(decoded.removed).toEqual([])
    expect(decoded.changed).toHaveLength(2)
    for (let i = 0; i < full.entities.length; i++) {
      const a = full.entities[i]!
      const b = decoded.changed[i]!
      expect(b.id).toBe(a.id)
      // Derived from the bound, not a fixed decimal place, so a retune (ADR 0092) does not read as a
      // failure. A u16 axis over ±QUANT_BOUND: one step is 2·bound/65535.
      const step = (2 * QUANT_BOUND) / 65535
      expect(Math.abs(b.position.x - a.position.x)).toBeLessThanOrEqual(step)
      expect(Math.abs(b.position.y - a.position.y)).toBeLessThanOrEqual(step)
      expect(Math.abs(b.position.z - a.position.z)).toBeLessThanOrEqual(step)
      expect(b.flags, 'flags are not quantized — they survive exactly').toBe(a.flags)
      // A byte each: 1.4° of facing, 0.063 m/s of speed.
      expect(b.yaw).toBeCloseTo(a.yaw, 1)
      expect(b.speed).toBeCloseTo(a.speed, 1)
    }
  })

  it('round-trips a delta with changed + removed', () => {
    const delta: SnapshotMessage = {
      isFull: false,
      serverTimeMs: 200,
      changed: [
        { id: entityId(1), position: { x: 2, y: 0, z: 0 }, flags: STATE_GROUNDED | STATE_RISING, yaw: 0, speed: 3, base: 0, teleports: 0 },
      ],
      removed: [entityId(1000), entityId(1001)],
    }
    const decoded = decodeSnapshot(encodeSnapshot(delta))
    expect(decoded.isFull).toBe(false)
    expect(decoded.changed).toHaveLength(1)
    expect(decoded.changed[0]!.position.x).toBeCloseTo(2, 2)
    expect(decoded.changed[0]!.flags).toBe(STATE_GROUNDED | STATE_RISING)
    expect(decoded.removed).toEqual([1000, 1001])
  })

  it('costs 13 bytes per entity: quantized position, then flags, yaw, speed, base and teleport bytes', () => {
    // 9 header + 2*13 changed + 2 removedCount = 37 B for 2 entities
    expect(encodeSnapshot(fullSnapshotMessage(full)).byteLength).toBe(9 + 2 * 13 + 2)
  })

  it('carries the teleport count exactly — a count, not a quantity (v13, ADR 0214)', () => {
    const one: Snapshot = { serverTimeMs: 0, entities: [{ ...full.entities[0]!, teleports: 201 }] }
    expect(decodeSnapshot(encodeSnapshot(fullSnapshotMessage(one))).changed[0]!.teleports).toBe(201)
  })

  it('carries the movement base exactly — it is an index, not a quantity', () => {
    const one: Snapshot = { serverTimeMs: 0, entities: [{ ...full.entities[0]!, base: 254 }] }
    expect(decodeSnapshot(encodeSnapshot(fullSnapshotMessage(one))).changed[0]!.base).toBe(254)
  })

  it('wraps facing rather than clamping it, so any angle round-trips', () => {
    // The mode sends whatever `atan2` last produced, and nothing normalizes it on the way.
    for (const yaw of [0, 3.1, -3.1, Math.PI, -Math.PI, 7, -7]) {
      const one: Snapshot = { serverTimeMs: 0, entities: [{ ...full.entities[0]!, yaw }] }
      const back = decodeSnapshot(encodeSnapshot(fullSnapshotMessage(one))).changed[0]!.yaw
      // Compared as a direction: -pi and +pi are the same facing, and the byte can only hold one.
      const gap = Math.atan2(Math.sin(back - yaw), Math.cos(back - yaw))
      expect(Math.abs(gap)).toBeLessThan(0.02)
    }
  })

  it('writes the protocol version as the first byte', () => {
    expect(new Uint8Array(encodeSnapshot(fullSnapshotMessage(full)))[0]).toBe(PROTOCOL_VERSION)
  })
})

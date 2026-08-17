import { entityId, type EntityId, type Vec3 } from '@mp/core'

import { MSG_SNAPSHOT, PROTOCOL_VERSION, readHeader } from './messages'
import { dequantizeAxis, dequantizeSpeed, dequantizeYaw, quantizeAxis, quantizeSpeed, quantizeYaw } from './quantize'

export interface SnapshotEntity {
  id: EntityId
  position: Vec3
  /** Bitfield of `STATE_*` (v8) — relayed as sent, never interpolated. */
  flags: number
  /** Facing (radians), quantized to a byte on the wire (v9). See `PlayerState.yaw`. */
  yaw: number
  /** Locomotion speed (m/s) excluding carry, quantized to a byte on the wire (v9). See `PlayerState.speed`. */
  speed: number
}

/** A reconstructed full snapshot (what the client interpolates over). Carries the
 * relayed positions of *peer* entities on the server's clock-synced timeline
 * (client-authoritative, ADR 0011 — the recipient's own entity is not included). */
export interface Snapshot {
  serverTimeMs: number
  entities: SnapshotEntity[]
}

/**
 * A wire snapshot: either a full state or a delta against the client's previous
 * snapshot (WebSocket is reliable+ordered, so delta-vs-last-sent is safe; a UDP
 * transport would need ack-based baselines).
 */
export interface SnapshotMessage {
  isFull: boolean
  serverTimeMs: number
  /** Full: all entities. Delta: new/changed entities only. */
  changed: SnapshotEntity[]
  /** Delta: entities to drop. Empty for a full. */
  removed: EntityId[]
}

/** Wrap a full snapshot as a message (e.g. the first send to a client). */
export const fullSnapshotMessage = (s: Snapshot): SnapshotMessage => ({
  isFull: true,
  serverTimeMs: s.serverTimeMs,
  changed: s.entities,
  removed: [],
})

// Wire (little-endian): u8 version, u8 type, u8 msgFlags, u32 serverTimeMs, u16 changedCount,
// [u16 id, u16 x,y,z (quantized), u8 stateFlags, u8 yaw, u8 speed]*, u16 removedCount, [u16 id]*
const HEADER_BYTES = 9
const CHANGED_BYTES = 11
const LE = true
const FLAG_FULL = 1

export const encodeSnapshot = (msg: SnapshotMessage): ArrayBuffer => {
  const buffer = new ArrayBuffer(HEADER_BYTES + msg.changed.length * CHANGED_BYTES + 2 + msg.removed.length * 2)
  const view = new DataView(buffer)
  let o = 0
  view.setUint8(o, PROTOCOL_VERSION)
  o += 1
  view.setUint8(o, MSG_SNAPSHOT)
  o += 1
  view.setUint8(o, msg.isFull ? FLAG_FULL : 0)
  o += 1
  view.setUint32(o, msg.serverTimeMs >>> 0, LE)
  o += 4
  view.setUint16(o, msg.changed.length, LE)
  o += 2
  for (const e of msg.changed) {
    view.setUint16(o, e.id, LE)
    o += 2
    view.setUint16(o, quantizeAxis(e.position.x), LE)
    o += 2
    view.setUint16(o, quantizeAxis(e.position.y), LE)
    o += 2
    view.setUint16(o, quantizeAxis(e.position.z), LE)
    o += 2
    view.setUint8(o, e.flags & 0xff)
    o += 1
    view.setUint8(o, quantizeYaw(e.yaw))
    o += 1
    view.setUint8(o, quantizeSpeed(e.speed))
    o += 1
  }
  view.setUint16(o, msg.removed.length, LE)
  o += 2
  for (const id of msg.removed) {
    view.setUint16(o, id, LE)
    o += 2
  }
  return buffer
}

export const decodeSnapshot = (buffer: ArrayBuffer): SnapshotMessage => {
  readHeader(buffer, MSG_SNAPSHOT)
  const view = new DataView(buffer)
  let o = 2
  const isFull = (view.getUint8(o) & FLAG_FULL) !== 0
  o += 1
  const serverTimeMs = view.getUint32(o, LE)
  o += 4
  const changedCount = view.getUint16(o, LE)
  o += 2
  const changed: SnapshotEntity[] = []
  for (let i = 0; i < changedCount; i++) {
    const id = entityId(view.getUint16(o, LE))
    o += 2
    const x = dequantizeAxis(view.getUint16(o, LE))
    o += 2
    const y = dequantizeAxis(view.getUint16(o, LE))
    o += 2
    const z = dequantizeAxis(view.getUint16(o, LE))
    o += 2
    const flags = view.getUint8(o)
    o += 1
    const yaw = dequantizeYaw(view.getUint8(o))
    o += 1
    const speed = dequantizeSpeed(view.getUint8(o))
    o += 1
    changed.push({ id, position: { x, y, z }, flags, yaw, speed })
  }
  const removedCount = view.getUint16(o, LE)
  o += 2
  const removed: EntityId[] = []
  for (let i = 0; i < removedCount; i++) {
    removed.push(entityId(view.getUint16(o, LE)))
    o += 2
  }
  return { isFull, serverTimeMs, changed, removed }
}

import { entityId, type EntityId, type Vec3 } from '@mp/core'

import { MSG_SNAPSHOT, PROTOCOL_VERSION, readHeader } from './messages'

export interface SnapshotEntity {
  id: EntityId
  position: Vec3
}

export interface Snapshot {
  /**
   * Server simulation time (ms) — lets the client place snapshots on a timeline
   * for interpolation. uint32 on the wire (wraps ~49 days).
   */
  serverTimeMs: number
  /**
   * The last input sequence this (per-client) snapshot has processed for the
   * recipient — the reconciliation ack (SEED §4). 0 before any input.
   */
  lastProcessedInputSeq: number
  entities: SnapshotEntity[]
}

// Wire layout (little-endian):
//   u8 version   u8 type   u32 serverTimeMs   u32 lastProcessedInputSeq   u16 entityCount
//   then per entity:   u16 id   f32 x   f32 y   f32 z
// Positions are raw float32 in M4; quantization is plumbed in M6.
const HEADER_BYTES = 12
const ENTITY_BYTES = 14
const LE = true

export const encodeSnapshot = (snapshot: Snapshot): ArrayBuffer => {
  const count = snapshot.entities.length
  const buffer = new ArrayBuffer(HEADER_BYTES + count * ENTITY_BYTES)
  const view = new DataView(buffer)
  let o = 0
  view.setUint8(o, PROTOCOL_VERSION)
  o += 1
  view.setUint8(o, MSG_SNAPSHOT)
  o += 1
  view.setUint32(o, snapshot.serverTimeMs >>> 0, LE)
  o += 4
  view.setUint32(o, snapshot.lastProcessedInputSeq >>> 0, LE)
  o += 4
  view.setUint16(o, count, LE)
  o += 2
  for (const e of snapshot.entities) {
    view.setUint16(o, e.id, LE)
    o += 2
    view.setFloat32(o, e.position.x, LE)
    o += 4
    view.setFloat32(o, e.position.y, LE)
    o += 4
    view.setFloat32(o, e.position.z, LE)
    o += 4
  }
  return buffer
}

export const decodeSnapshot = (buffer: ArrayBuffer): Snapshot => {
  readHeader(buffer, MSG_SNAPSHOT)
  const view = new DataView(buffer)
  let o = 2
  const serverTimeMs = view.getUint32(o, LE)
  o += 4
  const lastProcessedInputSeq = view.getUint32(o, LE)
  o += 4
  const count = view.getUint16(o, LE)
  o += 2
  const entities: SnapshotEntity[] = []
  for (let i = 0; i < count; i++) {
    const id = entityId(view.getUint16(o, LE))
    o += 2
    const x = view.getFloat32(o, LE)
    o += 4
    const y = view.getFloat32(o, LE)
    o += 4
    const z = view.getFloat32(o, LE)
    o += 4
    entities.push({ id, position: { x, y, z } })
  }
  return { serverTimeMs, lastProcessedInputSeq, entities }
}

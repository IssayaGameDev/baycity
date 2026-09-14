import { entityId, type EntityId } from '@mp/core'

import { MSG_WELCOME, PROTOCOL_VERSION, readHeader } from './messages'

/** Sent once on connect: our own entity id, and how to read every position that follows. */
export interface Welcome {
  playerId: EntityId
  /**
   * Half-extent (metres) the room quantizes peer positions over — the level's `netBounds`, or the default
   * (ADR 0093).
   *
   * It comes from the server rather than from each client reading its own copy of the level, so a client on
   * stale content still *agrees* with the room. Agreement is what matters: a bound read two ways puts peers
   * in the wrong place, where one bound read consistently only costs precision.
   */
  bound: number
}

// wire: u8 version, u8 type, u16 playerId, f32 bound  (8 bytes)
const LE = true

export const encodeWelcome = (w: Welcome): ArrayBuffer => {
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  view.setUint8(0, PROTOCOL_VERSION)
  view.setUint8(1, MSG_WELCOME)
  view.setUint16(2, w.playerId, LE)
  view.setFloat32(4, w.bound, LE)
  return buffer
}

export const decodeWelcome = (buffer: ArrayBuffer): Welcome => {
  readHeader(buffer, MSG_WELCOME)
  const view = new DataView(buffer)
  return { playerId: entityId(view.getUint16(2, LE)), bound: view.getFloat32(4, LE) }
}

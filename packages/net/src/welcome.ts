import { entityId, type EntityId } from '@mp/core'

import { MSG_WELCOME, PROTOCOL_VERSION, readHeader } from './messages'

/** Sent once on connect: tells the client which entity id is its own player. */
export interface Welcome {
  playerId: EntityId
}

// wire: u8 version, u8 type, u16 playerId  (4 bytes)
const LE = true

export const encodeWelcome = (w: Welcome): ArrayBuffer => {
  const buffer = new ArrayBuffer(4)
  const view = new DataView(buffer)
  view.setUint8(0, PROTOCOL_VERSION)
  view.setUint8(1, MSG_WELCOME)
  view.setUint16(2, w.playerId, LE)
  return buffer
}

export const decodeWelcome = (buffer: ArrayBuffer): Welcome => {
  readHeader(buffer, MSG_WELCOME)
  return { playerId: entityId(new DataView(buffer).getUint16(2, LE)) }
}

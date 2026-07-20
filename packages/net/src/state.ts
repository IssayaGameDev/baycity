import type { Vec3 } from '@mp/core'

import { MSG_STATE, PROTOCOL_VERSION, readHeader } from './messages'

/**
 * Client -> server: the owner-authoritative position of the sending client's own
 * entity (ADR 0011). The server knows which connection sent it, so no id travels;
 * it stores the latest and relays it to peers in snapshots. Full float precision
 * upstream — quantization happens once, in the snapshot encoder on relay.
 */

// wire (little-endian): u8 version, u8 type, f32 x, f32 y, f32 z
const STATE_BYTES = 14
const LE = true

export const encodeState = (position: Vec3): ArrayBuffer => {
  const buffer = new ArrayBuffer(STATE_BYTES)
  const view = new DataView(buffer)
  view.setUint8(0, PROTOCOL_VERSION)
  view.setUint8(1, MSG_STATE)
  view.setFloat32(2, position.x, LE)
  view.setFloat32(6, position.y, LE)
  view.setFloat32(10, position.z, LE)
  return buffer
}

export const decodeState = (buffer: ArrayBuffer): Vec3 => {
  readHeader(buffer, MSG_STATE)
  const view = new DataView(buffer)
  return {
    x: view.getFloat32(2, LE),
    y: view.getFloat32(6, LE),
    z: view.getFloat32(10, LE),
  }
}

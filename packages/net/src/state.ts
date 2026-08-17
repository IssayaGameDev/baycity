import type { Vec3 } from '@mp/core'

import { MSG_STATE, PROTOCOL_VERSION, readHeader } from './messages'

/**
 * Client -> server: the owner-authoritative state of the sending client's own entity
 * (ADR 0011). The server knows which connection sent it, so no id travels; it stores the
 * latest and relays it to peers in snapshots. Full float precision upstream —
 * quantization happens once, in the snapshot encoder on relay.
 */

/**
 * Bits a viewer cannot work out from a position curve, so they travel (v8).
 *
 * `GROUNDED` is the load-bearing one. Vertical velocity is not a substitute: it passes through
 * zero at the apex of every jump (reads as standing, mid-air) and is negative while running down a
 * ramp or stairs (reads as falling, on the ground). Both are wrong on every jump and every descent
 * respectively, and an obby player is airborne a large fraction of the time.
 *
 * `RISING` separates the up and down halves of a jump, which a viewer *can* derive, but it is free
 * here and derivation is noisy near the apex.
 */
export const STATE_GROUNDED = 1 << 0
export const STATE_RISING = 1 << 1

export interface PlayerState {
  position: Vec3
  /** Bitfield of `STATE_*`. */
  flags: number
}

// wire (little-endian): u8 version, u8 type, f32 x, f32 y, f32 z, u8 flags
const STATE_BYTES = 15
const LE = true

export const encodeState = (state: PlayerState): ArrayBuffer => {
  const buffer = new ArrayBuffer(STATE_BYTES)
  const view = new DataView(buffer)
  view.setUint8(0, PROTOCOL_VERSION)
  view.setUint8(1, MSG_STATE)
  view.setFloat32(2, state.position.x, LE)
  view.setFloat32(6, state.position.y, LE)
  view.setFloat32(10, state.position.z, LE)
  view.setUint8(14, state.flags & 0xff)
  return buffer
}

export const decodeState = (buffer: ArrayBuffer): PlayerState => {
  readHeader(buffer, MSG_STATE)
  const view = new DataView(buffer)
  return {
    position: {
      x: view.getFloat32(2, LE),
      y: view.getFloat32(6, LE),
      z: view.getFloat32(10, LE),
    },
    flags: view.getUint8(14),
  }
}

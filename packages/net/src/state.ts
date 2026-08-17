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
 *
 * `DEAD` is an event, not a pose: it says the sender's body has become a ragdoll. There is no position
 * curve it could be read out of — a corpse and a player standing still look identical — and it is the
 * whole of what a death costs on the wire. Each viewer then runs its own ragdoll from its own
 * interpolated pose of that player, so the corpses land in different places on every screen and no
 * part positions travel (ADR 0019).
 */
export const STATE_GROUNDED = 1 << 0
export const STATE_RISING = 1 << 1
export const STATE_DEAD = 1 << 2

export interface PlayerState {
  position: Vec3
  /** Bitfield of `STATE_*`. */
  flags: number
  /**
   * Facing (radians). **Not** derivable from the position curve, which is the whole reason it travels
   * (v9): the controller's facing follows the *input* direction, so a player turning in the air, or
   * turning on the spot, changes facing without changing where they are going. Viewers deriving it from
   * movement showed them still facing the way they jumped.
   */
  yaw: number
  /**
   * Locomotion speed (m/s) — the character's own, **excluding** anything carrying it. Also not
   * derivable: differencing a position gives world speed, so a viewer saw a player standing on a moving
   * platform as walking, while their own client had them sliding. This is the quantity the animator
   * documents as its input, and only the owner knows it.
   */
  speed: number
}

// wire (little-endian): u8 version, u8 type, f32 x, f32 y, f32 z, u8 flags, f32 yaw, f32 speed
const STATE_BYTES = 23
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
  // Full precision upstream, like the position: quantization happens once, on relay.
  view.setFloat32(15, state.yaw, LE)
  view.setFloat32(19, state.speed, LE)
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
    yaw: view.getFloat32(15, LE),
    speed: view.getFloat32(19, LE),
  }
}

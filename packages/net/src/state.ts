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
 *
 * Bits 3..7 are the **game's** — see `STATE_GAME_SHIFT`.
 */
export const STATE_GROUNDED = 1 << 0
export const STATE_RISING = 1 << 1
export const STATE_DEAD = 1 << 2

/**
 * The **game's** bits: bits 3..7 of the same byte, meaning whatever the game says (ADR 0064).
 *
 * The three above are the platform's, and they were the only three there could be — so a game with a state of
 * its own (dashing, swinging, gliding) had no way to tell a viewer about it, and a peer mid-dash was drawn
 * running. Component state is not serialized (ADR 0059), and a game-supplied animator reads its own state by
 * closure (ADR 0063), which works for the local player and cannot work for anybody else's.
 *
 * **Five of them, and they cost nothing.** The flags byte is a full `u8` on both hops and three bits were in
 * use, so this is room already being paid for. That is also the whole of the budget conversation: adding a
 * sixth state means a wider field and real bytes.
 *
 * **Opaque to the platform.** `@mp/net` never learns what bit 3 means; a game declares its names and a host
 * packs and unpacks them (`ModeDescriptor.states`). Which is why they are exposed as a count and a mask
 * rather than as named constants.
 */
export const STATE_GAME_SHIFT = 3
export const STATE_GAME_BITS = 5
/** `0b11111000` — the game's half of the byte, for masking either way. */
export const STATE_GAME_MASK = ((1 << STATE_GAME_BITS) - 1) << STATE_GAME_SHIFT

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
  /**
   * The clock-driven piece this character is standing on, as `LoadedLevel.baseIndex + 1`, or **0 for
   * none** (v10). When it is non-zero, `position` and `yaw` are **in that piece's frame**, not the
   * world's — relative-to-base replication, the same thing Unreal's based movement does.
   *
   * It exists because a viewer draws the level at its own current time and draws peers on a delayed
   * timeline, so a world position put a rider where they were 100 ms ago on a deck drawn where it is
   * now: at 9.4 m/s that is nearly a metre out, and it slides across the deck as the platform turns
   * around. Sending the *relative* transform makes the two clocks stop mattering, because the number
   * being sent does not change while the platform moves.
   *
   * An index rather than a collider handle: every client instantiates the same level JSON in the same
   * order, so the index is the same everywhere by construction, which a Rapier handle is not (it
   * happens to match today and that is not a promise).
   */
  base: number
  /**
   * How many times the sender has been teleported, mod 256 (v13, ADR 0214) — a cash-out, a teleport window pick, a
   * respawn. A count rather than a one-tick flag, because the relay samples states at its own rate and a flag set for
   * one tick could fall between two samples; a count that changed between two samples cannot be missed. A viewer
   * seeing it change stops blending the two positions, so a teleport is a vanish and an appearance, not a streak.
   */
  teleports: number
}

// wire (little-endian): u8 version, u8 type, f32 x, f32 y, f32 z, u8 flags, f32 yaw, f32 speed, u8 base, u8 teleports
const STATE_BYTES = 25
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
  view.setUint8(23, state.base & 0xff)
  view.setUint8(24, state.teleports & 0xff)
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
    base: view.getUint8(23),
    teleports: view.getUint8(24),
  }
}

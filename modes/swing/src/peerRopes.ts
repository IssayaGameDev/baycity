import { vec3, type EntityId, type Vec3 } from '@mp/core'
import type { PhysicsWorld } from '@mp/physics'
import type { Peer } from '@mp/tps'

import type { Rope, RopeTuning } from './rope'
import { castForAnchor, headingFromYaw, SWING_SHOULDER, SWINGING_STATE } from './swing'

/**
 * Where other players' ropes are tied, worked out locally (ADR 0068).
 *
 * A rope's anchor is a position and **nothing on the wire carries game-defined positions** — a peer arrives as
 * 12 bytes of position, facing, speed, one flags byte and a base index. So the anchor is not sent. What is sent
 * is one bit saying they are swinging, which is free (ADR 0064), and each viewer runs the owner's own search
 * from where it drew them to work out the rest.
 *
 * **Latched on the rising edge**, which is the whole trick. Re-searching every frame would give a wandering
 * anchor as they swing away from it; searching once, at the moment the bit turns on, gives a fixed point — the
 * same thing the owner latched.
 *
 * It agrees because both halves arrive on the **same delayed timeline**: the flag and the position come out of
 * the same snapshot, so a viewer sees the bit flip at the moment it sees them at the grab spot, and casts the
 * same fan through the same geometry (identical on every client by ADR 0021).
 *
 * It is approximate, and here is exactly where the slop comes from:
 *
 * - The wire carries their **facing**, which follows their input, while the owner searched along their
 *   **velocity**. Running in a straight line those agree; turning while grabbing, they do not.
 * - Interpolation puts them within a snapshot of where they were, not on it.
 * - The fan is a sampled cone, so a small difference in origin can land on a different ray and a different
 *   point on the beam — or, in cluttered geometry, a different beam.
 *
 * Which is fine for a rope somebody else is holding, and is why this was chosen over spending 6 bytes a
 * snapshot on every player whether swinging or not.
 */
export interface PeerRopes {
  /** Call once per rendered frame. Latches and drops as the bits change, and forgets whoever left. */
  update: (peers: readonly Peer[], world: PhysicsWorld | null, tuning: RopeTuning) => void
  /** The rope a peer is holding, or `undefined`. */
  ropeOf: (id: EntityId) => Rope | undefined
  /** Everyone currently holding one. */
  holders: () => readonly EntityId[]
}

export const createPeerRopes = (): PeerRopes => {
  const ropes = new Map<EntityId, Rope>()

  return {
    ropeOf: (id) => ropes.get(id),
    holders: () => [...ropes.keys()],
    update: (peers, world, tuning) => {
      const seen = new Set<EntityId>()
      for (const peer of peers) {
        seen.add(peer.id)
        const swinging = peer.states.has(SWINGING_STATE)
        if (!swinging) {
          ropes.delete(peer.id)
          continue
        }
        // Already latched: leave it alone. The anchor does not move while they hold it, and re-deriving would
        // make it drift away from them as they swing.
        if (ropes.has(peer.id)) continue

        if (world === null) continue
        const from = vec3(peer.position.x, peer.position.y + SWING_SHOULDER, peer.position.z)
        const anchor = castForAnchor(world, from, headingFromYaw(peer.yaw), tuning, [])
        // Nothing found. They still swing, they just do it without a visible rope on this screen, which beats
        // drawing a line to a guess.
        if (anchor === null) continue
        ropes.set(peer.id, { anchor, restLength: distance(from, anchor) })
      }
      // Left the room mid-swing.
      for (const id of [...ropes.keys()]) if (!seen.has(id)) ropes.delete(id)
    },
  }
}

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

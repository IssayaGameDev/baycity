import type { CollisionLayers } from '@mp/physics'

/**
 * Collision layers for the parkour world (ADR 0019).
 *
 * Only one interaction has to be switched off: **a character capsule must never touch a corpse.** A
 * dead player's capsule stays in the world at the death point — invisible, fed no input, but still
 * stepped, because that step is what drives the ragdoll and the platforms — and the falling parts were
 * landing on it and resting there in mid-air. A dead *peer*'s mirror capsule does the same to their
 * corpse. Both are the same bug and this is the whole of the fix.
 *
 * Written as "everything except" rather than "only these": level colliders, triggers and anything added
 * later keep Rapier's default membership in all layers, so they collide with both of these without
 * having to claim a layer of their own. A filter listing the layers it wants would silently stop
 * colliding with the next thing someone adds.
 */
const LAYER_BODY = 0x0001
const LAYER_CORPSE = 0x0002

/** Character capsules: the local player's and the kinematic mirrors of peers. */
export const BODY_LAYERS: CollisionLayers = { belongsTo: LAYER_BODY, collidesWith: 0xffff & ~LAYER_CORPSE }
/** A ragdoll's parts. They still collide with the level and with each other. */
export const CORPSE_LAYERS: CollisionLayers = { belongsTo: LAYER_CORPSE, collidesWith: 0xffff & ~LAYER_BODY }

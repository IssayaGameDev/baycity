import { vec3, type Vec3 } from '@mp/core'
import type { LoadedLevel } from '@mp/content'

/**
 * Where a player starts. One implementation, because every game had the same one.
 *
 * It was copied byte-for-byte into `modes/parkour`, `modes/swing` and `modes/_template` — same marker lookup,
 * same golden-angle fan, same fallback — so a fix to the fan would have been three fixes, and a new game
 * copied whichever version it happened to start from.
 *
 * **`standOffset` is a parameter, not a constant.** The capsule's half-height plus its radius is *one
 * character's* answer; a game whose character is a different size, or is not a capsule at all, has its own.
 * That is also why this takes the offset rather than importing `@mp/character`: nothing here knows what the
 * player is made of.
 */

/** Standing height above a node's own origin — a marker sits *on* a surface, so the body must clear it. */
export const standingAt = (at: Vec3, standOffset: number): Vec3 => vec3(at.x, at.y + standOffset, at.z)

/**
 * The golden angle, in radians. Successive multiples never repeat and never bunch, so arrivals fan out around
 * one marker instead of stacking inside each other.
 */
const GOLDEN_ANGLE = 2.399963

/** How far from the marker a fanned arrival lands. */
const FAN_RADIUS = 2

/**
 * Build a game's `ModeDescriptor.spawn` from its character's stand-off height.
 *
 * The returned function takes an optional `seed` — a player id in a game, absent in a tool, which has exactly
 * one body to place. With no marker in the level it puts the body above the origin, so a level with nothing
 * authored still boots rather than dropping the character through the void.
 *
 * Takes `Pick<LoadedLevel, 'markers'>` rather than the whole level, because the markers are all it reads. A
 * `LoadedLevel` still satisfies it, so this is what `ModeDescriptor.spawn` wants — and it means the fan can
 * be tested without standing up a physics world.
 */
export const spawnFrom =
  (standOffset: number) =>
  (loaded: Pick<LoadedLevel, 'markers'>, seed?: number): Vec3 => {
    const marker = loaded.markers.find((m) => m.kind === 'spawn')?.position
    if (marker === undefined) return vec3(0, 3, 0)
    if (seed === undefined) return standingAt(marker, standOffset)
    const a = seed * GOLDEN_ANGLE
    return vec3(marker.x + Math.cos(a) * FAN_RADIUS, marker.y + standOffset, marker.z + Math.sin(a) * FAN_RADIUS)
  }

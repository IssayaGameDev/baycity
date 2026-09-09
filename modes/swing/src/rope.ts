import { vec3, type Vec3 } from '@mp/core'

/**
 * The rope, as arithmetic (ADR 0067).
 *
 * Separate from the component that drives it so all of it is testable without a world, a level or a frame: a
 * pendulum either conserves energy or it does not, and that is a question about numbers.
 */

export interface RopeTuning {
  /** How hard the rope pulls back per metre of stretch (1/s²). Stiff reads as rope; soft reads as bungee. */
  stiffness: number
  /** How much of the stretching *motion* is absorbed (1/s). Without it the rope rings like a spring. */
  damping: number
  /** How hard the stick pushes along the arc (m/s²). This is the pump. */
  pump: number
  /** Shortest rope worth attaching (m). Closer than this and you snap around the anchor. */
  minLength: number
  /** Longest rope worth attaching (m). */
  maxLength: number
  /** How far off your direction of travel an anchor may sit (degrees). Anything behind is rejected. */
  coneDeg: number
  /** How steeply above you an anchor must sit (degrees). Too shallow and there is no arc to fall through. */
  riseDeg: number
}

export const DEFAULT_ROPE: RopeTuning = {
  stiffness: 90,
  damping: 6,
  pump: 14,
  minLength: 4,
  maxLength: 20,
  coneDeg: 70,
  riseDeg: 20,
}

/** A rope in flight: where it is tied, and how long it was when tied. */
export interface Rope {
  anchor: Vec3
  /** Fixed at attach. The spring pulls only when the distance exceeds this — a rope pulls, it never pushes. */
  restLength: number
}

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
const len = (v: Vec3): number => Math.hypot(v.x, v.y, v.z)
const sub = (a: Vec3, b: Vec3): Vec3 => vec3(a.x - b.x, a.y - b.y, a.z - b.z)
const scale = (v: Vec3, k: number): Vec3 => vec3(v.x * k, v.y * k, v.z * k)

/**
 * One candidate anchor, scored.
 *
 * `null` means rejected — behind you, too shallow, too near or too far. A rejected candidate is not a bad one,
 * it is not a candidate.
 */
export const scoreAnchor = (from: Vec3, heading: Vec3, at: Vec3, tuning: RopeTuning): number | null => {
  const to = sub(at, from)
  const distance = len(to)
  if (distance < tuning.minLength || distance > tuning.maxLength) return null

  // Above, by angle rather than by height, so the requirement means the same at every distance.
  const rise = to.y / distance
  if (rise < Math.sin((tuning.riseDeg * Math.PI) / 180)) return null

  // Ahead, measured on the horizontal only: a good swing anchor is in front of where you are going, because
  // that is what puts you at the *start* of a downswing rather than hanging under it.
  const flat = Math.hypot(to.x, to.z)
  const headFlat = Math.hypot(heading.x, heading.z)
  if (flat < 1e-4 || headFlat < 1e-4) return null
  const ahead = (to.x * heading.x + to.z * heading.z) / (flat * headFlat)
  if (ahead < Math.cos((tuning.coneDeg * Math.PI) / 180)) return null

  /**
   * Two halves, both 0..1, added.
   *
   * `ahead` prefers anchors along the way you are already going, so the swing continues a run instead of
   * yanking sideways. `band` prefers the middle of the usable range — the extremes are legal and feel worse, a
   * short rope snapping you round and a long one barely moving you.
   */
  const mid = (tuning.minLength + tuning.maxLength) / 2
  const half = (tuning.maxLength - tuning.minLength) / 2
  const band = 1 - Math.abs(distance - mid) / half
  return ahead + band
}

/**
 * The best of what was found, or `null`.
 *
 * Takes points rather than doing the casting, so the choosing is testable and the casting is the component's.
 */
export const bestAnchor = (from: Vec3, heading: Vec3, candidates: readonly Vec3[], tuning: RopeTuning): Vec3 | null => {
  let best: Vec3 | null = null
  let bestScore = -Infinity
  for (const at of candidates) {
    const score = scoreAnchor(from, heading, at, tuning)
    if (score !== null && score > bestScore) {
      bestScore = score
      best = at
    }
  }
  return best
}

/** The velocity change one tick of rope applies. Added to the character's velocity before it is integrated. */
export interface RopeForce {
  dvx: number
  dvy: number
  dvz: number
}

/**
 * The spring, and the pump.
 *
 * **A damped spring rather than a rigid constraint**, which is the easier direction as well as the one Kodjo
 * asked for: a force is added to whatever else is acting, where a rigid link has to be solved and fights the
 * controller for the same tick. The give shows up exactly where it should — at the bottom of the arc, where
 * centripetal force peaks and the stretch is largest.
 *
 * **One-sided.** No pull at all until the distance passes `restLength`, because a rope goes slack; a
 * two-sided spring would shove you away from the anchor when you rose above it.
 *
 * The pump is the stick, projected onto the arc: the radial part is removed, so pushing at the anchor does
 * nothing and pushing along the swing adds energy. Pushing backwards takes it away, which is what makes
 * stopping a swing something you do rather than something that happens.
 *
 * **The damper does not slow a swing**, which is worth knowing before tuning it. It acts on motion *along* the
 * rope, and a taut pendulum's motion is almost entirely across it — so there is nearly nothing to absorb. What
 * damping is for is the bounce: drop onto a rope and the spring wants to ring, and this is what stops it. The
 * consequence is that **a swing does not decay on its own**: energy leaves it when the player pumps backwards,
 * or when the controller puts them into a wall, and not before. That was found by asserting the opposite in a
 * test and watching it fail.
 */
export const ropeForce = (rope: Rope, at: Vec3, velocity: Vec3, move: { x: number; z: number }, dt: number, tuning: RopeTuning): RopeForce => {
  const to = sub(rope.anchor, at)
  const distance = len(to)
  if (distance < 1e-4) return { dvx: 0, dvy: 0, dvz: 0 }
  const n = scale(to, 1 / distance) // unit vector toward the anchor

  let dv = vec3()

  const stretch = distance - rope.restLength
  if (stretch > 0) {
    // Positive `radial` is motion *toward* the anchor. Damping opposes whatever the stretching is doing, so it
    // is subtracted either way — that is what stops the rope ringing.
    const radial = dot(velocity, n)
    const accel = tuning.stiffness * stretch + tuning.damping * radial * -1
    dv = scale(n, accel * dt)
  }

  const push = Math.hypot(move.x, move.z)
  if (push > 1e-4) {
    const want = vec3(move.x, 0, move.z)
    // Remove the part that pulls along the rope; what is left is along the arc.
    const radialPart = dot(want, n)
    const tangent = vec3(want.x - n.x * radialPart, want.y - n.y * radialPart, want.z - n.z * radialPart)
    const tl = len(tangent)
    if (tl > 1e-4) {
      const k = (tuning.pump * dt * Math.min(1, push)) / tl
      dv = vec3(dv.x + tangent.x * k, dv.y + tangent.y * k, dv.z + tangent.z * k)
    }
  }

  return { dvx: dv.x, dvy: dv.y, dvz: dv.z }
}

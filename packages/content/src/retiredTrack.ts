import { lerp, lerpVec3, vec3, type Vec3 } from '@mp/core'

import type { Transform } from './types'

/**
 * **The retired keyframe model** (ADR 0029/0050, superseded by ADR 0103).
 *
 * Nothing in the running stack reads this. It exists for exactly one caller — `migrateMotion.ts`, which has
 * to be able to read a `Track` in order to convert it — and it is not exported from the package.
 *
 * It lives on because `content/` on master is **not migrated until the `content` branch is merged**, so the
 * tool that converts it still needs a reader. Delete this file and the migration with it, once no content
 * anywhere carries a `Track`.
 *
 * The types came from `types.ts` and the evaluation from `track.ts`; both are folded in here so the live
 * schema has no keyframes in it. Frozen: this is a snapshot of how motion used to work, and it should not
 * grow.
 */

/** How the segment *leaving* a key was timed. Named curves, never bezier handles. */
export type Easing = 'linear' | 'in' | 'out' | 'inOut' | 'step'

/**
 * One authored **offset** from the node's transform, `t` milliseconds into a track (ADR 0050).
 *
 * `rotation` is euler radians, interpolated **per component** rather than as a quaternion, because slerp
 * between identity and a full turn is degenerate and a spin could not be expressed at all.
 */
export interface Keyframe {
  readonly t: number
  readonly position?: Vec3
  readonly rotation?: Vec3
  readonly easing?: Easing
}

/** What happened at the end of a track. */
export type LoopMode = 'loop' | 'pingPong' | 'once'

/** Clock-driven motion as the loader's frame tree used to describe it. */
export type Behavior =
  | { readonly kind: 'static' }
  | {
      readonly kind: 'track'
      readonly keys: readonly Keyframe[]
      readonly loop?: LoopMode
      readonly phaseMs?: number
    }

export const trackDuration = (keys: readonly Keyframe[]): number => {
  let end = 0
  for (const k of keys) if (k.t > end) end = k.t
  return end
}

const clamp01 = (u: number): number => (u < 0 ? 0 : u > 1 ? 1 : u)

/**
 * A named curve as a number.
 *
 * `inOut` is cosine rather than the usual quadratic pair, and that is load-bearing: it makes a 3-key
 * out-and-back identical to the `move` behavior this replaced, which computed
 * `distance · (1 − cos(2π·t/T)) / 2`. Two cosine-eased halves of a T-long track reproduce it term for term,
 * so migrating authored content changed nothing anyone can see.
 *
 * `step` is 0 throughout, so the segment holds its start pose and jumps at the next key.
 */
export const easeAt = (kind: Easing | undefined, u: number): number => {
  const x = clamp01(u)
  switch (kind) {
    case 'in':
      return x * x
    case 'out':
      return 1 - (1 - x) * (1 - x)
    case 'inOut':
      return (1 - Math.cos(x * Math.PI)) / 2
    case 'step':
      return 0
    case 'linear':
    case undefined:
      return x
  }
}

/**
 * Where in the track we are at `nowMs`: a time in `[0, duration]`.
 *
 * `phaseMs` shifts the clock forward, which is what lets two identical tracks run out of step — the hole
 * that made every mover sharing a period move in lockstep. Wrapping uses a flooring modulo rather than `%`,
 * which in JavaScript keeps the sign of the dividend and would send a negative phase backwards.
 */
export const trackTime = (duration: number, loop: LoopMode | undefined, nowMs: number, phaseMs = 0): number => {
  if (duration <= 0) return 0
  const t = nowMs + phaseMs
  if (loop === 'once') return t < 0 ? 0 : t > duration ? duration : t
  const span = loop === 'pingPong' ? duration * 2 : duration
  const wrapped = ((t % span) + span) % span
  // Ping-pong runs forwards then backwards over twice the length, so the return leg mirrors the outward
  // one — which is why a two-key track is already a complete there-and-back under it.
  return loop === 'pingPong' && wrapped > duration ? span - wrapped : wrapped
}

/**
 * The keys that define one channel, in time order.
 *
 * Sorted here rather than trusted from the file: dragging a key past its neighbour in the timeline reorders
 * it in time but not in the array, and an unsorted scan silently samples the wrong segment.
 */
const channelKeys = (keys: readonly Keyframe[], has: (k: Keyframe) => boolean): Keyframe[] =>
  keys.filter(has).sort((a, b) => a.t - b.t)

/**
 * Interpolate one channel at time `u`. Before the first key and after the last, the nearest key's value
 * holds. The easing belongs to the key a segment *leaves*, which is what lets one track ease into a pause
 * and step out of it.
 */
const sampleChannel = <T>(keys: readonly Keyframe[], valueOf: (k: Keyframe) => T, mix: (a: T, b: T, t: number) => T, u: number): T => {
  const last = keys.length - 1
  if (u <= keys[0]!.t) return valueOf(keys[0]!)
  if (u >= keys[last]!.t) return valueOf(keys[last]!)
  let i = 0
  while (i < last && keys[i + 1]!.t <= u) i++
  const a = keys[i]!
  const b = keys[i + 1]!
  const span = b.t - a.t
  // Two keys at the same time is a deliberate instant jump; without this it divides by zero.
  if (span <= 0) return valueOf(b)
  return mix(valueOf(a), valueOf(b), easeAt(a.easing, (u - a.t) / span))
}

/** A local pose: what a frame's transform is at some instant. */
export interface Pose {
  position: Vec3
  /** Euler radians, like `Transform.rotation`. */
  rotation: Vec3
}

const ZERO = vec3(0, 0, 0)
const baseRotation = (t: Transform): Vec3 => t.rotation ?? ZERO
const add = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z)

/**
 * The frame's local pose at `nowMs`, given its authored transform.
 *
 * **A key is an offset from that transform, not a pose that replaces it** (ADR 0050). A key of zero means
 * "at rest". So the transform is where the thing lives and the track is what it does there — which is what
 * makes a track independent of position, and therefore reusable and shareable as an asset.
 *
 * A channel with no keys contributes nothing, **per channel** — so a translation-only track leaves the
 * authored rotation alone, and a spin-only track keeps the authored position. Both fall through to the
 * authored value by returning it untouched rather than by adding zero to it. One key in a channel is a
 * constant offset, which is a legitimate way to say "hold this pose".
 */
export const poseAt = (behavior: Behavior, base: Transform, nowMs: number): Pose => {
  const rest = baseRotation(base)
  if (behavior.kind !== 'track') return { position: base.position, rotation: rest }

  const u = trackTime(trackDuration(behavior.keys), behavior.loop, nowMs, behavior.phaseMs)

  const posKeys = channelKeys(behavior.keys, (k) => k.position !== undefined)
  const rotKeys = channelKeys(behavior.keys, (k) => k.rotation !== undefined)

  return {
    position: posKeys.length === 0 ? base.position : add(base.position, sampleChannel(posKeys, (k) => k.position ?? ZERO, lerpVec3, u)),
    rotation:
      rotKeys.length === 0
        ? rest
        : add(
            rest,
            sampleChannel(
              rotKeys,
              (k) => k.rotation ?? ZERO,
              // Component lerp, not slerp: see `Keyframe.rotation`. A full turn depends on it, because slerp
              // between identity and 2π has nowhere to go.
              (a, b, t) => vec3(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t)),
              u,
            ),
          ),
  }
}

/**
 * Whether this behavior actually moves. A track whose keys all sit at one time is a fixed pose, and the
 * loader leans on this to keep static subtrees out of the per-tick work — a level with no movers has to
 * cost what it always did.
 */
export const isAnimated = (behavior: Behavior): boolean => behavior.kind === 'track' && trackDuration(behavior.keys) > 0

// ---------------------------------------------------------------------------------------------------
// Presets. The editor writes keys, never a new behavior kind — these are the two shapes worth one click,
// and they are exactly the two behaviors a track replaced, so anything authored before ADR 0029 is
// reproducible from the UI rather than only by hand.
// ---------------------------------------------------------------------------------------------------

/**
 * An eased out-and-back: `distance` metres along `axis` from rest and back, over `periodMs`.
 *
 * Takes no base pose. Keys are offsets, so "from rest" is the zero key, and the same preset is correct for
 * an object anywhere in the level — which is the point of ADR 0050 in one function signature.
 *
 * Identical to the old `move` behavior by construction — see `easeAt` for why the easing has to be cosine.
 */
export const moveTrack = (axis: Vec3, distance: number, periodMs: number): Keyframe[] => {
  const len = Math.hypot(axis.x, axis.y, axis.z) || 1
  const far = vec3((axis.x / len) * distance, (axis.y / len) * distance, (axis.z / len) * distance)
  return [
    { t: 0, position: vec3(0, 0, 0), easing: 'inOut' },
    { t: periodMs / 2, position: far, easing: 'inOut' },
    { t: periodMs, position: vec3(0, 0, 0) },
  ]
}

/**
 * One full turn per `periodMs`, looping seamlessly because a turn of 2π is the orientation it started from.
 *
 * An authored tilt needs no mention here now: the keys are offsets, so the spin composes onto whatever
 * rotation the transform holds instead of having to carry it.
 *
 * Cardinal axes only, which is a real limit of euler keys rather than a shortcut: a spin about a slanted
 * axis is not a straight line through euler space, so the preset takes the dominant component. Spinning
 * about a slanted axis means keying the poses.
 */
export const spinTrack = (axis: Vec3, periodMs: number): Keyframe[] => {
  const turn = Math.PI * 2
  const ax = Math.abs(axis.x)
  const ay = Math.abs(axis.y)
  const az = Math.abs(axis.z)
  const dominant = ax >= ay && ax >= az ? 'x' : ay >= az ? 'y' : 'z'
  const signed = dominant === 'x' ? axis.x : dominant === 'y' ? axis.y : axis.z
  const delta = signed < 0 ? -turn : turn
  const end = vec3(dominant === 'x' ? delta : 0, dominant === 'y' ? delta : 0, dominant === 'z' ? delta : 0)
  return [
    { t: 0, rotation: vec3(0, 0, 0), easing: 'linear' },
    { t: periodMs, rotation: end },
  ]
}

import { vec3, type Vec3 } from '@mp/core'

import { MOVER, SPINNER, boolParam, componentsOfType, firstOfType, numberParam, stringParam, vec3Param } from './nodes'
import type { ComponentData } from './types'

/**
 * Clock-driven motion from `Mover` and `Spinner` (ADR 0103).
 *
 * Pure functions of `(motions, time)` and nothing else — no state, no clock of its own. That is what keeps
 * moving platforms off the wire: every client instantiates the same level and asks the same question at the
 * same synced millisecond, so they agree without exchanging anything (ADR 0013/0021).
 *
 * **Speed, not period.** A mover is authored as "3 m up at 2 m/s", and how long the cycle takes falls out of
 * that. The reverse — a period, with speed falling out — is what the keyframe form did, and it meant that
 * making a platform travel further silently made it faster, which is exactly how ADR 0042's riding bugs were
 * reached. Distance and feel are independent here.
 *
 * Headless on purpose: the loader poses colliders with this and the editor previews with it, and neither
 * needs a renderer to know where a platform is.
 */

/** A unit axis per `Spinner.axis` option. Cardinal only — see `Motion`'s `spin` arm for why. */
export const AXES: Readonly<Record<string, Vec3>> = {
  '+X': vec3(1, 0, 0),
  '-X': vec3(-1, 0, 0),
  '+Y': vec3(0, 1, 0),
  '-Y': vec3(0, -1, 0),
  '+Z': vec3(0, 0, 1),
  '-Z': vec3(0, 0, -1),
}

/**
 * The `axis` options, in the order a picker should offer them.
 *
 * A literal tuple rather than `Object.keys(AXES)`, so a `Spinner`'s `params.axis` narrows to the union and a
 * typo in a component's own code is a typecheck failure rather than a runtime surprise.
 */
export const AXIS_NAMES = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'] as const

/**
 * One source of motion on a node, read off a component.
 *
 * `move` travels `move` metres from rest and back, averaging `speed` m/s over each leg. Several are allowed
 * on one node and their offsets add, which is how a circle is authored without keyframes: up-and-down plus
 * side-to-side, a quarter cycle apart.
 *
 * `spin` turns about a **cardinal** axis at `speed` degrees per second. Cardinal is a real limit rather than
 * a shortcut: the pose it contributes is euler radians, and a turn about a slanted axis is not a straight
 * line through euler space. A vec3 axis would accept `(1,1,0)` and produce something that is not a diagonal
 * spin, so the parameter is an enum and cannot say it.
 *
 * `offset` is a **fraction of the cycle**, not a time. The cycle length is derived from speed and distance,
 * so seconds would go stale the moment either changed and a staggered row would have to be re-authored.
 */
export type Motion =
  | { readonly kind: 'move'; readonly move: Vec3; readonly speed: number; readonly smooth: boolean; readonly offset: number }
  | { readonly kind: 'spin'; readonly axis: Vec3; readonly speed: number; readonly offset: number }

/** What a node's motions add to its authored transform. Zero on both channels means "as authored". */
export interface MotionOffset {
  readonly position: Vec3
  readonly rotation: Vec3
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 }

/** The offset a node with no motion contributes. Shared, so the still case allocates nothing per tick. */
export const MOTIONLESS: MotionOffset = { position: ZERO, rotation: ZERO }

const TAU = Math.PI * 2

/**
 * A flooring fraction, so a negative `offset` wraps **forward**. JavaScript's `%` keeps the sign of the
 * dividend and would run such a mover backwards — the same trap `trackTime` had to avoid.
 */
const frac = (v: number): number => v - Math.floor(v)

/**
 * The curve one leg follows. `smooth` is cosine, which is the only curve any authored mover ever used and
 * the one that makes the two legs meet with matching slope at both ends. Off is constant speed, which
 * reverses instantly at each end.
 *
 * Both average to exactly 1 over a leg, which is what lets `speed` mean the average whichever is chosen.
 */
const curve = (u: number, smooth: boolean): number => (smooth ? (1 - Math.cos(u * Math.PI)) / 2 : u)

/**
 * How far along its travel a mover is, in `[0, 1]`. Zero is at rest, one is at `move`.
 *
 * Each **leg** is eased separately rather than easing the out-and-back as a whole: a leg takes
 * `distance / speed` seconds either way, so the curve redistributes time within a leg and never changes how
 * long the cycle is. Easing the triangle instead would double-count the curve and flatten the middle.
 */
export const moveFraction = (m: Extract<Motion, { kind: 'move' }>, nowMs: number): number => {
  const distance = Math.hypot(m.move.x, m.move.y, m.move.z)
  if (distance <= 0 || m.speed <= 0) return 0
  const period = (2 * distance) / m.speed
  const phase = frac(nowMs / 1000 / period + m.offset)
  return phase < 0.5 ? curve(phase * 2, m.smooth) : 1 - curve((phase - 0.5) * 2, m.smooth)
}

/**
 * A spinner's angle in radians, wrapped to one turn.
 *
 * Wrapped rather than accumulated, because level time runs for the life of the room and an unwrapped angle
 * would lose precision over an hour. A turn of 2π is the orientation it started from, so the wrap is
 * invisible — and it is what the keyframe form already did at its loop point.
 */
export const spinRadians = (s: Extract<Motion, { kind: 'spin' }>, nowMs: number): number =>
  frac((nowMs / 1000) * (s.speed / 360) + s.offset) * TAU

/**
 * What every motion on a node adds to its authored transform at `nowMs`.
 *
 * Offsets from one base add, so several movers compose without any of them knowing about the others, and a
 * spinner composes onto whatever rotation the transform already holds instead of replacing it.
 *
 * Two spinners would **not** compose: summing euler angles about different axes is not composing the two
 * rotations, and the result depends on order. `Spinner` is a singleton for that reason, so this only ever
 * sums one.
 */
export const motionOffset = (motions: readonly Motion[], nowMs: number): MotionOffset => {
  if (motions.length === 0) return MOTIONLESS
  let px = 0
  let py = 0
  let pz = 0
  let rx = 0
  let ry = 0
  let rz = 0
  for (const m of motions) {
    if (m.kind === 'move') {
      const u = moveFraction(m, nowMs)
      px += m.move.x * u
      py += m.move.y * u
      pz += m.move.z * u
    } else {
      const a = spinRadians(m, nowMs)
      rx += m.axis.x * a
      ry += m.axis.y * a
      rz += m.axis.z * a
    }
  }
  return { position: vec3(px, py, pz), rotation: vec3(rx, ry, rz) }
}

/**
 * Whether any of these motions actually moves. A mover with no distance or no speed is a fixed pose, and
 * the loader leans on this to keep still subtrees out of the per-tick work and off kinematic bodies — a
 * level with no movers has to cost what it always did.
 */
export const movesAtAll = (motions: readonly Motion[]): boolean =>
  motions.some((m) =>
    m.kind === 'move' ? m.speed > 0 && (m.move.x !== 0 || m.move.y !== 0 || m.move.z !== 0) : m.speed !== 0,
  )

/**
 * Every motion a node's components declare: each enabled `Mover` in order, then its `Spinner` if it has one.
 *
 * Reads parameters defensively, like the loader's other component readers, so a hand-edited file stays
 * loadable rather than throwing from inside the frame tree.
 */
export const motionsOf = (components: readonly ComponentData[]): readonly Motion[] => {
  const out: Motion[] = []
  for (const c of componentsOfType(components, MOVER)) {
    out.push({
      kind: 'move',
      move: vec3Param(c, 'move', ZERO),
      speed: numberParam(c, 'speed', 0),
      smooth: boolParam(c, 'smooth', true),
      offset: numberParam(c, 'offset', 0),
    })
  }
  const spinner = firstOfType(components, SPINNER)
  if (spinner !== undefined) {
    out.push({
      kind: 'spin',
      axis: AXES[stringParam(spinner, 'axis', '+Y')] ?? AXES['+Y']!,
      speed: numberParam(spinner, 'speed', 0),
      offset: numberParam(spinner, 'offset', 0),
    })
  }
  return out
}

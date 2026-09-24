import { axisAngleToQuat, conjQuat, eulerToQuat, mulQuat, quat, rotateVec3, vec3, type Quat, type Vec3 } from '@mp/core'
import {
  easeBackIn,
  easeBackInOut,
  easeBackOut,
  easeBounceIn,
  easeBounceInOut,
  easeBounceOut,
  easeCircleIn,
  easeCircleInOut,
  easeCircleOut,
  easeCubicIn,
  easeCubicInOut,
  easeCubicOut,
  easeElasticIn,
  easeElasticInOut,
  easeElasticOut,
  easeExpIn,
  easeExpInOut,
  easeExpOut,
  easeLinear,
  easePolyIn,
  easePolyInOut,
  easePolyOut,
  easeQuadIn,
  easeQuadInOut,
  easeQuadOut,
  easeSinIn,
  easeSinInOut,
  easeSinOut,
} from 'd3-ease'

import type { Ease } from './eases'

/**
 * Sequences: an object's motion as stages of steps, evaluated as a pure function of time (ADR 0137).
 *
 * A sequence is **stages played one after another**; everything in a stage runs together, and the next stage
 * starts when the stage's longest step ends. A step moves, turns, scales or fades its target, switches its
 * colliders or the whole object on or off, or waits.
 *
 * **No playhead and no state.** `sampleSequence(compiled, clocks)` answers from the clock alone, so every
 * client asks the same question at the same synced millisecond and agrees without exchanging anything
 * (ADR 0013/0021), the editor can preview any instant, a late joiner lands mid-sequence in the right place,
 * and a fast platform can be evaluated several times inside one tick (ADR 0104). That is why the timing is
 * ours and only the easing formulas are borrowed (`d3-ease`): a timeline library keeps a playhead, and one was
 * measured giving a different pose for the same time depending on where it had last been.
 *
 * Everything a person types that is not a duration — a speed, "as long as its stage", a point — is turned
 * into start times and durations once, by `compileSequence`. Sampling is then arithmetic.
 */

// --- easing -----------------------------------------------------------------------------------------

/** The names, in their own module so that checking a stored sequence needs none of this (see `eases.ts`). */
export { EASES, type Ease } from './eases'

const EASE_FNS: Readonly<Record<Ease, (t: number) => number>> = {
  linear: easeLinear,
  'in-sine': easeSinIn,
  'out-sine': easeSinOut,
  'in-out-sine': easeSinInOut,
  'in-quad': easeQuadIn,
  'out-quad': easeQuadOut,
  'in-out-quad': easeQuadInOut,
  'in-cubic': easeCubicIn,
  'out-cubic': easeCubicOut,
  'in-out-cubic': easeCubicInOut,
  'in-quart': easePolyIn.exponent(4),
  'out-quart': easePolyOut.exponent(4),
  'in-out-quart': easePolyInOut.exponent(4),
  'in-quint': easePolyIn.exponent(5),
  'out-quint': easePolyOut.exponent(5),
  'in-out-quint': easePolyInOut.exponent(5),
  'in-expo': easeExpIn,
  'out-expo': easeExpOut,
  'in-out-expo': easeExpInOut,
  'in-circ': easeCircleIn,
  'out-circ': easeCircleOut,
  'in-out-circ': easeCircleInOut,
  'in-back': easeBackIn,
  'out-back': easeBackOut,
  'in-out-back': easeBackInOut,
  'in-elastic': easeElasticIn,
  'out-elastic': easeElasticOut,
  'in-out-elastic': easeElasticInOut,
  'in-bounce': easeBounceIn,
  'out-bounce': easeBounceOut,
  'in-out-bounce': easeBounceInOut,
}

/**
 * An ease at `t`, with the ends **exact**: 0 before the start and 1 after the end, whatever the formula's last
 * bits say. A held pose is then precisely the point that was typed, and a restart lands exactly on the start.
 */
export const easeAt = (ease: Ease, t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : EASE_FNS[ease](t))

// --- the data ---------------------------------------------------------------------------------------

/** Which clock a sequence reads: the room's, the same on every screen, or this browser's own. */
export type SequenceClock = 'shared' | 'local'

/**
 * Which axes a sequence's moves and turns are written in (ADR 0106's rule, kept).
 *
 * `object` — the object's axes **as placed**, so a rotated prefab's route rotates with it. Its own turning
 * never bends its route: a ball that spins while it rolls still rolls straight. `level` — the level's axes,
 * whatever anything above is rotated to, so up stays up.
 */
export type SequenceAxes = 'object' | 'level'

/** What happens after the last stage: back to the start, or played backwards to get there. */
export type SequenceLoop = 'restart' | 'yoyo'

/**
 * How long a step lasts.
 *
 * `speed` is m/s for a move and °/s for a turn, and is the **average** over the step: an ease redistributes
 * the time inside the step and never changes how long it takes. `stage` lasts exactly as long as its stage;
 * on a turn it may carry a `speed`, which spins at that rate for the stage instead of turning `angle`.
 */
export type Timing =
  | { readonly by: 'seconds'; readonly seconds: number }
  | { readonly by: 'speed'; readonly speed: number }
  | { readonly by: 'stage'; readonly speed?: number }

interface StepBase {
  /** Stable, minted when the step is made, so a prefab placement can override one step (ADR 0137). */
  readonly id: string
  /** A child node's id. Absent means the object the sequence is on. */
  readonly target?: string
}

/**
 * One step. `move`, `scale` and `fade` go **to** a value — a point from where the object was placed, a factor
 * of the scale it was placed at, an opacity factor — so changing one step moves no other. `turn` goes **by**
 * an angle, because an orientation cannot say "two full turns".
 */
export type Step =
  | (StepBase & { readonly kind: 'move'; readonly to: Vec3; readonly timing: Timing; readonly ease: Ease })
  | (StepBase & { readonly kind: 'turn'; readonly axis: Vec3; readonly angle: number; readonly timing: Timing; readonly ease: Ease })
  | (StepBase & { readonly kind: 'scale'; readonly to: Vec3; readonly timing: Timing; readonly ease: Ease })
  | (StepBase & { readonly kind: 'fade'; readonly to: number; readonly timing: Timing; readonly ease: Ease })
  | (StepBase & { readonly kind: 'collider'; readonly on: boolean })
  | (StepBase & { readonly kind: 'enabled'; readonly on: boolean })
  | (StepBase & { readonly kind: 'wait'; readonly seconds: number })

export type StepKind = Step['kind']

export interface Stage {
  readonly id: string
  readonly steps: readonly Step[]
}

export interface Sequence {
  readonly name: string
  readonly clock: SequenceClock
  readonly axes: SequenceAxes
  readonly loop: SequenceLoop
  /**
   * How many passes it plays, then holds; 0 = forever. A pass is one play through the stages in either
   * direction, so a yo-yo out and back is two — DOTween's `SetLoops` count.
   */
  readonly times: number
  /** Where in its cycle it starts, as a **fraction** of the cycle (a yo-yo's cycle is out and back). */
  readonly offset: number
  readonly stages: readonly Stage[]
}

/** The key a step with no `target` is filed under: the object the sequence is on. */
export const SELF = ''

// --- compiling --------------------------------------------------------------------------------------

/** When something happens, in seconds from the start of a pass. */
export interface Span {
  readonly start: number
  readonly duration: number
}

interface Ramp<T> extends Span {
  readonly from: T
  readonly to: T
  readonly ease: Ease
}
interface Turn extends Span {
  readonly axis: Vec3
  readonly radians: number
  readonly ease: Ease
}
interface Switch {
  readonly at: number
  readonly on: boolean
}

/** Everything one target does in one sequence, in time order. */
interface Track {
  readonly moves: Ramp<Vec3>[]
  readonly turns: Turn[]
  readonly scales: Ramp<Vec3>[]
  readonly fades: Ramp<number>[]
  readonly colliders: Switch[]
  readonly enables: Switch[]
}

/** What the editor warns about. The sequence still plays; the step in question simply takes no time. */
export type SequenceProblem =
  /** Every step is timed "as long as its stage", so nothing says how long the stage is. It lasts 0 s. */
  | { readonly kind: 'stage-has-no-end'; readonly stage: string }
  /** A move to the point it is already at, or a turn with no angle or no axis. */
  | { readonly kind: 'goes-nowhere'; readonly step: string }
  /** A speed of zero or less, where the speed decides how long the step takes. */
  | { readonly kind: 'speed-not-positive'; readonly step: string }
  /** A speed on a scale or a fade, which have no unit to be fast in. */
  | { readonly kind: 'speed-not-allowed'; readonly step: string }

export interface CompiledSequence {
  readonly sequence: Sequence
  /** One pass through the stages, in seconds — what the Inspector's header shows. */
  readonly passSeconds: number
  /** What `offset` is a fraction of: one pass, or two for a yo-yo. */
  readonly cycleSeconds: number
  /** Each stage's place in the pass, in order — what a stage's box shows in its corner. */
  readonly stages: readonly ({ readonly id: string } & Span)[]
  /** Each step's place in the pass, by step id. */
  readonly steps: ReadonlyMap<string, Span>
  readonly problems: readonly SequenceProblem[]
  /** Every target the sequence touches, `SELF` included when it does. */
  readonly targets: readonly string[]
  readonly tracks: ReadonlyMap<string, Track>
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 }
const ONE: Vec3 = { x: 1, y: 1, z: 1 }
const DEG = Math.PI / 180

/** Where a target stands at a stage boundary, on the channels a step goes **to**. */
interface Standing {
  readonly position: Vec3
  readonly scale: Vec3
  readonly opacity: number
}
const AT_REST: Standing = { position: ZERO, scale: ONE, opacity: 1 }

const finiteOr = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback)
const nonNegative = (v: number): number => Math.max(0, finiteOr(v, 0))
const distance = (a: Vec3, b: Vec3): number => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
const hasLength = (v: Vec3): boolean => Math.hypot(v.x, v.y, v.z) > 1e-9

/**
 * How long a step lasts **by itself**, or `undefined` when it lasts as long as its stage. Reports what is
 * wrong with it on the way, since this is where it is found.
 */
const ownDuration = (step: Step, from: Standing, problems: SequenceProblem[]): number | undefined => {
  switch (step.kind) {
    case 'wait':
      return nonNegative(step.seconds)
    case 'collider':
    case 'enabled':
      return 0
    case 'move': {
      const d = distance(from.position, step.to)
      if (d <= 1e-9) problems.push({ kind: 'goes-nowhere', step: step.id })
      if (step.timing.by === 'stage') return undefined
      if (step.timing.by === 'seconds') return nonNegative(step.timing.seconds)
      if (!(step.timing.speed > 0)) {
        problems.push({ kind: 'speed-not-positive', step: step.id })
        return 0
      }
      return d / step.timing.speed
    }
    case 'turn': {
      const spinning = step.timing.by === 'stage' && step.timing.speed !== undefined
      if (!hasLength(step.axis) || (!spinning && step.angle === 0)) problems.push({ kind: 'goes-nowhere', step: step.id })
      if (step.timing.by === 'stage') return undefined
      if (step.timing.by === 'seconds') return nonNegative(step.timing.seconds)
      const rate = Math.abs(finiteOr(step.timing.speed, 0))
      if (!(rate > 0)) {
        problems.push({ kind: 'speed-not-positive', step: step.id })
        return 0
      }
      return Math.abs(finiteOr(step.angle, 0)) / rate
    }
    case 'scale':
    case 'fade':
      if (step.timing.by === 'stage') return undefined
      if (step.timing.by === 'seconds') return nonNegative(step.timing.seconds)
      problems.push({ kind: 'speed-not-allowed', step: step.id })
      return 0
  }
}

const emptyTrack = (): Track => ({ moves: [], turns: [], scales: [], fades: [], colliders: [], enables: [] })

/**
 * Turn what was typed into start times and durations, once.
 *
 * Per stage: every step that ends by itself says how long it takes; the stage is as long as the longest; the
 * steps timed "as long as its stage" then get that length. A move at a speed takes its distance from where
 * its target stands **at the start of its stage** — the previous stage's point, or where it was placed.
 *
 * Instant steps happen at the start of their stage. Two steps on one channel of one target in the same stage
 * both start from where it stood, and the later one in the list wins while both run.
 */
export const compileSequence = (sequence: Sequence): CompiledSequence => {
  const problems: SequenceProblem[] = []
  const tracks = new Map<string, Track>()
  const stages: ({ id: string } & Span)[] = []
  const steps = new Map<string, Span>()
  let standing = new Map<string, Standing>()
  let clock = 0

  const trackOf = (key: string): Track => {
    let t = tracks.get(key)
    if (t === undefined) {
      t = emptyTrack()
      tracks.set(key, t)
    }
    return t
  }

  for (const stage of sequence.stages) {
    const own = stage.steps.map((step) => ownDuration(step, standing.get(step.target ?? SELF) ?? AT_REST, problems))
    const ends = own.filter((d): d is number => d !== undefined)
    if (stage.steps.length > 0 && ends.length === 0) problems.push({ kind: 'stage-has-no-end', stage: stage.id })
    const length = ends.length === 0 ? 0 : Math.max(...ends)
    stages.push({ id: stage.id, start: clock, duration: length })

    const next = new Map(standing)
    stage.steps.forEach((step, n) => {
      const span: Span = { start: clock, duration: own[n] ?? length }
      steps.set(step.id, span)
      const key = step.target ?? SELF
      const from = standing.get(key) ?? AT_REST
      const track = trackOf(key)
      const after = next.get(key) ?? AT_REST
      switch (step.kind) {
        case 'move':
          track.moves.push({ ...span, from: from.position, to: step.to, ease: step.ease })
          next.set(key, { ...after, position: step.to })
          break
        case 'turn': {
          const spinRate = step.timing.by === 'stage' ? step.timing.speed : undefined
          const degrees = spinRate !== undefined ? finiteOr(spinRate, 0) * length : finiteOr(step.angle, 0)
          if (hasLength(step.axis)) track.turns.push({ ...span, axis: step.axis, radians: degrees * DEG, ease: step.ease })
          break
        }
        case 'scale':
          track.scales.push({ ...span, from: from.scale, to: step.to, ease: step.ease })
          next.set(key, { ...after, scale: step.to })
          break
        case 'fade':
          track.fades.push({ ...span, from: from.opacity, to: step.to, ease: step.ease })
          next.set(key, { ...after, opacity: step.to })
          break
        case 'collider':
          track.colliders.push({ at: clock, on: step.on })
          break
        case 'enabled':
          track.enables.push({ at: clock, on: step.on })
          break
        case 'wait':
          break
      }
    })
    standing = next
    clock += length
  }

  return {
    sequence,
    passSeconds: clock,
    cycleSeconds: sequence.loop === 'yoyo' ? 2 * clock : clock,
    stages,
    steps,
    problems,
    targets: [...tracks.keys()],
    tracks,
  }
}

/** Which channels a sequence drives on one target — what the loader has to decide before it builds anything. */
export interface SequenceChannels {
  readonly position: boolean
  readonly rotation: boolean
  readonly scale: boolean
  readonly opacity: boolean
  readonly collider: boolean
  readonly enabled: boolean
}

const NO_CHANNELS: SequenceChannels = { position: false, rotation: false, scale: false, opacity: false, collider: false, enabled: false }

export const channelsOf = (c: CompiledSequence, target: string): SequenceChannels => {
  const t = c.tracks.get(target)
  if (t === undefined) return NO_CHANNELS
  return {
    position: t.moves.length > 0,
    rotation: t.turns.length > 0,
    scale: t.scales.length > 0,
    opacity: t.fades.length > 0,
    collider: t.colliders.length > 0,
    enabled: t.enables.length > 0,
  }
}

// --- sampling ---------------------------------------------------------------------------------------

/** A flooring fraction, so a negative `offset` wraps forward rather than running the sequence backwards. */
const frac = (v: number): number => v - Math.floor(v)

/**
 * Where in a pass the sequence is at `nowMs`, in seconds.
 *
 * The looping lives here and nowhere else: which pass it is, where in that pass, backwards on the odd passes
 * of a yo-yo — which is what makes a yo-yo a rewind, instant steps included — and, once a set number of
 * passes has played, holding where the last one ended.
 */
export const sequenceTime = (c: CompiledSequence, nowMs: number): number => {
  const pass = c.passSeconds
  if (!(pass > 0)) return 0
  const s = c.sequence
  const yoyo = s.loop === 'yoyo'
  const t = Math.max(0, finiteOr(nowMs, 0) / 1000) + frac(finiteOr(s.offset, 0)) * c.cycleSeconds
  const n = Math.floor(t / pass)
  const times = Math.floor(nonNegative(s.times))
  if (times > 0 && n >= times) return yoyo && (times - 1) % 2 === 1 ? 0 : pass
  const u = t - n * pass
  return yoyo && n % 2 === 1 ? pass - u : u
}

/** What one sequence does to one target at an instant, in the sequence's own axes. */
export interface SequencePose {
  /** A point, in metres, from where the target was placed. */
  readonly position: Vec3
  /** A rotation, to be applied on top of the one it was placed at. */
  readonly turn: Quat
  /** A factor of the scale it was placed at. */
  readonly scale: Vec3
  /** A factor of its material's opacity: 1 as the material is, 0 invisible. */
  readonly opacity: number
  /** `undefined` until a step says: the object as it was set up, until a step changes it. */
  readonly collider: boolean | undefined
  readonly enabled: boolean | undefined
}

/** A target no step has touched yet: where it was placed, as it was set up. */
export const AT_REST_POSE: SequencePose = { position: ZERO, turn: quat(), scale: ONE, opacity: 1, collider: undefined, enabled: undefined }

/** Where a ramp is at `u`: `undefined` before it starts, so an earlier one keeps its value. */
const rampAt = (r: Span & { readonly ease: Ease }, u: number): number | undefined =>
  u < r.start ? undefined : r.duration <= 0 ? 1 : easeAt(r.ease, (u - r.start) / r.duration)

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => vec3(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t))

const switchAt = (switches: readonly Switch[], u: number): boolean | undefined => {
  let on: boolean | undefined
  for (const s of switches) if (u >= s.at) on = s.on
  return on
}

const sampleTrack = (t: Track, u: number): SequencePose => {
  let position = ZERO
  for (const r of t.moves) {
    const p = rampAt(r, u)
    if (p !== undefined) position = lerp3(r.from, r.to, p)
  }
  // Each turn about axes that stay put, applied after the ones before it: the later turn multiplies on the left.
  let turn = quat()
  for (const r of t.turns) {
    const p = rampAt(r, u)
    if (p !== undefined) turn = mulQuat(axisAngleToQuat(r.axis, r.radians * p), turn)
  }
  let scale = ONE
  for (const r of t.scales) {
    const p = rampAt(r, u)
    if (p !== undefined) scale = lerp3(r.from, r.to, p)
  }
  let opacity = 1
  for (const r of t.fades) {
    const p = rampAt(r, u)
    if (p !== undefined) opacity = lerp(r.from, r.to, p)
  }
  return { position, turn, scale, opacity, collider: switchAt(t.colliders, u), enabled: switchAt(t.enables, u) }
}

/** Both clocks a sequence might read, in milliseconds. Passing both is what makes picking the wrong one impossible. */
export interface SequenceClocks {
  readonly shared: number
  readonly local: number
}

/** Every target's pose from one sequence at an instant, keyed by target (`SELF` for the object itself). */
export const sampleSequence = (c: CompiledSequence, clocks: SequenceClocks): ReadonlyMap<string, SequencePose> => {
  const u = sequenceTime(c, c.sequence.clock === 'local' ? clocks.local : clocks.shared)
  const out = new Map<string, SequencePose>()
  for (const [key, track] of c.tracks) out.set(key, sampleTrack(track, u))
  return out
}

// --- one node, several sequences --------------------------------------------------------------------

/**
 * Where a node sits in the tree: the accumulated world rotation and scale **of its parent**, and its own
 * authored euler. The same shape `motion.ts`'s `MotionFrame` has, so a loader frame satisfies both.
 */
export interface NodeFrame {
  readonly parentRot: Quat
  readonly parentScale: Vec3
  readonly ownRotation: Vec3
}

export const TOP_FRAME: NodeFrame = { parentRot: quat(), parentScale: vec3(1, 1, 1), ownRotation: vec3(0, 0, 0) }

/** One sequence's pose on a node, with the axes it was written in. */
export interface SequencePart {
  readonly pose: SequencePose
  readonly axes: SequenceAxes
}

/**
 * What every sequence on a node adds to its authored transform, in the terms the frame tree composes:
 *
 * - `position` — add to the authored local position. Already in the parent's frame with the parent's scale
 *   undone, so a metre stays a metre at any parent scale (ADR 0106).
 * - `rotation` — multiply onto the authored rotation, on the right: `local = authored · rotation`.
 * - `scale` — multiply the authored scale, per axis.
 * - `opacity` — multiply the material's, clamped to `[0, 1]` so an overshooting ease cannot go past either end.
 * - `collider`, `enabled` — `undefined` when no sequence has said, and then the object is as it was set up.
 */
export interface SequenceOffset {
  readonly position: Vec3
  readonly rotation: Quat
  readonly scale: Vec3
  readonly opacity: number
  readonly collider: boolean | undefined
  readonly enabled: boolean | undefined
}

/** What a node no sequence touches gets. Shared, so the still case allocates nothing. */
export const UNMOVED: SequenceOffset = { position: ZERO, rotation: quat(), scale: ONE, opacity: 1, collider: undefined, enabled: undefined }

/** Undo a scale factor, treating a degenerate axis as 1 — a zero-scaled parent must not send a node to infinity. */
const safeDiv = (v: number, by: number): number => (Math.abs(by) < 1e-6 ? v : v / by)

/** Off wins: on only when nobody says off. `undefined` when nobody says anything. */
const offWins = (a: boolean | undefined, b: boolean | undefined): boolean | undefined =>
  a === false || b === false ? false : a === true || b === true ? true : undefined

/**
 * Several sequences on one node, framed and combined (ADR 0137): moves **add**, turns go **one on top of the
 * other** in component order, scales and fades **multiply**, and for collider and enabled **off wins**.
 *
 * The frames are ADR 0106's, generalised from travel to turns. For `object` axes a point is rotated by the
 * node's authored rotation, and a turn is applied inside it. For `level` axes a point is un-rotated by the
 * parent's world rotation, and a turn is conjugated so that it happens about the level's axis:
 * `world = turn · parent · authored`, rewritten as a right-hand factor of `authored`.
 */
export const combineSequences = (parts: readonly SequencePart[], at: NodeFrame): SequenceOffset => {
  if (parts.length === 0) return UNMOVED
  const own = eulerToQuat(at.ownRotation)
  const ownInv = conjQuat(own)
  const parentInv = conjQuat(at.parentRot)
  let px = 0
  let py = 0
  let pz = 0
  let rotation = quat()
  let sx = 1
  let sy = 1
  let sz = 1
  let opacity = 1
  let collider: boolean | undefined
  let enabled: boolean | undefined
  for (const { pose, axes } of parts) {
    const p = axes === 'object' ? rotateVec3(own, pose.position) : rotateVec3(parentInv, pose.position)
    px += p.x
    py += p.y
    pz += p.z
    const r = axes === 'object' ? pose.turn : mulQuat(mulQuat(mulQuat(ownInv, parentInv), pose.turn), mulQuat(at.parentRot, own))
    rotation = mulQuat(rotation, r)
    sx *= pose.scale.x
    sy *= pose.scale.y
    sz *= pose.scale.z
    opacity *= pose.opacity
    collider = offWins(collider, pose.collider)
    enabled = offWins(enabled, pose.enabled)
  }
  const s = at.parentScale
  return {
    position: vec3(safeDiv(px, s.x), safeDiv(py, s.y), safeDiv(pz, s.z)),
    rotation,
    scale: vec3(sx, sy, sz),
    opacity: Math.min(1, Math.max(0, opacity)),
    collider,
    enabled,
  }
}

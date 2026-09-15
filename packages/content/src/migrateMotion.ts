import { vec3, type Vec3 } from '@mp/core'

import { AXES, motionOffset, motionsOf } from './motion'
import { TRACK, walkNodes, type TypeInfo } from './nodes'
import { moveTrack, poseAt, spinTrack, trackDuration } from './track'
import type { ComponentData, Keyframe, Level, LoopMode, Node } from './types'

/**
 * Turn every `Track` into a `Mover` or a `Spinner` (ADR 0103), once, over existing content.
 *
 * What makes this safe is that a conversion is **not inferred from the shape of the keys**. A candidate's own
 * numbers are read out, the preset is **rebuilt from them**, and the rebuild has to equal the authored keys
 * exactly or the level is refused. So a hand-edited track that merely resembles a preset can never be
 * silently reinterpreted — and every track in the repo is preset output, so every one converts.
 *
 * Three cases, and only the first two touch anything:
 *
 * - **A `Move` preset** — three position keys, out and back, cosine at both ends. Becomes a `Mover` with
 *   `speed = 2 · distance / period`, which reproduces the pose exactly (`motion.test.ts` proves it against
 *   `moveTrack` itself over a sweep of times).
 * - **A `Spin` preset** — two rotation keys, zero to a full turn about one axis. Becomes a `Spinner` with
 *   `speed = 360 / periodSeconds`.
 *
 *   With one widening, which the content forced: both turntables in the repo end at `6.2832`, a **hand-typed
 *   2π** rather than the `6.283185307…` the preset emits, because ADR 0051 made a key's value typeable. So a
 *   full turn is matched to `TURN_EPS` and the conversion is **reported as rounded**, with the exactly-equal
 *   case still taking the strict path. The rate changes by 0.0002%: 0.00084° per six-second turn, which after
 *   an hour of play is half a degree of phase. Nothing else is loosened — a *distance* that is not exact
 *   still refuses, because a metre is a number a person chose and 2π is a number they approximated.
 * - **A track with no duration** — every key at one time, so `isAnimated` was already false and the node has
 *   never moved. The component is **dropped**: keeping it would carry a thing that does nothing into the new
 *   model, and the level already behaves as if it were not there. Kodjo's call.
 *
 *   With one condition, which the gate found rather than the author: a track with no duration still *poses*
 *   its node, because one key in a channel is a constant offset (`poseAt`). So the held pose is evaluated,
 *   and only a track holding **zero** on both channels is dropped. One holding a real offset is refused: the
 *   new model has no way to say "displaced and still", and dropping it would move the object. The live dead
 *   track in the content holds zero, because its first key is the zero one and that is the one sampled.
 *
 * The component **id is kept**, so an override naming it still names it (ADR 0033). No override in the
 * content targets a `Track`, and one that did would be reported rather than quietly repointed: a `Track`'s
 * parameters mean nothing on a `Mover`.
 */

export interface MotionReport {
  /** A `Track` rewritten in place. */
  converted: { at: string; node: string; component: string; to: 'Mover' | 'Spinner'; detail: string }[]
  /** A `Track` removed, and why nothing changed by removing it. */
  dropped: { at: string; node: string; component: string; why: string }[]
  /** A file left exactly as it was, and why. */
  refused: { at: string; why: string }[]
  warnings: string[]
}

export const newMotionReport = (): MotionReport => ({ converted: [], dropped: [], refused: [], warnings: [] })

/** Where a component's keys come from: inline, or the clip it names (ADR 0050). */
export type KeysOf = (c: ComponentData) => readonly Keyframe[]

/** Inline keys first, then the named clip — the precedence the loader applies. */
export const keysOfWith = (clip: (id: string) => readonly Keyframe[] | undefined): KeysOf => (c) => {
  const inline = c.params.keys
  if (Array.isArray(inline) && inline.length > 0) return inline as readonly Keyframe[]
  const id = c.params.clip
  return typeof id === 'string' && id !== '' ? (clip(id) ?? []) : []
}

const EPS = 1e-6

/**
 * How far a rotation key may sit from a whole turn and still be read as one. Radians, and wide enough for a
 * 2π typed to four decimals — see the `Spin` note above for why this one tolerance exists.
 */
export const TURN_EPS = 1e-3

const sameVec = (a: Vec3 | undefined, b: Vec3 | undefined): boolean =>
  a === undefined || b === undefined
    ? a === b
    : Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS && Math.abs(a.z - b.z) < EPS

/** Key-for-key equality, tolerant of float noise. An absent easing is `linear`, as `easeAt` reads it. */
const sameKeys = (a: readonly Keyframe[], b: readonly Keyframe[]): boolean =>
  a.length === b.length &&
  a.every((k, i) => {
    const o = b[i]
    return (
      o !== undefined &&
      Math.abs(k.t - o.t) < EPS &&
      sameVec(k.position, o.position) &&
      sameVec(k.rotation, o.rotation) &&
      (k.easing ?? 'linear') === (o.easing ?? 'linear')
    )
  })

/** A flooring fraction, matching `offset`'s own wrap. */
const wrap01 = (v: number): number => {
  const f = v - Math.floor(v)
  return Math.abs(f) < EPS || Math.abs(f - 1) < EPS ? 0 : f
}

/** Round away the float dust a division leaves, so the written file reads like something a person typed. */
const tidy = (v: number): number => {
  const r = Math.round(v * 1e6) / 1e6
  return Object.is(r, -0) ? 0 : r
}

const fmt = (v: number): string => String(tidy(v))

/** What a `Track` becomes. */
export type Conversion =
  | { kind: 'Mover'; params: Record<string, unknown>; detail: string }
  | { kind: 'Spinner'; params: Record<string, unknown>; detail: string }
  | { kind: 'drop'; why: string }
  | { kind: 'refuse'; why: string }

/**
 * Read one `Track` as the component that replaces it.
 *
 * `loop` other than `'loop'` refuses rather than guesses: `pingPong` runs a track over twice its length and
 * `once` holds its last pose forever, and neither is what a `Mover` does. Nothing in the content uses either.
 */
export const convertTrack = (c: ComponentData, keys: readonly Keyframe[]): Conversion => {
  const duration = trackDuration(keys)
  if (keys.length === 0) return { kind: 'drop', why: 'no keys at all, so it never moved' }
  if (duration <= 0) {
    const held = poseAt({ kind: 'track', keys }, { position: vec3(0, 0, 0), rotation: vec3(0, 0, 0) }, 0)
    if (!sameVec(held.position, vec3(0, 0, 0)) || !sameVec(held.rotation, vec3(0, 0, 0))) {
      return {
        kind: 'refuse',
        why: `no duration, but it holds an offset of ${fmt(held.position.x)},${fmt(held.position.y)},${fmt(held.position.z)} / ${fmt(held.rotation.x)},${fmt(held.rotation.y)},${fmt(held.rotation.z)} — dropping it would move the node`,
      }
    }
    return { kind: 'drop', why: `all ${keys.length} keys at one time, holding the rest pose, so it never moved` }
  }

  const loop = c.params.loop
  if (typeof loop === 'string' && loop !== 'loop') return { kind: 'refuse', why: `loop '${loop}' has no equivalent` }

  const phaseMs = typeof c.params.phaseMs === 'number' && Number.isFinite(c.params.phaseMs) ? c.params.phaseMs : 0
  const offset = wrap01(phaseMs / duration)
  const seconds = duration / 1000

  const far = keys[1]?.position
  if (keys.length === 3 && far !== undefined && keys.every((k) => k.rotation === undefined)) {
    const distance = Math.hypot(far.x, far.y, far.z)
    // Rebuilt from the candidate's own axis and distance: if the authored keys are not exactly what the
    // preset emits for those numbers, this is not a preset and we do not touch it.
    if (distance > EPS && sameKeys(keys, moveTrack(far, distance, duration))) {
      const speed = tidy((2 * distance) / seconds)
      return {
        kind: 'Mover',
        params: { move: vec3(tidy(far.x), tidy(far.y), tidy(far.z)), speed, smooth: true, offset },
        detail: `${fmt(distance)} m at ${fmt(speed)} m/s`,
      }
    }
  }

  const end = keys[1]?.rotation
  if (keys.length === 2 && end !== undefined && keys.every((k) => k.position === undefined)) {
    const speed = tidy(360 / seconds)
    // Exact first, so a preset-authored spin takes the strict path and is reported without a caveat.
    for (const [name, axis] of Object.entries(AXES)) {
      if (!sameKeys(keys, spinTrack(axis, duration))) continue
      return { kind: 'Spinner', params: { axis: name, speed, offset }, detail: `${name} at ${fmt(speed)} °/s` }
    }
    // Then a turn that was typed rather than generated. Everything but the turn's exactness still has to
    // hold: it starts at rest, runs linearly, ends at the track's end, and turns about one axis only.
    const TURN = Math.PI * 2
    const startsAtRest = sameVec(keys[0]?.rotation, vec3(0, 0, 0)) && (keys[0]?.easing ?? 'linear') === 'linear'
    const axes = [
      ['+X', end.x, end.y, end.z],
      ['+Y', end.y, end.x, end.z],
      ['+Z', end.z, end.x, end.y],
    ] as const
    if (startsAtRest && Math.abs((keys[1]?.t ?? 0) - duration) < EPS && (keys[1]?.easing ?? 'linear') === 'linear') {
      for (const [letter, on, offA, offB] of axes) {
        if (Math.abs(offA) > EPS || Math.abs(offB) > EPS) continue
        if (Math.abs(Math.abs(on) - TURN) > TURN_EPS) continue
        const name = `${on < 0 ? '-' : '+'}${letter.slice(1)}`
        return {
          kind: 'Spinner',
          params: { axis: name, speed, offset },
          detail: `${name} at ${fmt(speed)} °/s  (a full turn typed as ${fmt(Math.abs(on))}, read as 2π)`,
        }
      }
    }
  }

  return { kind: 'refuse', why: `${keys.length} keys that are not a Move or a Spin preset` }
}

/**
 * Rewrite every `Track` in this tree, in place. `false` means something refused and the caller must throw the
 * whole file away rather than write a half-converted one.
 *
 * `overriddenComponents` is every component id an override in the same file names. A `Track` among them
 * refuses: its parameters do not mean anything on the component replacing it, and dropping the override
 * silently is the class of bug the prefab-reference migration had to be gated against.
 */
export const migrateTracksIn = (root: Node, at: string, keysOf: KeysOf, report: MotionReport, overridden: ReadonlySet<string> = new Set()): boolean => {
  let ok = true
  const step = (node: Node): void => {
    const kept: ComponentData[] = []
    for (const c of node.components) {
      if (c.type !== TRACK) {
        kept.push(c)
        continue
      }
      if (overridden.has(c.id)) {
        report.refused.push({ at, why: `node '${node.id}' component '${c.id}': a Track carrying an override` })
        ok = false
        kept.push(c)
        continue
      }
      const done = convertTrack(c, keysOf(c))
      if (done.kind === 'refuse') {
        report.refused.push({ at, why: `node '${node.id}' component '${c.id}': ${done.why}` })
        ok = false
        kept.push(c)
      } else if (done.kind === 'drop') {
        report.dropped.push({ at, node: node.id, component: c.id, why: done.why })
      } else {
        // Same id, so an override or a reference naming this component still names it.
        kept.push({ id: c.id, type: done.kind, params: done.params, ...(c.enabled === undefined ? {} : { enabled: c.enabled }) })
        report.converted.push({ at, node: node.id, component: c.id, to: done.kind, detail: done.detail })
      }
    }
    node.components = kept
    for (const k of node.children ?? []) step(k)
  }
  step(root)
  return ok
}

/**
 * A game's shared-component list with `Track` replaced (ADR 0077). `null` when it did not opt into `Track`.
 *
 * **Both** replace it, whichever the game's levels happen to place today. A game that opted into keyed motion
 * opted into motion, and the editor appends a shared component to this list the moment someone places one
 * anyway — so declaring the pair is what that game would reach in a week regardless, and under-declaring
 * fails at load with a type the registry does not have.
 */
export const migrateGameComponents = (components: readonly string[]): string[] | null => {
  if (!components.includes(TRACK)) return null
  const out = new Set(components.filter((c) => c !== TRACK))
  out.add('Mover')
  out.add('Spinner')
  return [...out].sort()
}

/** Every component id an override anywhere in this tree names. */
export const overriddenComponentIds = (root: Node): Set<string> => {
  const out = new Set<string>()
  const step = (node: Node): void => {
    for (const o of Object.values(node.overrides ?? {})) {
      for (const id of Object.keys(o.params ?? {})) out.add(id)
      for (const id of Object.keys(o.enabled ?? {})) out.add(id)
    }
    for (const k of node.children ?? []) step(k)
  }
  step(root)
  return out
}

/**
 * **The gate.** Where every node's motion puts it, as comparable lines.
 *
 * Nothing else would do: `fingerprintGeometry` compares component parameters, so a `Track` becoming a `Mover`
 * reads as a difference there by construction and every level would be refused. What must not change is not
 * the components — they are the thing being changed — but **the local offset of every node at every instant**,
 * which is the only thing motion contributes to a level.
 *
 * The base transform is deliberately zero, so a pose *is* the offset and an unrelated transform edit cannot
 * mask a wrong speed. Times are sampled either side of every period in the content, and far enough out that a
 * wrong period drifts into view.
 */
export const SAMPLE_MS: readonly number[] = [0, 137, 499, 500, 999, 1000, 1500, 1999, 2000, 2001, 3000, 3999, 4000, 4001, 5555, 6000, 7777, 9000, 12_345, 60_000, 123_456]

/** A tenth of a millimetre. Tight enough that no authored distance survives being wrong. */
export const POS_EPS = 1e-4
/**
 * A hundred-thousandth of a radian, about 0.0006°.
 *
 * Wide enough for the one rounding this migration accepts, and no wider: reading `6.2832` as 2π puts the two
 * angles **1.5e-5 rad** apart at worst, and that never accumulates, because both forms wrap over the same
 * period so the error is bounded by the difference of the coefficients rather than growing with time.
 */
export const ROT_EPS = 1e-4

export const fingerprintMotion = (level: Level, types: TypeInfo, keysOf: KeysOf): string[] => {
  const out: string[] = []
  const ZERO = { position: vec3(0, 0, 0), rotation: vec3(0, 0, 0) }
  walkNodes(level, types, (r) => {
    const track = r.components.find((c) => c.type === TRACK && c.enabled !== false)
    const behavior =
      track === undefined
        ? ({ kind: 'static' } as const)
        : ({
            kind: 'track',
            keys: keysOf(track),
            ...(typeof track.params.loop === 'string' ? { loop: track.params.loop as LoopMode } : {}),
            ...(typeof track.params.phaseMs === 'number' ? { phaseMs: track.params.phaseMs } : {}),
          } as const)
    const motions = motionsOf(r.components)
    if (behavior.kind === 'static' && motions.length === 0) return
    // Lines are held back until one of them is non-zero, so the gate is about **effect** and not presence. A
    // track that contributes nothing at any instant has to fingerprint the same as no component at all, or
    // dropping the dead one would read as a difference.
    const lines: string[] = []
    let moved = false
    for (const t of SAMPLE_MS) {
      const pose = poseAt(behavior, ZERO, t)
      const m = motionOffset(motions, t)
      const p = vec3(pose.position.x + m.position.x, pose.position.y + m.position.y, pose.position.z + m.position.z)
      const q = vec3(pose.rotation.x + m.rotation.x, pose.rotation.y + m.rotation.y, pose.rotation.z + m.rotation.z)
      // Rounded to a tenth of a millimetre and a ten-thousandth of a radian: tight enough to catch a wrong
      // speed, phase or axis, loose enough that the two ways of computing the same motion agree.
      if (Math.abs(p.x) + Math.abs(p.y) + Math.abs(p.z) + Math.abs(q.x) + Math.abs(q.y) + Math.abs(q.z) > POS_EPS) moved = true
      // Full precision. Rounding here would make the gate trip on a rounding *boundary* rather than on a
      // real difference, which is exactly what it did first: two angles 1.5e-5 rad apart straddled the
      // fourth decimal and read as a change. The tolerance belongs in the comparison, stated once.
      lines.push(`${r.id}@${t} ${p.x},${p.y},${p.z} ${q.x},${q.y},${q.z}`)
    }
    if (moved) out.push(...lines)
  })
  return out
}

/**
 * Compare two motion fingerprints numerically, and **modulo a full turn** on the rotation channel.
 *
 * Numerically, because the values are two different computations of the same motion and exact float equality
 * is not what is being asserted — `POS_EPS` and `ROT_EPS` say how close counts, in the units a person reads.
 *
 * Modulo a turn, because the keyframe form's last key *is* a full turn, so at the loop instant it reads 2π
 * where the wrapped form reads 0. Same orientation, and the same jump the old track already made, so a whole
 * turn of difference is not a difference.
 */
export const firstMotionDifference = (before: readonly string[], after: readonly string[]): { at: number; before?: string; after?: string } | null => {
  if (before.length !== after.length) {
    const at = Math.min(before.length, after.length)
    return { at, ...(before[at] !== undefined ? { before: before[at] } : {}), ...(after[at] !== undefined ? { after: after[at] } : {}) }
  }
  const TURN = Math.PI * 2
  /** `a` and `b` are the same angle if they differ by a whole number of turns, `ROT_EPS` either way. */
  const sameAngle = (a: number, b: number): boolean => {
    const turns = Math.abs(a - b) / TURN
    return Math.abs(turns - Math.round(turns)) * TURN < ROT_EPS
  }
  const nums = (s: string | undefined): number[] => (s ?? '').split(',').map(Number)
  for (let i = 0; i < before.length; i++) {
    const a = before[i]!
    const b = after[i]!
    if (a === b) continue
    const pa = a.split(' ')
    const pb = b.split(' ')
    if (pa[0] !== pb[0]) return { at: i, before: a, after: b }
    const [pos, rot] = [nums(pa[1]), nums(pa[2])]
    const [pos2, rot2] = [nums(pb[1]), nums(pb[2])]
    const samePos = pos.length === pos2.length && pos.every((v, j) => Math.abs(v - pos2[j]!) < POS_EPS)
    const sameRot = rot.length === rot2.length && rot.every((v, j) => sameAngle(v, rot2[j]!))
    if (samePos && sameRot) continue
    return { at: i, before: a, after: b }
  }
  return null
}

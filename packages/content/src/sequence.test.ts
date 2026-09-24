import { axisAngleToQuat, eulerToQuat, mulQuat, rotateVec3, vec3, type Quat, type Vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import {
  EASES,
  SELF,
  TOP_FRAME,
  combineSequences,
  compileSequence,
  easeAt,
  sampleSequence,
  sequenceTime,
  type CompiledSequence,
  type Ease,
  type NodeFrame,
  type Sequence,
  type SequencePose,
  type Stage,
  type Step,
  type Timing,
} from './sequence'

let ids = 0
const id = (): string => `x${++ids}`
const secs = (seconds: number): Timing => ({ by: 'seconds', seconds })
const speed = (v: number): Timing => ({ by: 'speed', speed: v })
const STAGE: Timing = { by: 'stage' }
const spinFor = (v: number): Timing => ({ by: 'stage', speed: v })
const aimed = (target: string | undefined): { target?: string } => (target === undefined ? {} : { target })

const move = (to: Vec3, timing: Timing, ease: Ease = 'linear', target?: string): Step => ({ id: id(), kind: 'move', to, timing, ease, ...aimed(target) })
const turn = (axis: Vec3, angle: number, timing: Timing, ease: Ease = 'linear'): Step => ({ id: id(), kind: 'turn', axis, angle, timing, ease })
const scale = (to: Vec3, timing: Timing, ease: Ease = 'linear'): Step => ({ id: id(), kind: 'scale', to, timing, ease })
const fade = (to: number, timing: Timing, ease: Ease = 'linear'): Step => ({ id: id(), kind: 'fade', to, timing, ease })
const collider = (on: boolean): Step => ({ id: id(), kind: 'collider', on })
const enabled = (on: boolean): Step => ({ id: id(), kind: 'enabled', on })
const wait = (seconds: number): Step => ({ id: id(), kind: 'wait', seconds })
const stage = (...steps: Step[]): Stage => ({ id: id(), steps })
const sequence = (stages: Stage[], over: Partial<Sequence> = {}): Sequence => ({
  name: 'test',
  clock: 'shared',
  axes: 'object',
  loop: 'restart',
  times: 0,
  offset: 0,
  stages,
  ...over,
})

/** The object's own pose at `seconds` on the shared clock. */
const at = (c: CompiledSequence, seconds: number, target: string = SELF): SequencePose => {
  const pose = sampleSequence(c, { shared: seconds * 1000, local: 0 }).get(target)
  if (pose === undefined) throw new Error(`nothing targets '${target}'`)
  return pose
}

const expectVec = (got: Vec3, want: Vec3, digits = 9): void => {
  expect(got.x).toBeCloseTo(want.x, digits)
  expect(got.y).toBeCloseTo(want.y, digits)
  expect(got.z).toBeCloseTo(want.z, digits)
}
/** Two rotations are the same when they turn a few test vectors to the same place. */
const expectSameTurn = (got: Quat, want: Quat): void => {
  for (const v of [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1), vec3(0.3, -0.7, 0.2)]) expectVec(rotateVec3(got, v), rotateVec3(want, v))
}
const DEG = Math.PI / 180
/** A pose as a string, so two can be compared exactly, every channel at once. */
const exact = (p: SequencePose): string => JSON.stringify(p)
/** Two poses that agree to rounding, every channel at once. */
const expectSamePose = (got: SequencePose, want: SequencePose, why = ''): void => {
  expectVec(got.position, want.position)
  expectVec(got.scale, want.scale)
  expectSameTurn(got.turn, want.turn)
  expect(got.opacity, why).toBeCloseTo(want.opacity, 9)
  expect(got.collider, why).toBe(want.collider)
  expect(got.enabled, why).toBe(want.enabled)
}

describe('easing', () => {
  it('has the full standard set', () => {
    expect(EASES).toHaveLength(31)
  })

  /** A held pose must be the point that was typed, not the formula's last bits. */
  it('lands exactly on 0 and 1 at the ends, for every ease', () => {
    for (const e of EASES) {
      expect(easeAt(e, 0), e).toBe(0)
      expect(easeAt(e, 1), e).toBe(1)
      expect(easeAt(e, -3), e).toBe(0)
      expect(easeAt(e, 7), e).toBe(1)
    }
  })

  it('crosses halfway at the middle for every in-out ease', () => {
    for (const e of EASES.filter((n) => n.startsWith('in-out-'))) expect(easeAt(e, 0.5), e).toBeCloseTo(0.5, 6)
  })

  it('names quart and quint as the fourth and fifth power', () => {
    expect(easeAt('in-quart', 0.5)).toBeCloseTo(0.0625, 12)
    expect(easeAt('in-quint', 0.5)).toBeCloseTo(0.03125, 12)
  })
})

/**
 * Kodjo's first case: a ball spawns, falls onto a slope, rolls down it, despawns at the bottom, waits, and
 * does it again. The roll is at a speed and spins "as long as its stage", so its length is worked out.
 */
describe('the ball', () => {
  const rollSeconds = Math.hypot(5, 10) / 8
  const c = compileSequence(
    sequence([
      stage(move(vec3(0, -2, 0), secs(1), 'in-quad')),
      stage(move(vec3(0, -7, 10), speed(8)), turn(vec3(1, 0, 0), 0, spinFor(360))),
      stage(enabled(false)),
      stage(wait(2)),
    ]),
  )

  it('works out how long a pass is', () => {
    expect(c.passSeconds).toBeCloseTo(1 + rollSeconds + 2, 12)
    const lengths = c.stages.map((s) => s.duration)
    for (const [n, want] of [1, rollSeconds, 0, 2].entries()) expect(lengths[n]).toBeCloseTo(want, 12)
    expect(c.problems).toEqual([])
  })

  it('drops on its ease', () => {
    expectVec(at(c, 0.5).position, vec3(0, -0.5, 0))
  })

  it('rolls from where the drop ended, at the speed typed', () => {
    expectVec(at(c, 1).position, vec3(0, -2, 0))
    expectVec(at(c, 1 + rollSeconds / 2).position, vec3(0, -4.5, 5))
    expectVec(at(c, 1 + rollSeconds).position, vec3(0, -7, 10))
  })

  it('spins while it rolls, at 360°/s for exactly as long as the roll', () => {
    expectSameTurn(at(c, 1 + rollSeconds / 2).turn, axisAngleToQuat(vec3(1, 0, 0), 360 * (rollSeconds / 2) * DEG))
    expectSameTurn(at(c, 0.5).turn, axisAngleToQuat(vec3(1, 0, 0), 0))
  })

  it('is as it was set up until it despawns at the bottom, then gone through the wait', () => {
    expect(at(c, 1 + rollSeconds / 2).enabled).toBeUndefined()
    expect(at(c, 1 + rollSeconds).enabled).toBe(false)
    expect(at(c, 1 + rollSeconds + 1.5).enabled).toBe(false)
  })

  it('comes back at the start, as set up, when it repeats', () => {
    const again = at(c, c.passSeconds + 0.25)
    expect(again.enabled).toBeUndefined()
    expectVec(again.position, at(c, 0.25).position)
  })
})

/**
 * The second: a platform fades in, its collider comes on at the end of the fade, it stays, fades out,
 * collider off, waits. It starts hidden because its first stage says so — the object is as set up until a
 * step changes it.
 */
describe('the fading platform', () => {
  const c = compileSequence(
    sequence([
      stage(collider(false), fade(0, secs(0))),
      stage(fade(1, secs(1))),
      stage(collider(true)),
      stage(wait(3)),
      stage(fade(0, secs(1))),
      stage(collider(false)),
      stage(wait(2)),
    ]),
  )

  it('is 7 s a pass', () => {
    expect(c.passSeconds).toBe(7)
  })

  it('starts invisible with no collider', () => {
    expect(at(c, 0).opacity).toBe(0)
    expect(at(c, 0).collider).toBe(false)
  })

  it('switches its collider on exactly at the end of the fade in', () => {
    expect(at(c, 0.5).opacity).toBeCloseTo(0.5, 12)
    expect(at(c, 0.999).collider).toBe(false)
    expect(at(c, 1).collider).toBe(true)
    expect(at(c, 1).opacity).toBe(1)
  })

  it('stays, then fades out with the collider still on, then switches it off', () => {
    expect(at(c, 2.5).collider).toBe(true)
    expect(at(c, 4.5).opacity).toBeCloseTo(0.5, 12)
    expect(at(c, 4.5).collider).toBe(true)
    expect(at(c, 5).collider).toBe(false)
    expect(at(c, 6.5).opacity).toBe(0)
  })

  it('is back where it started when it repeats', () => {
    expect(exact(at(c, 7))).toBe(exact(at(c, 0)))
    expect(exact(at(c, 7.5))).toBe(exact(at(c, 0.5)))
  })
})

/** The third: a wall moves forward at a speed to the end of a corridor, despawns, waits, repeats. */
describe('the wall', () => {
  const c = compileSequence(sequence([stage(move(vec3(0, 0, 20), speed(5))), stage(enabled(false)), stage(wait(3))]))

  it('moves at the speed typed, steadily', () => {
    expect(c.passSeconds).toBe(7)
    expectVec(at(c, 1).position, vec3(0, 0, 5))
    expectVec(at(c, 2).position, vec3(0, 0, 10))
  })

  it('despawns at the end and comes back at the start', () => {
    expect(at(c, 4.5).enabled).toBe(false)
    expectVec(at(c, 4.5).position, vec3(0, 0, 20))
    expect(at(c, 7.2).enabled).toBeUndefined()
    expectVec(at(c, 7.2).position, vec3(0, 0, 1))
  })
})

describe('timing', () => {
  it('makes a stage as long as its longest step', () => {
    const c = compileSequence(sequence([stage(move(vec3(1, 0, 0), secs(1)), fade(0, secs(3)))]))
    expect(c.passSeconds).toBe(3)
  })

  it('gives a step timed "as long as its stage" that length', () => {
    const c = compileSequence(sequence([stage(move(vec3(4, 0, 0), secs(2)), fade(0, STAGE))]))
    expect(at(c, 1).opacity).toBeCloseTo(0.5, 12)
    expect(c.steps.get(c.sequence.stages[0]!.steps[1]!.id)).toEqual({ start: 0, duration: 2 })
  })

  it('reports a stage where nothing ends by itself, and gives it no length', () => {
    const lonely = stage(fade(0, STAGE))
    const c = compileSequence(sequence([lonely, stage(wait(1))]))
    expect(c.problems).toContainEqual({ kind: 'stage-has-no-end', stage: lonely.id })
    expect(c.stages[0]!.duration).toBe(0)
  })

  it('counts an instant step as ending by itself', () => {
    const c = compileSequence(sequence([stage(collider(true), fade(0, STAGE))]))
    expect(c.problems).toEqual([])
  })

  /** ADR 0103's rule: the typed speed is the average, so an ease never changes how long the step takes. */
  it('treats a speed as the average: an eased move takes as long as a steady one', () => {
    const steady = compileSequence(sequence([stage(move(vec3(0, 6, 0), speed(3)))]))
    const eased = compileSequence(sequence([stage(move(vec3(0, 6, 0), speed(3), 'in-out-sine'))]))
    expect(eased.passSeconds).toBe(2)
    expect(eased.passSeconds).toBe(steady.passSeconds)
  })

  it('times a turn at a speed by its angle', () => {
    const c = compileSequence(sequence([stage(turn(vec3(0, 1, 0), 90, speed(45)))]))
    expect(c.passSeconds).toBe(2)
    expectSameTurn(at(c, 1).turn, axisAngleToQuat(vec3(0, 1, 0), 45 * DEG))
  })

  it('turns the other way for a negative angle, and ignores the length of the axis', () => {
    const back = compileSequence(sequence([stage(turn(vec3(0, 5, 0), -90, secs(1)))]))
    expectSameTurn(at(back, 0.5).turn, axisAngleToQuat(vec3(0, 1, 0), -45 * DEG))
  })

  it('turns a set angle over the stage when timed "as long as its stage" without a speed', () => {
    const c = compileSequence(sequence([stage(move(vec3(0, 0, 4), secs(4)), turn(vec3(0, 1, 0), 180, STAGE))]))
    expectSameTurn(at(c, 2).turn, axisAngleToQuat(vec3(0, 1, 0), 90 * DEG))
  })

  it('reports what cannot work, and gives it no time', () => {
    const nowhere = move(vec3(0, 0, 0), speed(2))
    const stopped = move(vec3(1, 0, 0), speed(0))
    const fast = fade(0, speed(3))
    const noAxis = turn(vec3(0, 0, 0), 90, secs(1))
    const c = compileSequence(sequence([stage(nowhere), stage(stopped), stage(fast), stage(noAxis)]))
    expect(c.problems).toEqual([
      { kind: 'goes-nowhere', step: nowhere.id },
      { kind: 'speed-not-positive', step: stopped.id },
      { kind: 'speed-not-allowed', step: fast.id },
      { kind: 'goes-nowhere', step: noAxis.id },
    ])
    expect(c.stages.slice(0, 3).map((s) => s.duration)).toEqual([0, 0, 0])
  })
})

describe('points', () => {
  // One pass, then held, so the end can be read: a sequence that repeats is back at its start at that instant.
  it('measures every point from where the object was placed, not from where the last move ended', () => {
    const c = compileSequence(sequence([stage(move(vec3(0, 2, 0), secs(1))), stage(move(vec3(3, 2, 0), secs(1)))], { times: 1 }))
    expectVec(at(c, 5).position, vec3(3, 2, 0))
  })

  /** Kodjo's reason for points: fixing one spot does not move the others. */
  it('leaves every other point where it was when one changes', () => {
    const c = compileSequence(sequence([stage(move(vec3(0, 5, 0), secs(1))), stage(move(vec3(3, 2, 0), secs(1)))], { times: 1 }))
    expectVec(at(c, 5).position, vec3(3, 2, 0))
  })

  it('times a move at a speed from where its target stands when its stage starts', () => {
    const c = compileSequence(sequence([stage(move(vec3(0, 2, 0), secs(1))), stage(move(vec3(3, 2, 0), speed(3)))]))
    expect(c.passSeconds).toBe(2)
  })

  it('files a step aimed at a child under that child', () => {
    const c = compileSequence(sequence([stage(move(vec3(-1, 0, 0), secs(1), 'linear', 'left'), move(vec3(1, 0, 0), secs(1), 'linear', 'right'))]))
    expect(c.targets).toEqual(['left', 'right'])
    expectVec(at(c, 0.5, 'left').position, vec3(-0.5, 0, 0))
    expectVec(at(c, 0.5, 'right').position, vec3(0.5, 0, 0))
  })
})

describe('the starting state', () => {
  it('has no opinion on collider or enabled until a step says', () => {
    const c = compileSequence(sequence([stage(wait(1)), stage(collider(false)), stage(wait(1))]))
    expect(at(c, 0.5, SELF).collider).toBeUndefined()
    expect(at(c, 1.5, SELF).collider).toBe(false)
  })

  it('applies an instant step at 0 s from the very start', () => {
    const c = compileSequence(sequence([stage(enabled(false)), stage(wait(1))]))
    expect(at(c, 0).enabled).toBe(false)
  })
})

describe('yo-yo', () => {
  const ball = (over: Partial<Sequence> = {}): CompiledSequence =>
    compileSequence(
      sequence(
        [
          stage(move(vec3(0, -2, 0), secs(1), 'in-quad')),
          stage(move(vec3(0, -7, 10), secs(1.5)), turn(vec3(1, 0, 0), 540, STAGE), fade(0.4, STAGE)),
          stage(collider(true), scale(vec3(1, 2, 1), secs(0.5), 'out-back')),
          stage(wait(2)),
        ],
        { loop: 'yoyo', ...over },
      ),
    )

  /** A rewind: the way back is the way out played backwards, every channel. */
  it('mirrors every channel about the far end', () => {
    const c = ball()
    const d = c.passSeconds
    // Not exact: `(d + x) - d` and `d - x` are one rounding apart, which is the only difference there is.
    for (let x = 0.0005; x <= d; x += 0.037) expectSamePose(at(c, d + x), at(c, d - x), `${x}`)
  })

  it('undoes instant steps on the way back', () => {
    const c = ball()
    const d = c.passSeconds // 5
    expect(at(c, d + 1).collider).toBe(true) // the mirror of 4 s
    expect(at(c, d + 3).collider).toBeUndefined() // the mirror of 2 s: before it was ever switched on
  })

  it('mirrors the ease too', () => {
    const c = ball()
    expectVec(at(c, 2 * c.passSeconds - 0.5).position, vec3(0, -0.5, 0))
  })

  it('counts a wait at the end twice at the turnaround', () => {
    const c = ball()
    const d = c.passSeconds
    const held = exact(at(c, d - 2))
    for (let t = d - 2; t <= d + 2; t += 0.25) expect(exact(at(c, t)), `${t}`).toBe(held)
  })

  it('is back at the start after out and back, and plays forward again', () => {
    const c = ball()
    const d = c.passSeconds
    expect(exact(at(c, 2 * d))).toBe(exact(at(c, 0)))
    expect(exact(at(c, 2 * d + 0.5))).toBe(exact(at(c, 0.5)))
  })
})

describe('repeat', () => {
  const out = [stage(move(vec3(0, 4, 0), secs(2)))]

  it('plays forever by default', () => {
    const c = compileSequence(sequence(out))
    expect(sequenceTime(c, 101_000)).toBeCloseTo(1, 9)
  })

  it('holds the end once its passes have played', () => {
    const c = compileSequence(sequence(out, { times: 2 }))
    expect(sequenceTime(c, 3_000)).toBeCloseTo(1, 12)
    expect(sequenceTime(c, 4_000)).toBe(2)
    expect(sequenceTime(c, 60_000)).toBe(2)
  })

  /** A pass is one direction, as DOTween counts: two passes of a yo-yo is out and back. */
  it('ends a yo-yo where its last pass ends', () => {
    expect(sequenceTime(compileSequence(sequence(out, { loop: 'yoyo', times: 2 })), 60_000)).toBe(0)
    expect(sequenceTime(compileSequence(sequence(out, { loop: 'yoyo', times: 3 })), 60_000)).toBe(2)
  })
})

describe('offset', () => {
  const out = [stage(move(vec3(0, 4, 0), secs(2)))]

  it('starts a fraction of the way into the cycle', () => {
    expect(sequenceTime(compileSequence(sequence(out, { offset: 0.25 })), 0)).toBeCloseTo(0.5, 12)
  })

  it('takes the fraction of the whole out-and-back for a yo-yo', () => {
    expect(sequenceTime(compileSequence(sequence(out, { loop: 'yoyo', offset: 0.5 })), 0)).toBeCloseTo(2, 12)
  })

  it('wraps a negative offset forward', () => {
    const minus = compileSequence(sequence(out, { offset: -0.25 }))
    const plus = compileSequence(sequence(out, { offset: 0.75 }))
    expect(sequenceTime(minus, 300)).toBeCloseTo(sequenceTime(plus, 300), 12)
  })
})

describe('clocks', () => {
  const stages = [stage(move(vec3(0, 4, 0), secs(4)))]

  it('reads the room clock when shared and this browser’s when local', () => {
    const clocks = { shared: 1000, local: 3000 }
    expectVec(sampleSequence(compileSequence(sequence(stages)), clocks).get(SELF)!.position, vec3(0, 1, 0))
    expectVec(sampleSequence(compileSequence(sequence(stages, { clock: 'local' })), clocks).get(SELF)!.position, vec3(0, 3, 0))
  })
})

/** The rule everything rests on: late joiners, the editor preview and tick slicing all ask for an arbitrary instant. */
describe('a pure function of time', () => {
  const c = compileSequence(
    sequence(
      [
        stage(collider(false), fade(0, secs(0))),
        stage(move(vec3(0, 3, 0), secs(1.3), 'out-bounce'), fade(1, STAGE)),
        stage(collider(true), turn(vec3(1, 1, 0), 720, secs(2), 'in-out-elastic')),
        stage(wait(0.7)),
      ],
      { loop: 'yoyo' },
    ),
  )

  it('gives the same pose for the same time, whatever order the times are asked in', () => {
    const times = Array.from({ length: 500 }, (_, i) => ((i * 7919) % 40_000) / 1000)
    const sorted = [...times].sort((a, b) => a - b)
    const once = new Map(sorted.map((t) => [t, exact(at(c, t))]))
    for (const t of [...times].reverse()) expect(exact(at(c, t))).toBe(once.get(t))
    for (const t of times) expect(exact(at(c, t))).toBe(once.get(t))
  })

  it('is still right ten hours into a room', () => {
    const cycle = c.cycleSeconds
    const late = Math.round((10 * 3600) / cycle) * cycle
    // Clear of the instants where a switch happens: exactly on one, a rounding decides which side it reads.
    for (let x = 0.0005; x < cycle; x += 0.13) {
      const early = at(c, x)
      const later = at(c, late + x)
      expectVec(later.position, early.position, 6)
      expect(later.opacity).toBeCloseTo(early.opacity, 6)
      expect(later.collider).toBe(early.collider)
    }
  })
})

describe('combineSequences', () => {
  const pose = (over: Partial<SequencePose> = {}): SequencePose => ({
    position: vec3(0, 0, 0),
    turn: { x: 0, y: 0, z: 0, w: 1 },
    scale: vec3(1, 1, 1),
    opacity: 1,
    collider: undefined,
    enabled: undefined,
    ...over,
  })

  it('adds moves', () => {
    const o = combineSequences([{ pose: pose({ position: vec3(1, 0, 0) }), axes: 'object' }, { pose: pose({ position: vec3(0, 2, 0) }), axes: 'object' }], TOP_FRAME)
    expectVec(o.position, vec3(1, 2, 0))
  })

  it('multiplies scales and fades, and keeps a fade inside 0 and 1', () => {
    const o = combineSequences(
      [
        { pose: pose({ scale: vec3(2, 1, 1), opacity: 0.5 }), axes: 'object' },
        { pose: pose({ scale: vec3(1, 3, 1), opacity: 0.5 }), axes: 'object' },
      ],
      TOP_FRAME,
    )
    expectVec(o.scale, vec3(2, 3, 1))
    expect(o.opacity).toBe(0.25)
    expect(combineSequences([{ pose: pose({ opacity: 1.2 }), axes: 'object' }], TOP_FRAME).opacity).toBe(1)
  })

  it('lets off win, and has no opinion when nobody says', () => {
    const combine = (a: boolean | undefined, b: boolean | undefined): boolean | undefined =>
      combineSequences([{ pose: pose({ collider: a, enabled: a }), axes: 'object' }, { pose: pose({ collider: b, enabled: b }), axes: 'object' }], TOP_FRAME).collider
    expect(combine(true, false)).toBe(false)
    expect(combine(false, true)).toBe(false)
    expect(combine(true, undefined)).toBe(true)
    expect(combine(undefined, undefined)).toBeUndefined()
  })

  it('stacks turns one on top of the other, in order', () => {
    const a = axisAngleToQuat(vec3(0, 1, 0), 0.4)
    const b = axisAngleToQuat(vec3(1, 0, 0), 0.9)
    const o = combineSequences([{ pose: pose({ turn: a }), axes: 'object' }, { pose: pose({ turn: b }), axes: 'object' }], TOP_FRAME)
    expectSameTurn(o.rotation, mulQuat(a, b))
  })

  /** What the frame tree does with an offset: `world = parent.world + rotate(parentRot, parentScale × local)`. */
  const worldTravel = (local: Vec3, at: NodeFrame): Vec3 =>
    rotateVec3(at.parentRot, vec3(at.parentScale.x * local.x, at.parentScale.y * local.y, at.parentScale.z * local.z))

  const tilted: NodeFrame = {
    parentRot: axisAngleToQuat(vec3(0, 1, 0), 90 * DEG),
    parentScale: vec3(2, 2, 2),
    ownRotation: vec3(30 * DEG, 0, 0),
  }

  it('moves along the object’s axes as placed, turning with it', () => {
    const o = combineSequences([{ pose: pose({ position: vec3(0, 0, 3) }), axes: 'object' }], tilted)
    const expected = rotateVec3(tilted.parentRot, rotateVec3(eulerToQuat(tilted.ownRotation), vec3(0, 0, 3)))
    expectVec(worldTravel(o.position, tilted), expected)
  })

  it('moves along the level’s axes, a metre a metre, whatever the parent is doing', () => {
    const o = combineSequences([{ pose: pose({ position: vec3(0, 3, 0) }), axes: 'level' }], tilted)
    expectVec(worldTravel(o.position, tilted), vec3(0, 3, 0))
  })

  it('turns about the object’s own axis as placed', () => {
    const q = axisAngleToQuat(vec3(0, 1, 0), 70 * DEG)
    const o = combineSequences([{ pose: pose({ turn: q }), axes: 'object' }], tilted)
    const own = eulerToQuat(tilted.ownRotation)
    expectSameTurn(mulQuat(own, o.rotation), mulQuat(own, q))
  })

  /** The tilted platform on a turntable: its tilt swings round the level's vertical. */
  it('turns about the level’s axis, whatever the parent and the object are rotated to', () => {
    const q = axisAngleToQuat(vec3(0, 1, 0), 70 * DEG)
    const o = combineSequences([{ pose: pose({ turn: q }), axes: 'level' }], tilted)
    const own = eulerToQuat(tilted.ownRotation)
    const world = mulQuat(tilted.parentRot, mulQuat(own, o.rotation))
    expectSameTurn(world, mulQuat(q, mulQuat(tilted.parentRot, own)))
  })
})

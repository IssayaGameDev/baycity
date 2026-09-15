import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { AXES, MOTIONLESS, motionOffset, motionsOf, moveFraction, movesAtAll, spinRadians, type Motion } from './motion'
import { moveTrack, poseAt, spinTrack } from './track'
import type { ComponentData, Transform } from './types'

const mover = (over: Partial<Extract<Motion, { kind: 'move' }>> = {}): Extract<Motion, { kind: 'move' }> => ({
  kind: 'move',
  move: vec3(0, 3, 0),
  speed: 1.5,
  smooth: true,
  offset: 0,
  ...over,
})

const spinner = (over: Partial<Extract<Motion, { kind: 'spin' }>> = {}): Extract<Motion, { kind: 'spin' }> => ({
  kind: 'spin',
  axis: AXES['+Y']!,
  speed: 60,
  offset: 0,
  ...over,
})

const comp = (id: string, type: string, params: Record<string, unknown>, enabled?: boolean): ComponentData => ({
  id,
  type,
  params,
  ...(enabled === undefined ? {} : { enabled }),
})

describe('moveFraction', () => {
  it('derives the period from distance and speed', () => {
    // 3 m at 1.5 m/s is a 2 s leg, so a 4 s cycle: at rest at 0, fully out at 2 s, back at 4 s.
    const m = mover()
    expect(moveFraction(m, 0)).toBeCloseTo(0, 10)
    expect(moveFraction(m, 2000)).toBeCloseTo(1, 10)
    expect(moveFraction(m, 4000)).toBeCloseTo(0, 10)
  })

  it('averages exactly `speed` over a leg, smooth or not', () => {
    // The point of easing per leg: the curve moves time around inside the leg but never lengthens it.
    for (const smooth of [true, false]) {
      const m = mover({ smooth, move: vec3(0, 10, 0), speed: 5 })
      expect(moveFraction(m, 2000)).toBeCloseTo(1, 10) // 10 m at 5 m/s = a 2 s leg
      expect(moveFraction(m, 4000)).toBeCloseTo(0, 10)
    }
  })

  it('is a triangle when smooth is off', () => {
    const m = mover({ smooth: false })
    expect(moveFraction(m, 1000)).toBeCloseTo(0.5, 10)
    expect(moveFraction(m, 3000)).toBeCloseTo(0.5, 10)
  })

  it('eases both ends when smooth is on, so the legs meet with matching slope', () => {
    const m = mover()
    // Cosine, so the quarter point is below the linear half.
    expect(moveFraction(m, 1000)).toBeCloseTo(0.5, 10)
    expect(moveFraction(m, 500)).toBeLessThan(0.25)
    // Symmetric about the far end: equal distance either side of 2 s gives the same fraction.
    expect(moveFraction(m, 1900)).toBeCloseTo(moveFraction(m, 2100), 10)
  })

  it('loops', () => {
    const m = mover()
    expect(moveFraction(m, 4500)).toBeCloseTo(moveFraction(m, 500), 10)
    expect(moveFraction(m, 40_000 + 1234)).toBeCloseTo(moveFraction(m, 1234), 10)
  })

  it('offsets by a fraction of the cycle, wrapping forward on a negative', () => {
    expect(moveFraction(mover({ offset: 0.5 }), 0)).toBeCloseTo(1, 10)
    expect(moveFraction(mover({ offset: 0.25 }), 0)).toBeCloseTo(0.5, 10)
    // A flooring fraction: `%` keeps the sign of the dividend and would run this backwards.
    expect(moveFraction(mover({ offset: -0.5 }), 0)).toBeCloseTo(1, 10)
    expect(moveFraction(mover({ offset: -0.25 }), 0)).toBeCloseTo(0.5, 10)
  })

  it('an offset stays correct when the speed changes, which is why it is not a time', () => {
    // Two platforms half a cycle apart. Double the speed on both and they are still half a cycle apart.
    const at = (speed: number, offset: number, t: number): number => moveFraction(mover({ speed, offset }), t)
    expect(at(1.5, 0, 0)).toBeCloseTo(0, 10)
    expect(at(1.5, 0.5, 0)).toBeCloseTo(1, 10)
    expect(at(3, 0, 0)).toBeCloseTo(0, 10)
    expect(at(3, 0.5, 0)).toBeCloseTo(1, 10)
  })

  it('does not move without a distance or a speed', () => {
    expect(moveFraction(mover({ speed: 0 }), 1234)).toBe(0)
    expect(moveFraction(mover({ move: vec3(0, 0, 0) }), 1234)).toBe(0)
    expect(moveFraction(mover({ speed: -5 }), 1234)).toBe(0)
  })
})

describe('spinRadians', () => {
  it('turns once per 360 degrees of travel', () => {
    const s = spinner() // 60 deg/s = one turn every 6 s
    expect(spinRadians(s, 0)).toBeCloseTo(0, 10)
    expect(spinRadians(s, 1500)).toBeCloseTo(Math.PI / 2, 10)
    expect(spinRadians(s, 3000)).toBeCloseTo(Math.PI, 10)
  })

  it('wraps at a full turn, which is the orientation it started from', () => {
    const s = spinner()
    expect(spinRadians(s, 6000)).toBeCloseTo(0, 10)
    expect(spinRadians(s, 6000 + 1500)).toBeCloseTo(Math.PI / 2, 10)
  })

  it('offsets by a fraction of a turn', () => {
    expect(spinRadians(spinner({ offset: 0.25 }), 0)).toBeCloseTo(Math.PI / 2, 10)
  })

  it('runs backwards on a negative speed', () => {
    expect(spinRadians(spinner({ speed: -60 }), 1500)).toBeCloseTo(Math.PI * 1.5, 10)
  })
})

describe('motionOffset', () => {
  it('returns the shared still offset when there is nothing to do', () => {
    expect(motionOffset([], 1234)).toBe(MOTIONLESS)
  })

  it('scales the travel by the fraction, on every axis at once', () => {
    const o = motionOffset([mover({ move: vec3(2, 4, -6), speed: 1000 /* far past the end */, smooth: false })], 0)
    expect(o.position).toEqual(vec3(0, 0, 0))
    const half = motionOffset([mover({ move: vec3(2, 4, -6), smooth: false })], 0)
    expect(half.rotation).toEqual(vec3(0, 0, 0)) // a mover contributes nothing to rotation
  })

  it('adds several movers, which is how a circle is authored', () => {
    // Up-and-down plus side-to-side a quarter cycle apart. At t=0 one is at rest and the other is halfway.
    const motions: Motion[] = [mover({ move: vec3(0, 4, 0), speed: 2, smooth: false }), mover({ move: vec3(4, 0, 0), speed: 2, smooth: false, offset: 0.25 })]
    const o = motionOffset(motions, 0)
    expect(o.position.y).toBeCloseTo(0, 10)
    expect(o.position.x).toBeCloseTo(2, 10)
  })

  it('puts a spin on the rotation channel only, about the chosen axis', () => {
    const o = motionOffset([spinner({ axis: AXES['-Z']!, speed: 90 })], 1000)
    expect(o.position).toEqual(vec3(0, 0, 0))
    expect(o.rotation.x).toBe(0)
    expect(o.rotation.y).toBe(0)
    expect(o.rotation.z).toBeCloseTo(-Math.PI / 2, 10)
  })

  it('composes a mover and a spinner on one node', () => {
    const o = motionOffset([mover({ smooth: false }), spinner()], 1000)
    expect(o.position.y).toBeCloseTo(1.5, 10)
    expect(o.rotation.y).toBeCloseTo(Math.PI / 3, 10)
  })
})

describe('movesAtAll', () => {
  it('is false with nothing, no speed, or no distance — the loader keeps those bodies fixed', () => {
    expect(movesAtAll([])).toBe(false)
    expect(movesAtAll([mover({ speed: 0 })])).toBe(false)
    expect(movesAtAll([mover({ move: vec3(0, 0, 0) })])).toBe(false)
    expect(movesAtAll([spinner({ speed: 0 })])).toBe(false)
  })

  it('is true when any one of them moves', () => {
    expect(movesAtAll([mover()])).toBe(true)
    expect(movesAtAll([spinner()])).toBe(true)
    expect(movesAtAll([mover({ speed: 0 }), spinner()])).toBe(true)
    expect(movesAtAll([spinner({ speed: -15 })])).toBe(true)
  })
})

describe('motionsOf', () => {
  it('reads every Mover in order, then the Spinner', () => {
    const motions = motionsOf([
      comp('c0', 'Mover', { move: vec3(0, 5, 0), speed: 2, smooth: false, offset: 0.5 }),
      comp('c1', 'Spinner', { axis: '-X', speed: 45, offset: 0.1 }),
      comp('c2', 'Mover', { move: vec3(3, 0, 0), speed: 1 }),
    ])
    expect(motions).toEqual([
      { kind: 'move', move: vec3(0, 5, 0), speed: 2, smooth: false, offset: 0.5 },
      { kind: 'move', move: vec3(3, 0, 0), speed: 1, smooth: true, offset: 0 },
      { kind: 'spin', axis: AXES['-X'], speed: 45, offset: 0.1 },
    ])
  })

  it('skips a disabled one, so switching a Mover off in the Inspector stops it', () => {
    expect(motionsOf([comp('c0', 'Mover', { move: vec3(0, 3, 0), speed: 2 }, false)])).toEqual([])
    expect(motionsOf([comp('c0', 'Spinner', { speed: 90 }, false)])).toEqual([])
  })

  it('takes only the first Spinner, because two rotations do not add', () => {
    const motions = motionsOf([comp('c0', 'Spinner', { axis: '+Y', speed: 90 }), comp('c1', 'Spinner', { axis: '+X', speed: 45 })])
    expect(motions).toHaveLength(1)
    expect(motions[0]).toEqual({ kind: 'spin', axis: AXES['+Y'], speed: 90, offset: 0 })
  })

  it('survives a hand-edited file: missing and malformed params fall back rather than throw', () => {
    expect(motionsOf([comp('c0', 'Mover', {})])).toEqual([{ kind: 'move', move: vec3(0, 0, 0), speed: 0, smooth: true, offset: 0 }])
    expect(motionsOf([comp('c0', 'Spinner', { axis: 'sideways', speed: 'fast' })])).toEqual([{ kind: 'spin', axis: AXES['+Y'], speed: 0, offset: 0 }])
  })

  it('ignores components it does not own', () => {
    expect(motionsOf([comp('c0', 'Collider', {}), comp('c1', 'Hazard', {})])).toEqual([])
  })
})

/**
 * The migration proof, as a test.
 *
 * Every `Track` authored in the repo is the output of one of the two presets, so if a Mover and a Spinner
 * reproduce those presets pose for pose, converting the content cannot change anything anyone can see. The
 * conversion is `speed = 2 · distance / period` and `speed = 360 / periodSeconds`.
 */
describe('equivalence with the keyframe presets it replaces', () => {
  const base: Transform = { position: vec3(10, 2, -4), rotation: vec3(0, 0.3, 0) }
  const sweep = [0, 1, 137, 499, 500, 999, 1000, 1500, 1999, 2000, 2001, 3000, 3999, 4000, 4001, 5555, 9000, 123_456]

  it('a Mover matches `moveTrack` exactly', () => {
    for (const [distance, periodMs] of [
      [3, 4000],
      [10.2, 1000],
      [10.1, 4000],
      [1.2, 4000],
      [10, 2000],
    ] as const) {
      const track = { kind: 'track', keys: moveTrack(vec3(0, 1, 0), distance, periodMs), loop: 'loop' } as const
      const m = mover({ move: vec3(0, distance, 0), speed: (2 * distance) / (periodMs / 1000) })
      for (const t of sweep) {
        const old = poseAt(track, base, t)
        const now = motionOffset([m], t)
        expect(now.position.y + base.position.y).toBeCloseTo(old.position.y, 9)
        expect(now.position.x + base.position.x).toBeCloseTo(old.position.x, 9)
        expect(now.position.z + base.position.z).toBeCloseTo(old.position.z, 9)
      }
    }
  })

  it('a Spinner matches `spinTrack` exactly', () => {
    for (const periodMs of [6000, 4000, 1500]) {
      const track = { kind: 'track', keys: spinTrack(vec3(0, 1, 0), periodMs), loop: 'loop' } as const
      const s = spinner({ speed: 360 / (periodMs / 1000) })
      for (const t of sweep) {
        const old = poseAt(track, base, t)
        const now = motionOffset([s], t)
        // The old track's last key is a full turn, so at the loop point it reads 2π where the wrap reads 0.
        // Same orientation, and the same jump the keyframe form already made — compared modulo a turn.
        const delta = Math.abs(((now.rotation.y + (base.rotation?.y ?? 0) - old.rotation.y) % (Math.PI * 2)) / (Math.PI * 2))
        expect(Math.min(delta, 1 - delta)).toBeCloseTo(0, 9)
      }
    }
  })
})

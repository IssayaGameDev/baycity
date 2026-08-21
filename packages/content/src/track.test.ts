import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { easeAt, isAnimated, moveTrack, poseAt, spinTrack, trackDuration, trackTime } from './track'
import type { Behavior, Keyframe, Transform } from './types'

const AT_ORIGIN: Transform = { position: vec3(0, 0, 0) }
const track = (keys: Keyframe[], over: Partial<Extract<Behavior, { kind: 'track' }>> = {}): Behavior => ({
  kind: 'track',
  keys,
  ...over,
})

describe('trackDuration', () => {
  it('is the last key time, not the key count', () => {
    expect(trackDuration([{ t: 0 }, { t: 250 }, { t: 1000 }])).toBe(1000)
  })

  it('reads the largest time, so an unsorted track still has the right length', () => {
    expect(trackDuration([{ t: 1000 }, { t: 0 }, { t: 400 }])).toBe(1000)
  })

  it('is zero for an empty track and for one key', () => {
    expect(trackDuration([])).toBe(0)
    expect(trackDuration([{ t: 0, position: vec3(1, 2, 3) }])).toBe(0)
  })
})

describe('easeAt', () => {
  it('pins both ends for every curve, so a key is always reached exactly', () => {
    for (const kind of ['linear', 'in', 'out', 'inOut'] as const) {
      expect(easeAt(kind, 0), `${kind} at 0`).toBeCloseTo(0, 12)
      expect(easeAt(kind, 1), `${kind} at 1`).toBeCloseTo(1, 12)
    }
  })

  it('clamps outside [0,1] rather than extrapolating past a key', () => {
    expect(easeAt('linear', -3)).toBe(0)
    expect(easeAt('in', 4)).toBe(1)
  })

  it('holds the start pose for step, including at the very end of the segment', () => {
    expect(easeAt('step', 0)).toBe(0)
    expect(easeAt('step', 0.99)).toBe(0)
    expect(easeAt('step', 1)).toBe(0)
  })

  it('eases in slower than linear and out faster, at the halfway point', () => {
    expect(easeAt('in', 0.5)).toBeLessThan(0.5)
    expect(easeAt('out', 0.5)).toBeGreaterThan(0.5)
    expect(easeAt('inOut', 0.5)).toBeCloseTo(0.5, 12)
    expect(easeAt('linear', 0.5)).toBe(0.5)
  })

  it('treats a missing easing as linear, so an unannotated key needs no default written into the file', () => {
    expect(easeAt(undefined, 0.37)).toBe(0.37)
  })
})

describe('trackTime', () => {
  it('wraps for loop', () => {
    expect(trackTime(1000, 'loop', 0)).toBe(0)
    expect(trackTime(1000, 'loop', 400)).toBe(400)
    expect(trackTime(1000, 'loop', 1000)).toBe(0)
    expect(trackTime(1000, 'loop', 2400)).toBe(400)
  })

  it('mirrors for pingPong, so a 2-key track is a complete there-and-back', () => {
    expect(trackTime(1000, 'pingPong', 0)).toBe(0)
    expect(trackTime(1000, 'pingPong', 1000)).toBe(1000)
    expect(trackTime(1000, 'pingPong', 1500)).toBe(500) // coming back
    expect(trackTime(1000, 'pingPong', 2000)).toBe(0) // home
    expect(trackTime(1000, 'pingPong', 3500)).toBe(500) // and again next cycle
  })

  it('holds the end for once, and never runs past it', () => {
    expect(trackTime(1000, 'once', 400)).toBe(400)
    expect(trackTime(1000, 'once', 1000)).toBe(1000)
    expect(trackTime(1000, 'once', 99_999)).toBe(1000)
  })

  it('defaults to looping when no mode is given', () => {
    expect(trackTime(1000, undefined, 2400)).toBe(400)
  })

  // The lockstep hole: without a phase, every mover sharing a period is at the same point forever.
  it('shifts the clock by the phase, which is what staggers two identical tracks', () => {
    expect(trackTime(1000, 'loop', 0, 250)).toBe(250)
    expect(trackTime(1000, 'loop', 900, 250)).toBe(150) // wrapped past the end
  })

  // `%` keeps the sign of the dividend in JavaScript, so a naive implementation sends this backwards.
  it('handles a negative phase without running the track in reverse', () => {
    expect(trackTime(1000, 'loop', 0, -250)).toBe(750)
    expect(trackTime(1000, 'loop', 100, -250)).toBe(850)
  })

  it('is zero for a zero-length track, whatever the time', () => {
    expect(trackTime(0, 'loop', 12_345)).toBe(0)
  })
})

describe('poseAt', () => {
  it('returns the authored pose for a static behavior', () => {
    const base: Transform = { position: vec3(1, 2, 3), rotation: vec3(0, 0.5, 0) }
    const pose = poseAt({ kind: 'static' }, base, 9999)
    expect(pose.position).toEqual(vec3(1, 2, 3))
    expect(pose.rotation).toEqual(vec3(0, 0.5, 0))
  })

  it('interpolates position between two keys', () => {
    const b = track([
      { t: 0, position: vec3(0, 0, 0) },
      { t: 1000, position: vec3(0, 10, 0) },
    ])
    expect(poseAt(b, AT_ORIGIN, 0).position.y).toBeCloseTo(0, 9)
    expect(poseAt(b, AT_ORIGIN, 250).position.y).toBeCloseTo(2.5, 9)
    expect(poseAt(b, AT_ORIGIN, 750).position.y).toBeCloseTo(7.5, 9)
  })

  it('lands exactly on a key at its own time', () => {
    const b = track([
      { t: 0, position: vec3(0, 0, 0), easing: 'inOut' },
      { t: 400, position: vec3(1, 5, -2), easing: 'in' },
      { t: 1000, position: vec3(0, 0, 0) },
    ])
    expect(poseAt(b, AT_ORIGIN, 400).position).toEqual(vec3(1, 5, -2))
  })

  // Per-channel fallback: the reason a lift needs no rotation data and a turntable needs no position data.
  it('leaves a channel at its authored value when no key touches it', () => {
    const base: Transform = { position: vec3(7, 0, 7), rotation: vec3(0, 1.25, 0) }
    const lift = track([
      { t: 0, position: vec3(0, 0, 0) },
      { t: 1000, position: vec3(0, 3, 0) },
    ])
    expect(poseAt(lift, base, 500).rotation, 'authored tilt survives a translation-only track').toEqual(vec3(0, 1.25, 0))

    const turntable = track([
      { t: 0, rotation: vec3(0, 0, 0) },
      { t: 1000, rotation: vec3(0, Math.PI * 2, 0) },
    ])
    expect(poseAt(turntable, base, 500).position, 'authored position survives a spin-only track').toEqual(vec3(7, 0, 7))
  })

  // ------------------------------------------------------------------------------------------------------
  // Offsets, not poses (ADR 0050). These are the properties the whole rework rests on.
  // ------------------------------------------------------------------------------------------------------

  // `once` throughout this block, so the last key can be sampled at its own time: under a loop the end *is*
  // the start, so `t === duration` reads back as the first key and would prove nothing about composition.
  it('adds a position key to the authored position instead of replacing it', () => {
    const base: Transform = { position: vec3(10, 2, -5) }
    const b = track(
      [
        { t: 0, position: vec3(0, 0, 0) },
        { t: 1000, position: vec3(0, 4, 0) },
      ],
      { loop: 'once' },
    )
    expect(poseAt(b, base, 0).position, 'a zero key is the rest pose').toEqual(vec3(10, 2, -5))
    expect(poseAt(b, base, 500).position, 'halfway is halfway up from it').toEqual(vec3(10, 4, -5))
    expect(poseAt(b, base, 1000).position, 'and a key of 4 is four metres up from it').toEqual(vec3(10, 6, -5))
  })

  it('adds a rotation key to the authored rotation, so a spin composes onto a tilt', () => {
    const tilted: Transform = { position: vec3(0, 0, 0), rotation: vec3(0.3, 0, 0) }
    const spin = track(
      [
        { t: 0, rotation: vec3(0, 0, 0) },
        { t: 1000, rotation: vec3(0, Math.PI, 0) },
      ],
      { loop: 'once' },
    )
    const pose = poseAt(spin, tilted, 1000)
    expect(pose.rotation.x, 'the tilt is still there').toBeCloseTo(0.3, 9)
    expect(pose.rotation.y, 'and the spin landed on top of it').toBeCloseTo(Math.PI, 9)
  })

  /**
   * The property that lets a track be shared. Under absolute keys the same `keys` array put two objects in
   * the *same* place; under offsets it gives them the same motion wherever each one stands, which is what
   * makes a clip asset possible at all.
   */
  it('gives two objects the same motion from different rest poses', () => {
    const keys: Keyframe[] = [
      { t: 0, position: vec3(0, 0, 0), easing: 'inOut' },
      { t: 1000, position: vec3(0, 3, 0), easing: 'inOut' },
      { t: 2000, position: vec3(0, 0, 0) },
    ]
    const b = track(keys, { loop: 'loop' })
    const here: Transform = { position: vec3(0, 0, 0) }
    const there: Transform = { position: vec3(-20, 6, 13) }
    for (let t = 0; t <= 2000; t += 125) {
      const a = poseAt(b, here, t)
      const c = poseAt(b, there, t)
      expect(c.position.x - there.position.x, `x at ${t}ms`).toBeCloseTo(a.position.x, 9)
      expect(c.position.y - there.position.y, `y at ${t}ms`).toBeCloseTo(a.position.y, 9)
      expect(c.position.z - there.position.z, `z at ${t}ms`).toBeCloseTo(a.position.z, 9)
    }
  })

  it('holds a single key as a fixed pose', () => {
    const b = track([{ t: 0, position: vec3(2, 2, 2) }])
    expect(poseAt(b, AT_ORIGIN, 0).position).toEqual(vec3(2, 2, 2))
    expect(poseAt(b, AT_ORIGIN, 50_000).position).toEqual(vec3(2, 2, 2))
    expect(isAnimated(b), 'and it is not animated, so the loader can leave it static').toBe(false)
  })

  it('falls back to the authored pose for a track with no keys at all', () => {
    const base: Transform = { position: vec3(4, 5, 6), rotation: vec3(0.1, 0.2, 0.3) }
    expect(poseAt(track([]), base, 123).position).toEqual(vec3(4, 5, 6))
    expect(poseAt(track([]), base, 123).rotation).toEqual(vec3(0.1, 0.2, 0.3))
  })

  it('samples the right segment even when the keys are stored out of order', () => {
    const sorted = track([
      { t: 0, position: vec3(0, 0, 0) },
      { t: 1000, position: vec3(0, 10, 0) },
    ])
    const shuffled = track([
      { t: 1000, position: vec3(0, 10, 0) },
      { t: 0, position: vec3(0, 0, 0) },
    ])
    expect(poseAt(shuffled, AT_ORIGIN, 300).position.y).toBeCloseTo(poseAt(sorted, AT_ORIGIN, 300).position.y, 9)
  })

  it('treats two keys at the same time as an instant jump instead of dividing by zero', () => {
    const b = track([
      { t: 0, position: vec3(0, 0, 0) },
      { t: 500, position: vec3(0, 0, 0) },
      { t: 500, position: vec3(0, 9, 0) },
      { t: 1000, position: vec3(0, 9, 0) },
    ])
    const y = poseAt(b, AT_ORIGIN, 600).position.y
    expect(Number.isFinite(y), 'no NaN from a zero-length segment').toBe(true)
    expect(y).toBeCloseTo(9, 9)
  })

  // A dwell is two keys at one pose, which is the thing `move` could not express at all.
  it('pauses at a pose when two keys share it', () => {
    const b = track([
      { t: 0, position: vec3(0, 0, 0), easing: 'inOut' },
      { t: 1000, position: vec3(0, 5, 0) }, // arrive
      { t: 2000, position: vec3(0, 5, 0), easing: 'inOut' }, // wait here
      { t: 3000, position: vec3(0, 0, 0) },
    ])
    for (const t of [1000, 1400, 1800, 2000]) {
      expect(poseAt(b, AT_ORIGIN, t).position.y, `held at ${t}ms`).toBeCloseTo(5, 9)
    }
    expect(poseAt(b, AT_ORIGIN, 2500).position.y, 'and then leaves').toBeLessThan(5)
  })

  it('applies the easing of the key the segment leaves, not the one it arrives at', () => {
    const b = track([
      { t: 0, position: vec3(0, 0, 0), easing: 'step' },
      { t: 1000, position: vec3(0, 10, 0), easing: 'linear' },
      { t: 2000, position: vec3(0, 20, 0) },
    ])
    expect(poseAt(b, AT_ORIGIN, 900).position.y, 'first segment steps, so it holds 0').toBeCloseTo(0, 9)
    expect(poseAt(b, AT_ORIGIN, 1500).position.y, 'second segment is linear').toBeCloseTo(15, 9)
  })
})

describe('presets', () => {
  /**
   * The migration proof. `move` computed `distance · (1 − cos(2π·t/T)) / 2` from the home position, and
   * ADR 0029 replaced it with a 3-key track. If these disagree anywhere, every authored mover in the
   * project changed feel when the schema changed — so this compares them across a whole period rather
   * than at the endpoints, where any easing would agree.
   */
  it('moveTrack reproduces the old move behavior exactly', () => {
    const base = vec3(2, 1, -4)
    const axis = vec3(0, 1, 0)
    const distance = 3
    const periodMs = 4000
    const b = track(moveTrack(axis, distance, periodMs), { loop: 'loop' })

    const oldMove = (nowMs: number): number => base.y + (distance * (1 - Math.cos((nowMs / periodMs) * Math.PI * 2))) / 2

    // Still the exact comparison, and now also proof that offsets compose: the preset knows nothing about
    // `base`, and the sum still tracks a formula written in absolute world metres.
    for (let t = 0; t <= periodMs; t += 50) {
      expect(poseAt(b, { position: base }, t).position.y, `t=${t}ms`).toBeCloseTo(oldMove(t), 9)
    }
  })

  it('moveTrack normalizes the axis, so an unnormalized one still travels the given distance', () => {
    const keys = moveTrack(vec3(0, 5, 0), 3, 1000)
    expect(keys[1]!.position!.y).toBeCloseTo(3, 9)
  })

  it('moveTrack starts and ends at rest, so looping is seamless', () => {
    const keys = moveTrack(vec3(1, 0, 0), 4, 2000)
    expect(keys[0]!.position).toEqual(vec3(0, 0, 0))
    expect(keys[2]!.position).toEqual(vec3(0, 0, 0))
  })

  it('spinTrack turns a full circle over the period, which loops seamlessly', () => {
    const keys = spinTrack(vec3(0, 1, 0), 6000)
    const b = track(keys, { loop: 'loop' })
    expect(poseAt(b, AT_ORIGIN, 0).rotation.y).toBeCloseTo(0, 9)
    expect(poseAt(b, AT_ORIGIN, 1500).rotation.y).toBeCloseTo(Math.PI / 2, 9)
    expect(poseAt(b, AT_ORIGIN, 3000).rotation.y).toBeCloseTo(Math.PI, 9)
    expect(poseAt(b, AT_ORIGIN, 6000).rotation.y, 'wraps to the start, which is the same orientation').toBeCloseTo(0, 9)
  })

  it('spinTrack reverses for a negative axis', () => {
    const keys = spinTrack(vec3(0, -1, 0), 1000)
    expect(keys[1]!.rotation!.y).toBeCloseTo(-Math.PI * 2, 9)
  })

  it('spinTrack takes the dominant axis, since euler keys cannot spin about a slanted one', () => {
    expect(spinTrack(vec3(0.2, 0.1, 0.9), 1000)[1]!.rotation).toEqual(vec3(0, 0, Math.PI * 2))
    expect(spinTrack(vec3(1, 0, 0), 1000)[1]!.rotation).toEqual(vec3(Math.PI * 2, 0, 0))
  })

  /**
   * A tilt used to have to be baked into both keys, so the preset needed the current pose to avoid dropping
   * it. Offsets make that the transform's job, and this pins the consequence: the preset emits pure zeros and
   * the tilt survives anyway.
   */
  it('spinTrack starts from zero and lets the transform carry any tilt', () => {
    const keys = spinTrack(vec3(0, 1, 0), 1000)
    expect(keys[0]!.rotation).toEqual(vec3(0, 0, 0))
    const tilted: Transform = { position: vec3(0, 0, 0), rotation: vec3(0.3, 0, 0) }
    expect(poseAt(track(keys), tilted, 0).rotation.x, 'the tilt is carried, not dropped').toBeCloseTo(0.3, 9)
    expect(poseAt(track(keys), tilted, 500).rotation.x, 'and it stays put mid-spin').toBeCloseTo(0.3, 9)
  })
})

describe('isAnimated', () => {
  it('is false for static and for a zero-length track, true once there is a span', () => {
    expect(isAnimated({ kind: 'static' })).toBe(false)
    expect(isAnimated(track([]))).toBe(false)
    expect(isAnimated(track([{ t: 0, position: vec3(0, 0, 0) }]))).toBe(false)
    expect(isAnimated(track([{ t: 0 }, { t: 0, position: vec3(1, 1, 1) }])), 'all keys at one time').toBe(false)
    expect(isAnimated(track([{ t: 0 }, { t: 1, position: vec3(1, 1, 1) }]))).toBe(true)
  })
})

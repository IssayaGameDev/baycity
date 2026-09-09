import { vec3, type Vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { bestAnchor, DEFAULT_ROPE, ropeForce, scoreAnchor, type Rope } from './rope'

/**
 * The rope, as arithmetic (ADR 0067).
 *
 * All of it headless, which is why the maths is a separate file from the component that drives it: a pendulum
 * either conserves energy or it does not, and no amount of playing it tells you which as reliably as a number
 * does.
 */

const T = DEFAULT_ROPE
const HERE = vec3(0, 0, 0)
/** Moving along +Z, which is the direction every "ahead" case below is measured against. */
const FORWARD = vec3(0, 0, 1)

const at = (x: number, y: number, z: number): Vec3 => vec3(x, y, z)

describe('scoring an anchor', () => {
  it('takes one ahead, above and in the distance band', () => {
    expect(scoreAnchor(HERE, FORWARD, at(0, 8, 8), T)).not.toBeNull()
  })

  it('rejects anything behind', () => {
    // A good swing anchor puts you at the *start* of a downswing. Behind you it swings you backwards.
    expect(scoreAnchor(HERE, FORWARD, at(0, 8, -8), T)).toBeNull()
  })

  it('rejects anything too shallow', () => {
    // Level with you, at the far edge of the band: nothing to fall through.
    expect(scoreAnchor(HERE, FORWARD, at(0, 0.2, 10), T)).toBeNull()
  })

  it('rejects anything too near or too far', () => {
    expect(scoreAnchor(HERE, FORWARD, at(0, 2, 1), T)).toBeNull()
    expect(scoreAnchor(HERE, FORWARD, at(0, 20, 30), T)).toBeNull()
  })

  /** Straight overhead is the case that reads as fine and plays as hanging: it has no horizontal at all. */
  it('rejects one directly overhead', () => {
    expect(scoreAnchor(HERE, FORWARD, at(0, 10, 0), T)).toBeNull()
  })

  it('prefers more directly ahead, all else equal', () => {
    const straight = scoreAnchor(HERE, FORWARD, at(0, 7, 7), T)
    const offToTheSide = scoreAnchor(HERE, FORWARD, at(5, 7, 5), T)
    expect(straight).not.toBeNull()
    expect(offToTheSide).not.toBeNull()
    expect(straight!).toBeGreaterThan(offToTheSide!)
  })

  it('prefers the middle of the distance band over either end', () => {
    const mid = (T.minLength + T.maxLength) / 2
    const middling = scoreAnchor(HERE, FORWARD, at(0, mid * 0.7, mid * 0.7), T)
    const nearlyTooClose = scoreAnchor(HERE, FORWARD, at(0, T.minLength * 0.75, T.minLength * 0.75), T)
    expect(middling).not.toBeNull()
    expect(nearlyTooClose).not.toBeNull()
    expect(middling!).toBeGreaterThan(nearlyTooClose!)
  })
})

describe('choosing between anchors', () => {
  it('takes the best survivor and ignores the rejected', () => {
    const behind = at(0, 8, -8)
    const sideways = at(6, 7, 4)
    const ahead = at(0, 7, 7)
    expect(bestAnchor(HERE, FORWARD, [behind, sideways, ahead], T)).toBe(ahead)
  })

  it('is null when nothing survives', () => {
    expect(bestAnchor(HERE, FORWARD, [at(0, 8, -8), at(0, 0.1, 5)], T)).toBeNull()
  })

  it('is null with nothing to choose from', () => {
    expect(bestAnchor(HERE, FORWARD, [], T)).toBeNull()
  })
})

describe('the rope force', () => {
  const rope: Rope = { anchor: at(0, 10, 0), restLength: 10 }
  const still = { x: 0, z: 0 }
  const dt = 1 / 30

  /** A rope goes slack. A two-sided spring would shove you away from the anchor as you rose above it. */
  it('does nothing while slack', () => {
    const f = ropeForce(rope, at(0, 4, 0), vec3(), still, dt, T)
    expect(f.dvx).toBe(0)
    expect(f.dvy).toBe(0)
    expect(f.dvz).toBe(0)
  })

  it('pulls toward the anchor once stretched', () => {
    // A metre below the rest length: the pull is straight up, toward the anchor.
    const f = ropeForce(rope, at(0, -1, 0), vec3(), still, dt, T)
    expect(f.dvy).toBeGreaterThan(0)
    expect(f.dvx).toBe(0)
    expect(f.dvz).toBe(0)
  })

  it('pulls harder the further it is stretched', () => {
    const little = ropeForce(rope, at(0, -0.5, 0), vec3(), still, dt, T)
    const lots = ropeForce(rope, at(0, -3, 0), vec3(), still, dt, T)
    expect(lots.dvy).toBeGreaterThan(little.dvy)
  })

  /** Without damping the rope rings like a spring instead of reading as rope. */
  it('absorbs the stretching motion', () => {
    const stretching = ropeForce(rope, at(0, -1, 0), vec3(0, -5, 0), still, dt, T)
    const stationary = ropeForce(rope, at(0, -1, 0), vec3(), still, dt, T)
    // Falling away from the anchor: damping adds to the pull, because it opposes the motion.
    expect(stretching.dvy).toBeGreaterThan(stationary.dvy)

    const rebounding = ropeForce(rope, at(0, -1, 0), vec3(0, 5, 0), still, dt, T)
    // Rising back toward it: damping takes from the pull, which is what stops the bounce.
    expect(rebounding.dvy).toBeLessThan(stationary.dvy)
  })

  it('is unaffected by moving along the rope', () => {
    // Sideways of the anchor, so the rope runs mostly horizontally, and the stick pushes straight at it.
    const sideRope: Rope = { anchor: at(10, 0, 0), restLength: 5 }
    const pushingAtTheAnchor = ropeForce(sideRope, HERE, vec3(), { x: 1, z: 0 }, dt, T)
    const pushingNothing = ropeForce(sideRope, HERE, vec3(), still, dt, T)
    expect(pushingAtTheAnchor.dvx).toBeCloseTo(pushingNothing.dvx, 6)
    expect(pushingAtTheAnchor.dvz).toBeCloseTo(pushingNothing.dvz, 6)
  })

  it('pumps along the arc', () => {
    // Hanging straight down from the anchor; the stick pushes forward, across the rope.
    const f = ropeForce(rope, HERE, vec3(), { x: 0, z: 1 }, dt, T)
    expect(f.dvz).toBeGreaterThan(0)
    // And nothing along the rope, because the radial part is removed.
    expect(f.dvy).toBeCloseTo(0, 6)
  })

  it('pumps backwards to kill a swing', () => {
    const forward = ropeForce(rope, HERE, vec3(), { x: 0, z: 1 }, dt, T)
    const backward = ropeForce(rope, HERE, vec3(), { x: 0, z: -1 }, dt, T)
    expect(backward.dvz).toBeCloseTo(-forward.dvz, 6)
  })

  it('survives standing exactly on the anchor', () => {
    const f = ropeForce({ anchor: HERE, restLength: 5 }, HERE, vec3(), still, dt, T)
    expect(Number.isFinite(f.dvx)).toBe(true)
    expect(Number.isFinite(f.dvy)).toBe(true)
    expect(Number.isFinite(f.dvz)).toBe(true)
  })

  /**
   * The one that matters. An undamped pendulum released from the side should come back up to about the height
   * it was dropped from — if it does not, the rope is either leaking energy or making it, and the swing will
   * feel dead or run away.
   */
  it('conserves height across a full swing, undamped', () => {
    const tuning = { ...T, stiffness: 4000, damping: 0, pump: 0 }
    const anchor = at(0, 10, 0)
    const length = 8
    const pendulum: Rope = { anchor, restLength: length }
    // Released level with the anchor, 8 m to the side. It should reach ~the same height on the far side.
    let p = vec3(-length, 10, 0)
    let v = vec3()
    const dt2 = 1 / 480 // a stiff spring needs small steps; the sim runs a softer one at 1/30
    let highestOnTheFarSide = -Infinity
    for (let i = 0; i < 480 * 6; i += 1) {
      const f = ropeForce(pendulum, p, v, { x: 0, z: 0 }, dt2, tuning)
      v = vec3(v.x + f.dvx, v.y + f.dvy - 9.81 * dt2, v.z + f.dvz)
      p = vec3(p.x + v.x * dt2, p.y + v.y * dt2, p.z + v.z * dt2)
      if (p.x > 0) highestOnTheFarSide = Math.max(highestOnTheFarSide, p.y)
    }
    // Within a metre of the release height over six seconds of swinging.
    expect(highestOnTheFarSide).toBeGreaterThan(9)
    expect(highestOnTheFarSide).toBeLessThan(11)
  })

  /**
   * **Damping does not slow a swing**, and writing the opposite as a test is how that got noticed.
   *
   * The damper is radial — it acts on motion *along* the rope — and a taut pendulum's motion is almost entirely
   * tangential, so there is nearly nothing for it to absorb. That is physically right and it has a consequence
   * worth knowing: a swing in this model does not decay on its own. Energy leaves it when the player pumps
   * backwards, or when `stepCharacter` puts them into a wall. Not before.
   *
   * What damping is for is the bounce: drop onto a rope and the spring wants to ring, and this is what stops it.
   */
  it('settles the bounce along the rope rather than the swing', () => {
    const anchor = at(0, 10, 0)
    const pendulum: Rope = { anchor, restLength: 8 }
    const bounceOf = (damping: number): number => {
      // Dropped straight down the rope line, a metre past taut: all the motion is radial.
      let p = vec3(0, 1, 0)
      let v = vec3(0, -4, 0)
      const dt2 = 1 / 480
      let lowest = Infinity
      for (let i = 0; i < 480 * 3; i += 1) {
        const f = ropeForce(pendulum, p, v, { x: 0, z: 0 }, dt2, { ...T, stiffness: 400, damping, pump: 0 })
        v = vec3(v.x + f.dvx, v.y + f.dvy - 9.81 * dt2, v.z + f.dvz)
        p = vec3(p.x + v.x * dt2, p.y + v.y * dt2, p.z + v.z * dt2)
        lowest = Math.min(lowest, p.y)
      }
      return lowest
    }
    // Damped, it dips less far before the rope catches it.
    expect(bounceOf(20)).toBeGreaterThan(bounceOf(0))
  })
})

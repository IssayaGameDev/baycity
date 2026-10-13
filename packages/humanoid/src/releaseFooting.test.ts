import { TICK_DT, TICK_RATE_HZ } from '@mp/core'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { addCharacter, DEFAULT_TUNING, releaseFooting, stepCharacter, type CharacterTuning, type PlatformPoseLookup } from './groundController'

/**
 * Moving the character from outside the controller has to release its footing (ADR 0100).
 *
 * Kodjo's report: you die, click to respawn, arrive at the spawn — and a moment later you are somewhere in
 * the air. The respawn set the position and left `base` behind, so the controller's bounce-fall guard
 * re-acquired the platform you died on and moved you back to your stored spot on it.
 *
 * Gravity is off in these tests so the only thing that can move the capsule is that drag.
 */

const ZERO = { x: 0, y: 0, z: 0 }
const STILL = { moveX: 0, moveZ: 0, jump: false }
/** No gravity: any vertical movement here is the ride, not a fall. */
const TUNING: CharacterTuning = { ...DEFAULT_TUNING, gravity: 0 }

describe('releaseFooting', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  /**
   * A character standing on a deck the controller treats as rideable, then moved 10 m straight up the way a
   * respawn moves it. Returns its height one tick later.
   */
  const teleportUp = (release: boolean): number => {
    const world = createPhysicsWorld({ gravity: ZERO })
    const deck = world.addFixedBody({ position: ZERO, shape: { kind: 'cuboid', halfExtents: { x: 40, y: 0.5, z: 40 } } })
    // A pose lookup is what makes a collider *rideable*; without one it is static ground and nothing is stored.
    const platforms: PlatformPoseLookup = (h) => (h === deck.colliderHandle ? { position: ZERO, rotation: { x: 0, y: 0, z: 0, w: 1 } } : undefined)
    const c = addCharacter(world, { x: 0, y: 3, z: 0 })

    // Settle onto the deck so the controller records it as the movement base: two thirds of a second.
    for (let i = 0; i < Math.round((2 / 3) * TICK_RATE_HZ); i++) {
      stepCharacter(c, STILL, TICK_DT, DEFAULT_TUNING, platforms)
      world.step(TICK_DT)
    }
    expect(c.grounded, 'standing on the deck').toBe(true)
    expect(c.base, 'and riding it').toBeDefined()

    // What a respawn does: put the body somewhere else.
    c.body.setPosition({ x: 0, y: 13, z: 0 })
    if (release) releaseFooting(c)

    stepCharacter(c, STILL, TICK_DT, TUNING, platforms)
    world.step(TICK_DT)
    const y = c.body.translation().y
    world.free()
    return y
  }

  it('leaves the character where it was put', () => {
    expect(teleportUp(true)).toBeCloseTo(13, 1)
  })

  it('without it, the old footing drags the character back — the reported bug', () => {
    // The guard probes down by exactly how far the stored spot has fallen away, finds the same deck, and
    // hands the controller the displacement back to it. Ten metres of it, in one tick.
    expect(teleportUp(false)).toBeLessThan(6)
  })

  it('clears everything the last footing owned', () => {
    const world = createPhysicsWorld({ gravity: ZERO })
    world.addFixedBody({ position: ZERO, shape: { kind: 'cuboid', halfExtents: { x: 40, y: 0.5, z: 40 } } })
    const c = addCharacter(world, { x: 0, y: 3, z: 0 })
    c.vx = 5
    c.vy = 5
    c.vz = 5
    c.grounded = true
    c.carry = { x: 1, y: 2, z: 3 }
    c.liftVel = { x: 4, y: 5, z: 6 }
    c.liftStore = 0.1
    c.base = { colliderHandle: 7, localPos: { x: 1, y: 1, z: 1 } }

    releaseFooting(c)

    expect([c.vx, c.vy, c.vz]).toEqual([0, 0, 0])
    expect(c.grounded).toBe(false)
    expect(c.base).toBeUndefined()
    expect(c.carry).toEqual(ZERO)
    expect(c.liftVel).toEqual(ZERO)
    expect(c.liftStore).toBe(0)
    world.free()
  })
})

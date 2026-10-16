import { axisAngleToQuat, TICK_DT, vec3, type InputCommand } from '@mp/core'
import { createPhysicsWorld, initPhysics, type PhysicsWorld } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { addCharacter, CHAR_HALF_HEIGHT, CHAR_RADIUS, DEFAULT_TUNING, stepCharacter, type CharacterState } from './groundController'

/**
 * The player feels what a surface is made of (ADR 0229): a slippery floor is slow to get going on and slow to stop
 * on, a slippery slope pulls downhill, a bouncy floor throws a landing back up — and a floor nobody set is exactly
 * what it always was.
 */

const STAND = CHAR_HALF_HEIGHT + CHAR_RADIUS
const STILL: InputCommand = { moveX: 0, moveZ: 0, jump: false }
const FORWARD: InputCommand = { moveX: 1, moveZ: 0, jump: false }
const JUMP: InputCommand = { moveX: 0, moveZ: 0, jump: true }

beforeAll(async () => {
  await initPhysics()
})

const floorWorld = (surface: { friction?: number; restitution?: number } = {}, tiltDeg = 0): PhysicsWorld => {
  const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
  world.addFixedBody({
    position: vec3(0, 0, 0),
    rotation: axisAngleToQuat(vec3(0, 0, 1), (tiltDeg * Math.PI) / 180),
    shape: { kind: 'cuboid', halfExtents: vec3(200, 0.1, 20) },
    ...surface,
  })
  return world
}
const steps = (world: PhysicsWorld, c: CharacterState, input: InputCommand, n: number, each?: () => void): void => {
  for (let i = 0; i < n; i++) {
    stepCharacter(c, input, TICK_DT, DEFAULT_TUNING)
    world.step(TICK_DT)
    each?.()
  }
}
const ticks = (seconds: number): number => Math.round(seconds / TICK_DT)
/** Standing on the floor, settled. */
const standing = (world: PhysicsWorld): CharacterState => {
  const c = addCharacter(world, vec3(0, 0.1 + STAND + 0.02, 0))
  steps(world, c, STILL, ticks(0.5))
  return c
}

describe('grip', () => {
  /** Run for a second, let go, and how far it carries on. */
  const coast = (surface: { friction?: number }): { speedAfter: number; stopping: number } => {
    const world = floorWorld(surface)
    const c = standing(world)
    steps(world, c, FORWARD, 2)
    const speedAfter = Math.hypot(c.vx, c.vz)
    steps(world, c, FORWARD, ticks(1))
    const from = c.body.translation().x
    steps(world, c, STILL, ticks(3))
    const stopping = c.body.translation().x - from
    world.free()
    return { speedAfter, stopping }
  }

  it('on a slippery floor, is slow to get going and slow to stop', () => {
    const plain = coast({})
    const ice = coast({ friction: 0.05 })
    expect(ice.speedAfter, 'two ticks in, slower').toBeLessThan(plain.speedAfter)
    expect(ice.stopping, 'slides on much further').toBeGreaterThan(5 * plain.stopping)
  })

  it('on a frictionless floor, still steers and turns round — slowly — and glides on when let go (ADR 0230)', () => {
    const world = floorWorld({ friction: 0 })
    const c = standing(world)
    // Running one way, as from landing on it.
    c.vx = DEFAULT_TUNING.moveSpeed
    steps(world, c, { moveX: -1, moveZ: 0, jump: false }, ticks(0.05))
    expect(c.vx, 'pushing back slows it').toBeLessThan(DEFAULT_TUNING.moveSpeed)
    expect(c.vx, 'but not at once').toBeGreaterThan(0)
    steps(world, c, { moveX: -1, moveZ: 0, jump: false }, ticks(2))
    expect(c.vx, 'turned round').toBeLessThan(0)
    const going = c.vx
    steps(world, c, STILL, ticks(1))
    expect(c.vx, 'let go: nothing stops it').toBeCloseTo(going, 6)
    world.free()
  })

  it('is today’s on a floor nobody set, and on one set to the default or grippier', () => {
    const plain = coast({})
    expect(coast({ friction: 0.5 })).toEqual(plain)
    expect(coast({ friction: 1.5 }), 'never better than today').toEqual(plain)
  })
})

describe('a slope', () => {
  const drift = (surface: { friction?: number }): number => {
    const world = floorWorld(surface, 20)
    const c = addCharacter(world, vec3(0, 0.1 + STAND + 0.05, 0))
    steps(world, c, STILL, ticks(0.5))
    const from = c.body.translation()
    steps(world, c, STILL, ticks(2))
    const to = c.body.translation()
    world.free()
    return Math.hypot(to.x - from.x, to.z - from.z)
  }

  it('holds a player still on a floor nobody set, and slides one down when it is slippery', () => {
    // Today's settle on a 20° slab, untouched: a few millimetres as the capsule seats.
    expect(drift({}), 'as today').toBeLessThan(1e-2)
    expect(drift({ friction: 0 }), 'no grip at all: downhill').toBeGreaterThan(1)
  })
})

describe('bounciness', () => {
  /** Dropped from 3 m: the highest the feet get after the first landing. */
  const reboundOn = (restitution: number | undefined, jumpOnLanding = false): number => {
    const world = floorWorld(restitution === undefined ? {} : { restitution })
    const c = addCharacter(world, vec3(0, 3 + 0.1 + STAND, 0))
    let landed = false
    let highest = -Infinity
    for (let i = 0; i < ticks(3); i++) {
      // Pressed just before the feet come down, as a player times it: the jump buffer holds it to the landing.
      const near = c.body.translation().y - STAND - 0.1 < 0.3 && c.vy < 0 && !landed
      stepCharacter(c, jumpOnLanding && near ? JUMP : STILL, TICK_DT, DEFAULT_TUNING)
      world.step(TICK_DT)
      if (c.grounded) landed = true
      else if (landed) highest = Math.max(highest, c.body.translation().y - STAND - 0.1)
    }
    world.free()
    return highest
  }

  it('throws a landing back up its share of the fall, and not at all on a floor nobody set', () => {
    expect(reboundOn(undefined), 'no bounce').toBe(-Infinity)
    const bounce = reboundOn(0.8)
    // A ball: 0.8 bounciness rises to 0.64 of the drop, 1.92 m of 3.
    expect(bounce).toBeGreaterThan(1.92 - 0.15)
    expect(bounce).toBeLessThan(1.92 + 0.15)
    expect(reboundOn(0.4), 'less bouncy, lower').toBeLessThan(bounce)
  })

  it('bounces every landing, from any height — a fast fall lands on a floor its tick’s first probe could not reach yet', () => {
    // Kodjo's report: a bounce or two, then a landing that stopped dead. From 4.59 m the first one did.
    const dead: string[] = []
    for (let k = 0; k < 40; k++) {
      const h = 2 + k * 0.37
      const world = floorWorld({ restitution: 0.8 })
      const c = addCharacter(world, vec3(0, h + 0.1 + STAND, 0))
      for (let i = 0; i < ticks(6); i++) {
        const was = c.grounded
        const falling = -c.vy
        stepCharacter(c, STILL, TICK_DT, DEFAULT_TUNING)
        world.step(TICK_DT)
        if (!was && c.grounded && c.bounce === 0 && falling * 0.8 > 3) dead.push(`${h.toFixed(2)} m, tick ${i}, ${falling.toFixed(1)} m/s`)
      }
      world.free()
    }
    expect(dead).toEqual([])
  })

  it('adds to a jump taken as it lands', () => {
    expect(reboundOn(0.8, true)).toBeGreaterThan(reboundOn(0.8) + 0.5)
  })
})

describe('the ground probe', () => {
  it('says what the floor is made of', () => {
    const world = floorWorld({ friction: 0.2, restitution: 0.6 })
    const c = standing(world)
    const ground = c.body.probeGround()
    expect(ground?.friction).toBeCloseTo(0.2, 6)
    expect(ground?.restitution).toBeCloseTo(0.6, 6)
    world.free()
  })
})

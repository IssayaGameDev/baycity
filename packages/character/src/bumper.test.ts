import { quat, vec3, type Quat, type Vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics, type PhysicsBody, type PhysicsWorld } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  addCharacter,
  CHAR_HALF_HEIGHT,
  CHAR_RADIUS,
  DEFAULT_TUNING,
  stepCharacter,
  TICK_DT,
  type CharacterState,
  type PlatformFrame,
  type PlatformPoseLookup,
} from './character'

/**
 * The launch path: `CharacterState.launch`, which is how a bumper throws the player (ADR 0032).
 *
 * Measured, not asserted against the implementation. A launch is not "set `vy`": leaving a surface is five
 * decisions in `stepCharacter` (the ride stops owning the vertical, gravity applies again, footing is released,
 * the movement base is dropped, a mover's velocity is inherited) and a jump already threads all five. These
 * tests exist because getting any one of them wrong looks fine on flat ground and fails on a moving platform,
 * which is exactly where somebody would mount a trampoline.
 */
const STAND = CHAR_HALF_HEIGHT + CHAR_RADIUS
const STILL = { moveX: 0, moveZ: 0, jump: false }
const GRAVITY = DEFAULT_TUNING.gravity
/** What a jump leaves the ground at. The reference every launch is worth comparing against. */
const JUMP_SPEED = Math.sqrt(2 * GRAVITY * DEFAULT_TUNING.jumpHeight)
/** A trampoline that throws about twice a jump — the documented default for `power`. */
const TRAMPOLINE = 26

/** Apex above the launch point for an upward speed, from `v² / 2g`. */
const apexOf = (power: number): number => (power * power) / (2 * GRAVITY)

/** World gravity is zero because the character is controller-driven: `stepCharacter` integrates its own. */
const makeWorld = (): PhysicsWorld => createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })

const addFloor = (world: PhysicsWorld): PhysicsBody =>
  world.addFixedBody({ position: vec3(0, 0, 0), shape: { kind: 'cuboid', halfExtents: vec3(60, 0.2, 60) } })

/**
 * One tick: ask, then resolve. `body.move()` only sets the controller's target, so nothing has moved until
 * `world.step` runs. Same order the mode and the loader use.
 */
const tick = (world: PhysicsWorld, c: CharacterState, cmd = STILL, platforms?: PlatformPoseLookup): void => {
  stepCharacter(c, cmd, TICK_DT, DEFAULT_TUNING, platforms)
  world.step(TICK_DT)
}

/** The highest point reached, stepping until the character starts coming down. */
const peakOf = (c: CharacterState, step: () => void, ticks = 400): number => {
  let peak = c.body.translation().y
  let last = peak
  for (let n = 0; n < ticks; n++) {
    step()
    const y = c.body.translation().y
    peak = Math.max(peak, y)
    if (y < last) break
    last = y
  }
  return peak
}

interface Platform {
  body: PhysicsBody
  pose: (p: Vec3, r: Quat) => void
  frame: () => PlatformFrame
}

/** A kinematic platform posed the way the loader poses one: outright, with zero derived velocity. */
const addPlatform = (world: PhysicsWorld, at: Vec3): Platform => {
  const body = world.addKinematicBody({ position: at, shape: { kind: 'cuboid', halfExtents: vec3(2, 0.2, 2) } })
  return {
    body,
    pose: (p, r) => {
      body.setPosition(p)
      body.setRotation(r)
      body.setNextKinematicTranslation(p)
      body.setNextKinematicRotation(r)
    },
    frame: () => ({ position: body.translation(), rotation: body.rotation() }),
  }
}

describe('launch', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('does nothing until something sets it', () => {
    const world = makeWorld()
    addFloor(world)
    const c = addCharacter(world, vec3(0, 0.2 + STAND + 0.02, 0))
    for (let n = 0; n < 30; n++) tick(world, c)
    expect(c.launch).toBe(0)
    expect(c.body.translation().y).toBeLessThan(0.2 + STAND + 0.1)
    world.free()
  })

  it('throws to the height its power implies', () => {
    const world = makeWorld()
    addFloor(world)
    const c = addCharacter(world, vec3(0, 0.2 + STAND + 0.02, 0))
    for (let n = 0; n < 10; n++) tick(world, c) // settle

    const base = c.body.translation().y
    c.launch = TRAMPOLINE
    const gained = peakOf(c, () => tick(world, c)) - base

    // One tick of gravity comes off the launch before it integrates, exactly as it always has for a jump, so
    // the apex lands a little under the ideal. Bounded rather than exact: the point is that the height follows
    // the power, not that Rapier's resolution matches a closed form.
    expect(gained).toBeGreaterThan(apexOf(TRAMPOLINE) * 0.8)
    expect(gained).toBeLessThan(apexOf(TRAMPOLINE) * 1.1)
    world.free()
  })

  it('throws higher for more power, and a trampoline beats a jump', () => {
    const heights = new Map<number, number>()
    // A world each: one `world.step` advances every body in it, so sharing would let one launch's flight
    // advance the next character's before it was measured.
    for (const power of [12, TRAMPOLINE, 36]) {
      const world = makeWorld()
      addFloor(world)
      const c = addCharacter(world, vec3(0, 0.2 + STAND + 0.02, 0))
      for (let n = 0; n < 10; n++) tick(world, c)
      const base = c.body.translation().y
      c.launch = power
      heights.set(power, peakOf(c, () => tick(world, c)) - base)
      world.free()
    }
    expect(heights.get(12)!).toBeLessThan(heights.get(TRAMPOLINE)!)
    expect(heights.get(TRAMPOLINE)!).toBeLessThan(heights.get(36)!)

    // The number that matters for authoring: a jump leaves at ~18.2 m/s, so a power below that throws you
    // *lower* than your own jump. 26 is about double, which is what the schema documents.
    expect(heights.get(TRAMPOLINE)!, 'a trampoline throws higher than a jump').toBeGreaterThan(DEFAULT_TUNING.jumpHeight)
    expect(heights.get(12)!, 'and a weak one is a soft catch, below jump height').toBeLessThan(DEFAULT_TUNING.jumpHeight)
    expect(TRAMPOLINE).toBeGreaterThan(JUMP_SPEED)
  })

  it('is consumed, so one contact is one bounce', () => {
    const world = makeWorld()
    addFloor(world)
    const c = addCharacter(world, vec3(0, 0.2 + STAND + 0.02, 0))
    for (let n = 0; n < 10; n++) tick(world, c)

    c.launch = TRAMPOLINE
    tick(world, c)
    expect(c.launch, 'cleared by the step that used it').toBe(0)

    // Left alone it comes back down, rather than hanging at the apex or climbing forever.
    const peak = peakOf(c, () => tick(world, c))
    for (let n = 0; n < 200; n++) tick(world, c)
    expect(c.body.translation().y).toBeLessThan(peak)
    world.free()
  })

  /**
   * The case the whole design exists for. Standing on a mover, `riding` owns the vertical and zeroes `vy` every
   * tick — so a launch written onto `vy` from outside the step would be erased before it integrated, and a
   * trampoline on an elevator simply would not work.
   */
  it('escapes a moving platform it is riding', () => {
    const world = makeWorld()
    const plat = addPlatform(world, vec3(0, 2, 0))
    const lookup = (h: number): PlatformFrame | undefined => (h === plat.body.colliderHandle ? plat.frame() : undefined)
    const c = addCharacter(world, vec3(0, 2.2 + STAND + 0.02, 0))

    let y = 2
    const rise = (): void => {
      y += 2 * TICK_DT
      plat.pose(vec3(0, y, 0), quat())
      tick(world, c, STILL, lookup)
    }
    for (let n = 0; n < 20; n++) rise()
    expect(c.base, 'riding the platform').toBeDefined()

    const before = c.body.translation().y
    const platBefore = y
    c.launch = TRAMPOLINE
    // The peak of the bounce, not the pose after a fixed count: at 26 m/s the apex arrives in about half a
    // second, so a fixed window would measure the way back down.
    const peak = peakOf(c, rise)

    expect(peak - before, 'it left the platform instead of being pinned to it').toBeGreaterThan((y - platBefore) * 2)
    expect(peak - before, 'and it climbed roughly what the power implies').toBeGreaterThan(apexOf(TRAMPOLINE) * 0.7)
    expect(c.base, 'the movement base was released').toBeUndefined()
    world.free()
  })

  it("inherits a mover's velocity, as a jump does", () => {
    const world = makeWorld()
    const plat = addPlatform(world, vec3(0, 2, 0))
    const lookup = (h: number): PlatformFrame | undefined => (h === plat.body.colliderHandle ? plat.frame() : undefined)
    const c = addCharacter(world, vec3(0, 2.2 + STAND + 0.02, 0))

    let x = 0
    const slide = (): void => {
      x += 4 * TICK_DT
      plat.pose(vec3(x, 2, 0), quat())
      tick(world, c, STILL, lookup)
    }
    for (let n = 0; n < 20; n++) slide()
    expect(c.base).toBeDefined()

    // The launch has to land on a tick the platform actually advances. `ride` is the *catch-up offset* for this
    // tick, so it is only non-zero when the surface has moved since the last resolve — which is what the
    // inherited velocity is derived from. A launch on a tick where the platform stood still inherits nothing,
    // and that is correct: a mover always moves every tick.
    c.launch = TRAMPOLINE
    slide()
    expect(c.vx, "carried the platform's speed off the launch").toBeGreaterThan(3)
    expect(c.vx, 'and no more than the platform was doing').toBeLessThan(5)
    world.free()
  })

  it('works without footing, so a bumper can catch someone mid-air', () => {
    const world = makeWorld()
    addFloor(world)
    const c = addCharacter(world, vec3(0, 12, 0))
    for (let n = 0; n < 5; n++) tick(world, c) // falling
    expect(c.grounded).toBe(false)
    expect(c.vy).toBeLessThan(0)

    c.launch = TRAMPOLINE
    tick(world, c)
    expect(c.vy, 'the fall is replaced, not added to').toBeGreaterThan(0)
    world.free()
  })

  it('outranks a jump landing on the same tick', () => {
    const world = makeWorld()
    addFloor(world)
    const c = addCharacter(world, vec3(0, 0.2 + STAND + 0.02, 0))
    for (let n = 0; n < 10; n++) tick(world, c)
    expect(c.grounded).toBe(true)

    c.launch = TRAMPOLINE
    tick(world, c, { moveX: 0, moveZ: 0, jump: true })
    expect(c.vy, 'the bumper wins, rather than the two adding or the jump masking it').toBeGreaterThan(JUMP_SPEED)
    world.free()
  })
})

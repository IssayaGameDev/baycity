import { createPhysicsWorld, initPhysics, type PhysicsWorld } from '@mp/physics'
import type { InputCommand } from '@mp/net'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  addCharacter,
  CHAR_HALF_HEIGHT,
  CHAR_RADIUS,
  DEFAULT_TUNING,
  playerSpawn,
  stepCharacter,
  TICK_DT,
  type CharacterState,
  type CharacterTuning,
  type PlatformPoseLookup,
} from './character'

const cmd = (moveX: number, moveZ: number, jump = false): InputCommand => ({ moveX, moveZ, jump })

// A minimal world with a big ground to stand/jump on (world content is now data;
// tests build just what they need).
const makeWorld = (): PhysicsWorld => {
  const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
  world.addFixedBody({ position: { x: 0, y: 0, z: 0 }, shape: { kind: 'cuboid', halfExtents: { x: 25, y: 0.1, z: 25 } } })
  return world
}

const runToPos = (inputs: InputCommand[]): { x: number; y: number; z: number } => {
  const world = makeWorld()
  const c = addCharacter(world, playerSpawn(1000))
  for (const i of inputs) {
    stepCharacter(c, i, TICK_DT)
    world.step(TICK_DT)
  }
  const p = c.body.translation()
  world.free()
  return p
}

describe('character controller', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('is deterministic', () => {
    const inputs = Array.from({ length: 90 }, (_, i) => cmd(1, 0, i === 40))
    expect(runToPos(inputs)).toEqual(runToPos(inputs))
  })

  it('moves in the commanded world direction', () => {
    const still = runToPos(Array.from({ length: 60 }, () => cmd(0, 0)))
    const moved = runToPos(Array.from({ length: 60 }, () => cmd(1, 0)))
    expect(moved.x).toBeGreaterThan(still.x + 1)
  })

  it('jump apex â‰ˆ the configured jump height (vâ‚€ = âˆš(2gh))', () => {
    const world = makeWorld()
    const c = addCharacter(world, playerSpawn(1000))
    for (let i = 0; i < 60; i++) {
      stepCharacter(c, cmd(0, 0), TICK_DT)
      world.step(TICK_DT)
    }
    const restY = c.body.translation().y
    stepCharacter(c, cmd(0, 0, true), TICK_DT)
    world.step(TICK_DT)
    let peak = c.body.translation().y
    for (let i = 0; i < 80; i++) {
      stepCharacter(c, cmd(0, 0), TICK_DT)
      world.step(TICK_DT)
      peak = Math.max(peak, c.body.translation().y)
    }
    const apex = peak - restY
    expect(apex).toBeGreaterThan(DEFAULT_TUNING.jumpHeight * 0.8)
    expect(apex).toBeLessThan(DEFAULT_TUNING.jumpHeight * 1.3)
    world.free()
  })

  it('brakes to a stop on the ground after input is released', () => {
    const world = makeWorld()
    const c = addCharacter(world, playerSpawn(1000))
    for (let i = 0; i < 40; i++) {
      stepCharacter(c, cmd(1, 0), TICK_DT)
      world.step(TICK_DT)
    }
    for (let i = 0; i < 20; i++) {
      stepCharacter(c, cmd(0, 0), TICK_DT)
      world.step(TICK_DT)
    }
    expect(Math.abs(c.vx)).toBeLessThan(0.05)
    world.free()
  })

  // Platform carry has its own suite (`platformCarry.test.ts`) — riding, elevators, turntables,
  // jump momentum, and leaving a platform. Kept out of here so this file stays about locomotion.

  it('gains nothing from a jump off static ground', () => {
    const world = makeWorld()
    const c = addCharacter(world, playerSpawn(1000))
    const noPlatforms: PlatformPoseLookup = () => undefined // static geometry has no pose to ride
    for (let i = 0; i < 30; i++) {
      stepCharacter(c, cmd(0, 0), TICK_DT, DEFAULT_TUNING, noPlatforms)
      world.step(TICK_DT)
    }
    stepCharacter(c, cmd(0, 0, true), TICK_DT, DEFAULT_TUNING, noPlatforms)
    world.step(TICK_DT)
    expect(c.vx).toBe(0)
    expect(c.vz).toBe(0)
    world.free()
  })

  it('preserves horizontal momentum through a jump with no air input', () => {
    const world = makeWorld()
    const c = addCharacter(world, playerSpawn(1000))
    for (let i = 0; i < 40; i++) {
      stepCharacter(c, cmd(1, 0), TICK_DT)
      world.step(TICK_DT)
    }
    stepCharacter(c, cmd(1, 0, true), TICK_DT)
    world.step(TICK_DT)
    const xStart = c.body.translation().x
    for (let i = 0; i < 10; i++) {
      stepCharacter(c, cmd(0, 0), TICK_DT)
      world.step(TICK_DT)
    }
    expect(c.body.translation().x).toBeGreaterThan(xStart + 0.5)
    world.free()
  })

  // The roof's underside. A resting capsule's head is near y = 2.1, so this leaves about a metre of
  // headroom inside a 3 m jump — the jump is certain to reach it and certain not to clear it.
  const ROOF_UNDERSIDE = 3.2

  it('a ceiling ends the rise instead of holding it under the roof', () => {
    const world = makeWorld()
    world.addFixedBody({
      position: { x: 0, y: ROOF_UNDERSIDE + 0.1, z: 0 },
      shape: { kind: 'cuboid', halfExtents: { x: 25, y: 0.1, z: 25 } },
    })
    const c = addCharacter(world, playerSpawn(1000))
    for (let i = 0; i < 40; i++) {
      stepCharacter(c, cmd(0, 0), TICK_DT)
      world.step(TICK_DT)
    }
    stepCharacter(c, cmd(0, 0, true), TICK_DT)
    world.step(TICK_DT)
    let risingTicks = 1
    let peak = c.body.translation().y
    for (let i = 0; i < 40 && c.vy > 0; i++) {
      stepCharacter(c, cmd(0, 0), TICK_DT)
      world.step(TICK_DT)
      peak = Math.max(peak, c.body.translation().y)
      risingTicks++
    }
    // Gravity alone takes √(2gh)/g ≈ 0.33 s — 10 ticks — to turn a jump over. The roof is hit on the
    // second tick, so anything close to 10 means `vy` was left positive with nowhere to go.
    expect(risingTicks, 'rise ends on contact, not when gravity gets around to it').toBeLessThan(5)
    // And it stopped where the roof is, rather than sinking into it.
    expect(peak + CHAR_HALF_HEIGHT + CHAR_RADIUS).toBeLessThan(ROOF_UNDERSIDE + 0.05)
    world.free()
  })

  // An empty world: no floor, so nothing but the cap bounds the fall.
  const fallForever = (ticks: number, tuning = DEFAULT_TUNING): { vy: number; worstDrop: number } => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const c = addCharacter(world, { x: 0, y: 0, z: 0 })
    let worstDrop = 0
    let prevY = c.body.translation().y
    for (let i = 0; i < ticks; i++) {
      stepCharacter(c, cmd(0, 0), TICK_DT, tuning)
      world.step(TICK_DT)
      const y = c.body.translation().y
      worstDrop = Math.max(worstDrop, prevY - y)
      prevY = y
    }
    const vy = c.vy
    world.free()
    return { vy, worstDrop }
  }

  it('caps fall speed, so a long drop cannot outrun the swept resolve', () => {
    // Uncapped, 120 ticks of 55 m/s² reaches −220 m/s and a 7 m step — past any slab thickness.
    const { vy, worstDrop } = fallForever(120)
    expect(vy).toBeCloseTo(-DEFAULT_TUNING.maxFallSpeed, 6)
    expect(worstDrop).toBeLessThan(DEFAULT_TUNING.maxFallSpeed * TICK_DT + 1e-6)
  })

  it('takes the fall cap from tuning', () => {
    expect(fallForever(60, { ...DEFAULT_TUNING, maxFallSpeed: 8 }).vy).toBeCloseTo(-8, 6)
  })

  // A 4 m deck with nothing beyond its edge, and a character that walks off it. Returns a world plus a
  // `tick`, and leaves the character on the first tick where footing is gone — the instant the coyote
  // window opens.
  const walkOffALedge = (
    tuning: CharacterTuning,
  ): { world: PhysicsWorld; c: ReturnType<typeof addCharacter>; tick: (i: InputCommand) => void } => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    world.addFixedBody({ position: { x: 0, y: 0, z: 0 }, shape: { kind: 'cuboid', halfExtents: { x: 2, y: 0.1, z: 2 } } })
    const c = addCharacter(world, { x: -1.5, y: 1.2, z: 0 })
    const tick = (i: InputCommand): void => {
      stepCharacter(c, i, TICK_DT, tuning)
      world.step(TICK_DT)
    }
    for (let i = 0; i < 20; i++) tick(cmd(0, 0)) // settle on the deck
    let guard = 0
    while (c.grounded && guard++ < 200) tick(cmd(1, 0)) // walk +x until the ground runs out
    expect(c.grounded, 'the character actually left the deck').toBe(false)
    return { world, c, tick }
  }

  // Coast `delayTicks` past the edge, then press jump. Did it fire?
  const jumpAfterLedge = (delayTicks: number, tuning: CharacterTuning = DEFAULT_TUNING): boolean => {
    const { world, c, tick } = walkOffALedge(tuning)
    for (let i = 0; i < delayTicks; i++) tick(cmd(1, 0))
    const before = c.vy
    tick(cmd(1, 0, true))
    const fired = c.vy > before + 1
    world.free()
    return fired
  }

  it('coyote time: a jump just past the ledge still fires', () => {
    expect(jumpAfterLedge(1)).toBe(true)
  })

  it('coyote time: a jump long past the ledge does not', () => {
    // 5 ticks is 167 ms, past the 100 ms window.
    expect(jumpAfterLedge(5)).toBe(false)
  })

  it('coyote time: off at 0, which is the behaviour it replaced', () => {
    expect(jumpAfterLedge(1, { ...DEFAULT_TUNING, coyoteTime: 0 })).toBe(false)
  })

  const JUMP_SPEED = Math.sqrt(2 * DEFAULT_TUNING.gravity * DEFAULT_TUNING.jumpHeight)

  /**
   * Jumps over `ticks` of a held button. A jump is the only thing that can leave `vy` above where
   * gravity alone would have put it — which is how it has to be measured, *not* as a rise in `vy`: a
   * jump re-firing every tick pins `vy` to a constant, and "did `vy` go up?" reads that as no jumps at
   * all. The speed floor keeps the grounded `vy < 0 → 0` clamp from counting as one.
   */
  const countHeldJumps = (ticks: number, c: CharacterState, tick: (i: InputCommand) => void, moveX = 0): number => {
    let jumps = 0
    for (let i = 0; i < ticks; i++) {
      const gravityAlone = c.vy - DEFAULT_TUNING.gravity * TICK_DT
      tick(cmd(moveX, 0, true))
      if (c.vy > gravityAlone + 0.5 && c.vy > JUMP_SPEED / 2) jumps++
    }
    return jumps
  }

  // The window is full when the jump starts here, where the ledge test's is already part-decayed — so
  // this is the case that catches a grace that was not spent on the way out. Both are needed.
  it('coyote time: a held button does not turn a ground jump into two', () => {
    const world = makeWorld()
    const c = addCharacter(world, playerSpawn(1000))
    const tick = (i: InputCommand): void => {
      stepCharacter(c, i, TICK_DT)
      world.step(TICK_DT)
    }
    for (let i = 0; i < 30; i++) tick(cmd(0, 0))
    // 12 ticks is 0.4 s, well inside the 0.66 s hang, so nothing here has landed to earn a second jump.
    expect(countHeldJumps(12, c, tick)).toBe(1)
    world.free()
  })

  it('coyote time: one ledge gives one jump, however long the button is held', () => {
    const { world, c, tick } = walkOffALedge(DEFAULT_TUNING)
    expect(countHeldJumps(12, c, tick, 1)).toBe(1)
    world.free()
  })
})

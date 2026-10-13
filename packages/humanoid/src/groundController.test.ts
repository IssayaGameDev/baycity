import { TICK_DT, TICK_RATE_HZ } from '@mp/core'
﻿import { createPhysicsWorld, initPhysics, type PhysicsWorld } from '@mp/physics'
import type { InputCommand } from '@mp/core'
import { beforeAll, describe, expect, it } from 'vitest'

import { ACCEL_REF_SPEED, addCharacter, CHAR_HALF_HEIGHT, CHAR_RADIUS, DEFAULT_TUNING, INTEGRATION_HZ, playerSpawn, stepCharacter, type CharacterState, type CharacterTuning, type PlatformPoseLookup } from './groundController'

const cmd = (moveX: number, moveZ: number, jump = false): InputCommand => ({ moveX, moveZ, jump })

/**
 * `n` ticks of the 30 Hz these tests were written at, as ticks at the rate the game runs now — the same span of time.
 * Movement is integrated per 1/240 s slice (ADR 0215), so a span of time is what a test means, not a count of steps.
 */
const T30 = (n: number): number => Math.round((n / 30) * TICK_RATE_HZ)

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

  /**
   * DEFAULT_TUNING with the three arc knobs at their inert values. The shipped defaults shape the arc
   * (fall bias, apex float, release-cut — ADR 0041), which is right for the game and wrong for a test
   * that wants to pin the plain parabola: the integration guarantee is "apex == jumpHeight", and apex
   * float deliberately coasts past it. Tests about shaping compare this against a shaped tuning.
   */
  const NEUTRAL_ARC: CharacterTuning = {
    ...DEFAULT_TUNING,
    fallGravityScale: 1,
    apexGravityScale: 1,
    jumpCutScale: 1,
  }

  it('is deterministic', () => {
    const inputs = Array.from({ length: 90 }, (_, i) => cmd(1, 0, i === 40))
    expect(runToPos(inputs)).toEqual(runToPos(inputs))
  })

  it('moves in the commanded world direction', () => {
    const still = runToPos(Array.from({ length: 60 }, () => cmd(0, 0)))
    const moved = runToPos(Array.from({ length: 60 }, () => cmd(1, 0)))
    expect(moved.x).toBeGreaterThan(still.x + 1)
  })

  it('jump apex = the configured jump height (vâ‚€ = âˆš(2gh))', () => {
    const world = makeWorld()
    const c = addCharacter(world, playerSpawn(1000))
    for (let i = 0; i < 60; i++) {
      stepCharacter(c, cmd(0, 0), TICK_DT, NEUTRAL_ARC)
      world.step(TICK_DT)
    }
    const restY = c.body.translation().y
    stepCharacter(c, cmd(0, 0, true), TICK_DT, NEUTRAL_ARC)
    world.step(TICK_DT)
    let peak = c.body.translation().y
    for (let i = 0; i < 80; i++) {
      // Held: with `jumpCutScale` live in the shipped tuning a released button is a deliberate short hop.
      stepCharacter(c, cmd(0, 0, c.vy > 0), TICK_DT, NEUTRAL_ARC)
      world.step(TICK_DT)
      peak = Math.max(peak, c.body.translation().y)
    }
    const apex = peak - restY
    // Within 1%. It used to need a 0.8x-1.3x band because `y += v*dt` undershot by half a tick of
    // take-off speed (10% here); the vertical step is the exact trapezoid now, so the apex *is* the
    // configured number and a loose band would hide the next integration bug.
    expect(apex).toBeGreaterThan(DEFAULT_TUNING.jumpHeight * 0.99)
    expect(apex).toBeLessThan(DEFAULT_TUNING.jumpHeight * 1.01)
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
      stepCharacter(c, cmd(0, 0), TICK_DT, NEUTRAL_ARC)
      world.step(TICK_DT)
    }
    stepCharacter(c, cmd(0, 0, true), TICK_DT, NEUTRAL_ARC)
    world.step(TICK_DT)
    let risingTicks = 1
    let peak = c.body.translation().y
    for (let i = 0; i < 40 && c.vy > 0; i++) {
      // Held and unshaped: a cut jump would never reach the roof, and apex float would slow the approach.
      stepCharacter(c, cmd(0, 0, true), TICK_DT, NEUTRAL_ARC)
      world.step(TICK_DT)
      peak = Math.max(peak, c.body.translation().y)
      risingTicks++
    }
    // Gravity alone takes √(2gh)/g ≈ 0.33 s — 10 ticks — to turn a jump over. The roof is hit on the
    // second tick, so anything close to 10 means `vy` was left positive with nowhere to go.
    expect(risingTicks, 'rise ends on contact, not when gravity gets around to it').toBeLessThan(T30(5))
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
    // To the f32 the physics keeps positions in: the drop is summed from the tick's slices (ADR 0215).
    expect(worstDrop).toBeLessThan(DEFAULT_TUNING.maxFallSpeed * TICK_DT + 1e-5)
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
    for (let i = 0; i < T30(20); i++) tick(cmd(0, 0)) // settle on the deck
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
    // 167 ms, past the 100 ms window.
    expect(jumpAfterLedge(T30(5))).toBe(false)
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
    for (let i = 0; i < T30(30); i++) tick(cmd(0, 0))
    // 0.4 s, well inside the 0.66 s hang, so nothing here has landed to earn a second jump.
    expect(countHeldJumps(T30(12), c, tick)).toBe(1)
    world.free()
  })

  it('coyote time: one ledge gives one jump, however long the button is held', () => {
    const { world, c, tick } = walkOffALedge(DEFAULT_TUNING)
    expect(countHeldJumps(T30(12), c, tick, 1)).toBe(1)
    world.free()
  })

  // --- jump buffer -----------------------------------------------------------------------------
  const TAKE_OFF = Math.sqrt(2 * DEFAULT_TUNING.gravity * DEFAULT_TUNING.jumpHeight)

  /**
   * Jump from flat ground, then press the button for exactly one tick, `ticksEarly` ticks before the
   * tick that lands. Did that press survive to fire a jump once footing arrived? A single-tick press is
   * the case that matters: it is what a real tap is, and what the old level-read threw away.
   */
  const pressedBeforeLanding = (ticksEarly: number, tuning: CharacterTuning = DEFAULT_TUNING): boolean => {
    const run = (pressAt: number): { landAt: number; jumped: boolean } => {
      const world = makeWorld()
      const c = addCharacter(world, playerSpawn(1000))
      const tick = (i: InputCommand): void => {
        stepCharacter(c, i, TICK_DT, tuning)
        world.step(TICK_DT)
      }
      for (let i = 0; i < T30(40); i++) tick(cmd(0, 0))
      tick(cmd(0, 0, true)) // take off
      let landAt = -1
      let jumped = false
      for (let n = 1; n <= T30(40); n++) {
        tick(cmd(0, 0, n === pressAt))
        if (landAt < 0 && c.grounded) landAt = n
        if (landAt > 0 && c.vy > TAKE_OFF * 0.5) jumped = true
      }
      world.free()
      return { landAt, jumped }
    }
    return run(run(-1).landAt - ticksEarly).jumped
  }

  it('jump buffer: a tap just before landing fires on landing', () => {
    expect(pressedBeforeLanding(1)).toBe(true)
  })

  it('jump buffer: a tap long before landing is not still queued', () => {
    // 167 ms, past the 100 ms window — otherwise the buffer would be a landing trap.
    expect(pressedBeforeLanding(T30(5))).toBe(false)
  })

  it('jump buffer: off at 0, which is the behaviour it replaced', () => {
    expect(pressedBeforeLanding(1, { ...DEFAULT_TUNING, jumpBufferTime: 0 })).toBe(false)
  })

  // --- arc shaping -----------------------------------------------------------------------------
  /** Apex, rise ticks and fall ticks for one jump under `tuning`, holding the button for `hold` ticks. */
  const arcOf = (tuning: CharacterTuning, hold = 40): { apex: number; rise: number; fall: number; impact: number } => {
    const world = makeWorld()
    const c = addCharacter(world, playerSpawn(1000))
    const tick = (i: InputCommand): void => {
      stepCharacter(c, i, TICK_DT, tuning)
      world.step(TICK_DT)
    }
    for (let i = 0; i < 40; i++) tick(cmd(0, 0))
    const restY = c.body.translation().y
    let peak = restY
    let rise = 0
    let fall = 0
    let n = 0
    tick(cmd(0, 0, true))
    rise = 1
    while (c.vy > 0 && n < 60) {
      tick(cmd(0, 0, n + 1 < hold))
      peak = Math.max(peak, c.body.translation().y)
      rise++
      n++
    }
    let impact = 0
    while (!c.grounded && fall < 60) {
      tick(cmd(0, 0, false))
      impact = Math.max(impact, -c.vy)
      fall++
    }
    world.free()
    return { apex: peak - restY, rise, fall, impact }
  }

  it('fall gravity: a heavier fall shortens the drop without lowering the apex', () => {
    const plain = arcOf(NEUTRAL_ARC)
    const heavy = arcOf({ ...NEUTRAL_ARC, fallGravityScale: 2 })
    // Same climb — the scale only applies once `vy` is negative.
    expect(heavy.apex).toBeCloseTo(plain.apex, 2)
    expect(heavy.rise).toBe(plain.rise)
    // ...and the drop is quicker and lands harder. Asserted on the impact speed rather than on a tick
    // count: the fall is only ~9 ticks long, and a 30 Hz grid cannot resolve a factor of sqrt(2) in
    // that. Speed is exact — 2x gravity over the same height is sqrt(2) faster at the bottom.
    expect(heavy.fall).toBeLessThan(plain.fall)
    expect(heavy.impact).toBeGreaterThan(plain.impact * 1.3)
  })

  it('apex gravity: a lighter top buys hang time', () => {
    const plain = arcOf(NEUTRAL_ARC)
    const floaty = arcOf({ ...NEUTRAL_ARC, apexGravityScale: 0.5 })
    expect(floaty.rise + floaty.fall).toBeGreaterThan(plain.rise + plain.fall)
    // Less gravity near the top also means it coasts a little higher.
    expect(floaty.apex).toBeGreaterThan(plain.apex)
  })

  it('apex gravity: inert at 1 however wide the window', () => {
    const plain = arcOf(NEUTRAL_ARC)
    const wide = arcOf({ ...NEUTRAL_ARC, apexSpeed: 99 })
    expect(wide.apex).toBeCloseTo(plain.apex, 6)
    expect(wide.rise + wide.fall).toBe(plain.rise + plain.fall)
  })

  it('release cut: letting go mid-rise gives a lower jump, holding gives the full one', () => {
    const cut = { ...NEUTRAL_ARC, jumpCutScale: 0.3 }
    const tapped = arcOf(cut, 1) // one tick of button, released on the next
    const held = arcOf(cut, 40)
    expect(held.apex).toBeCloseTo(arcOf(NEUTRAL_ARC).apex, 2)
    expect(tapped.apex).toBeLessThan(held.apex * 0.5)
    // Still a real jump, not a cancelled one.
    expect(tapped.apex).toBeGreaterThan(0.1)
  })

  it('release cut: inert at 1, so a tap and a hold reach the same apex', () => {
    expect(arcOf(NEUTRAL_ARC, 1).apex).toBeCloseTo(arcOf(NEUTRAL_ARC, 40).apex, 6)
  })


  // --- air control above moveSpeed --------------------------------------------------------------
  /**
   * Take off, then overwrite `vx` as a mover's fling would (lift storage writes it directly), and fly
   * with `input` held. Reports how far it travelled, the speed it ended at, and the fastest it ever got.
   */
  const flungJump = (
    input: InputCommand,
    launch = 12,
    tuning: CharacterTuning = DEFAULT_TUNING,
  ): { dist: number; end: number; peak: number; along: number } => {
    const world = makeWorld()
    const c = addCharacter(world, playerSpawn(1000))
    const tick = (i: InputCommand): void => {
      stepCharacter(c, i, TICK_DT, tuning)
      world.step(TICK_DT)
    }
    for (let i = 0; i < 30; i++) tick(cmd(0, 0))
    tick(cmd(0, 0, true))
    c.vx = launch
    const from = c.body.translation()
    let peak = Math.hypot(c.vx, c.vz)
    let n = 1
    while (!c.grounded && n < 100) {
      tick({ ...input, jump: c.vy > 0 }) // held, so the release-cut does not shorten the flight
      peak = Math.max(peak, Math.hypot(c.vx, c.vz))
      n++
    }
    const to = c.body.translation()
    world.free()
    // `along` is signed, on the axis it was flung down. `end` is a magnitude and so cannot tell a stop
    // from a completed reversal — at full air control the character does reverse, and 5.5 m/s backwards
    // has the same magnitude as 5.5 m/s forwards.
    return { dist: Math.hypot(to.x - from.x, to.z - from.z), end: Math.hypot(c.vx, c.vz), peak, along: c.vx }
  }

  it('air control does not brake a character flying faster than moveSpeed', () => {
    // The bug this replaced: `approach` pulled `vx` toward a moveSpeed-sized target from either side, so
    // holding the direction of flight was a brake. Measured 5.02 m against 8.40 m for letting go.
    const held = flungJump(cmd(1, 0))
    const coasting = flungJump(cmd(0, 0))
    expect(held.end).toBeCloseTo(coasting.end, 6)
    expect(held.dist).toBeCloseTo(coasting.dist, 6)
  })

  it('air control never raises speed above what you came in with', () => {
    // What separates this from Quake-style air-strafing, and what keeps docs/platform/humanoid/controller.md's envelope honest.
    for (const input of [cmd(1, 0), cmd(0.7, 0.7), cmd(0, 1), cmd(-0.7, 0.7), cmd(-1, 0)])
      expect(flungJump(input).peak, `input ${input.moveX},${input.moveZ}`).toBeLessThanOrEqual(12 + 1e-6)
  })

  it('turning still costs distance, the more the further you turn', () => {
    const straight = flungJump(cmd(1, 0)).dist
    const diagonal = flungJump(cmd(0.7, 0.7)).dist
    const sideways = flungJump(cmd(0, 1)).dist
    const reversed = flungJump(cmd(-1, 0)).dist
    expect(diagonal).toBeLessThan(straight)
    expect(sideways).toBeLessThan(diagonal)
    expect(reversed).toBeLessThan(sideways)
  })

  it('pressing against the flight still brakes hard', () => {
    // Measured on the signed axis: it comes in at 12 m/s and ends going the other way.
    expect(flungJump(cmd(-1, 0)).along).toBeLessThan(0)
  })

  it('below moveSpeed the air solve is untouched — it still accelerates to the cap', () => {
    // The excess branch must not fire at all here, or every ordinary jump changed.
    expect(flungJump(cmd(1, 0), 4).end).toBeCloseTo(DEFAULT_TUNING.moveSpeed, 6)
    expect(flungJump(cmd(0, 0), 4).end).toBeCloseTo(4, 6)
  })
})

/**
 * A ground wide enough to sprint on at 30 m/s for two seconds. `makeWorld`'s 50 m slab is not: the character
 * ran off its edge mid-test and the "ground" reversal was measured in the air.
 */
const makeWideWorld = (): PhysicsWorld => {
  const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
  world.addFixedBody({ position: { x: 0, y: 0, z: 0 }, shape: { kind: 'cuboid', halfExtents: { x: 400, y: 0.1, z: 400 } } })
  return world
}

describe('groundMaxAccel / airMaxAccel (ADR 0078)', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  /** Full speed one way, then full stick the other way, reading the horizontal velocity each tick. */
  const reverse = (tuning: CharacterTuning, ticks: number): number[] => {
    const world = makeWideWorld()
    const c = addCharacter(world, playerSpawn(1000))
    for (let i = 0; i < T30(60); i++) {
      stepCharacter(c, cmd(0, 1), TICK_DT, tuning)
      world.step(TICK_DT)
    }
    const out: number[] = []
    for (let i = 0; i < ticks; i++) {
      stepCharacter(c, cmd(0, -1), TICK_DT, tuning)
      world.step(TICK_DT)
      out.push(c.vz)
    }
    world.free()
    return out
  }

  it('is off by default — a reversal at 30 m/s completes in the time-based 0.2 s, as before', () => {
    const fast: CharacterTuning = { ...DEFAULT_TUNING, moveSpeed: 30 }
    const vz = reverse(fast, T30(8))
    // groundAccelTime 0.1 s → 300 m/s²: +30 to -30 in 0.2 s.
    expect(vz[T30(6) - 1]).toBeCloseTo(-30, 5)
  })

  it('caps the change per tick, so the same reversal takes speed / brake ceiling seconds', () => {
    // `maxAccelScaling: 0` pins the ceiling at its quoted value, so this reads the cap and nothing else.
    const fast: CharacterTuning = { ...DEFAULT_TUNING, moveSpeed: 30, groundBrakeMaxAccel: 40, maxAccelScaling: 0 }
    const vz = reverse(fast, T30(60))
    // Never more than 40 m/s² × dt between ticks, *while still slowing down*. Past the turn the character is
    // accelerating the other way and the accel ceiling takes over, which is ADR 0096's whole point — from the
    // slice it turns over in, so the tick that holds the turn is part brake and part start (ADR 0215).
    let prev = 30
    for (const v of vz) {
      if (prev > 0 && v >= 0) expect(prev - v).toBeLessThanOrEqual(40 * TICK_DT + 1e-6)
      prev = v
    }
    // 30 m/s down to rest at 40 m/s² is 0.75 s = 22 ticks. Past rest it is gaining speed the other way,
    // which has no *ceiling* — but still has the time-based rate, 300 m/s², so it takes three more ticks
    // rather than arriving instantly. Uncapped is not the same as instant.
    expect(vz[T30(22) - 1]!, 'still slowing').toBeGreaterThan(0)
    expect(vz[T30(26) - 1]!, 'turned over and away at the accel rate').toBeCloseTo(-30, 4)
  })

  it('changes nothing at a speed the time-based rate is already gentler than the ceiling', () => {
    // 5.5 m/s over 0.08 s is 69 m/s²; a ceiling of 200 never binds. Pinned, so the scaling is not the subject.
    const gentle: CharacterTuning = { ...DEFAULT_TUNING, groundBrakeMaxAccel: 200, maxAccelScaling: 0 }
    expect(reverse(gentle, 10)).toEqual(reverse(DEFAULT_TUNING, 10))
  })
})

/**
 * Gaining speed and losing it have separate ceilings, and both grow with speed (ADR 0096).
 *
 * The feel this encodes came from Kodjo's collaborators measuring the genre: a start is instant however fast
 * you are, while stopping and turning carry inertia that grows as you speed up.
 */
describe('accelerating and braking are separate, and scale with speed (ADR 0096)', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  /**
   * A character standing still **on the floor**.
   *
   * The landing is not optional and it caught this test twice. `playerSpawn` is two metres up and
   * `stepCharacter` applies its own gravity whatever the world's is, so a character stepped straight away is
   * airborne — and every measurement below would silently come from the air branch instead. Landing with no
   * input keeps a fast character from travelling off the end of the floor while it falls, which is the other
   * way `grounded` goes false.
   */
  const landed = (tuning: CharacterTuning): { world: PhysicsWorld; c: CharacterState } => {
    const world = makeWideWorld()
    const c = addCharacter(world, playerSpawn(1000))
    for (let i = 0; i < T30(12); i++) {
      stepCharacter(c, cmd(0, 0), TICK_DT, tuning)
      world.step(TICK_DT)
    }
    expect(c.grounded, 'the test needs it on the ground').toBe(true)
    return { world, c }
  }

  /** Land, reach full speed, then push the other way, reporting velocity each tick. */
  const reverse = (tuning: CharacterTuning, ticks: number): number[] => {
    const { world, c } = landed(tuning)
    // Uncapped, full speed is `groundAccelTime` = 0.1 s at any speed. A tick more for slack.
    for (let i = 0; i < T30(3) + 1; i++) {
      stepCharacter(c, cmd(0, 1), TICK_DT, tuning)
      world.step(TICK_DT)
    }
    expect(c.vz, 'up to speed before the reversal').toBeCloseTo(tuning.moveSpeed, 4)
    const out: number[] = []
    for (let i = 0; i < ticks; i++) {
      stepCharacter(c, cmd(0, -1), TICK_DT, tuning)
      world.step(TICK_DT)
      out.push(c.vz)
    }
    world.free()
    return out
  }

  /** The m/s² actually applied on the first tick of a reversal — pure ceiling, before anything else bites. */
  const brakeRate = (tuning: CharacterTuning): number => (tuning.moveSpeed - reverse(tuning, 1)[0]!) / TICK_DT

  /** What keyboard ships: nothing limits gaining speed, a real ceiling limits losing it. */
  const split = (moveSpeed: number, brake: number, scaling = 0): CharacterTuning => ({
    ...DEFAULT_TUNING,
    moveSpeed,
    groundMaxAccel: Infinity,
    groundBrakeMaxAccel: brake,
    maxAccelScaling: scaling,
  })

  it('starts instantly however fast, while the same character brakes slowly', () => {
    const fast = split(120, 40)
    const { world, c } = landed(fast)
    // 120 m/s over groundAccelTime 0.1 s is 1200 m/s², uncapped — full speed in 0.1 s and no more, at any speed.
    // That constant 0.1 s is what "instant start however fast" means here.
    for (let k = 1; k <= T30(3); k++) {
      stepCharacter(c, cmd(0, 1), TICK_DT, fast)
      world.step(TICK_DT)
      expect(c.vz).toBeCloseTo(Math.min(120, 1200 * k * TICK_DT), 4)
    }
    world.free()
    // The reversal is the brake ceiling's: 40 m/s², so 0.27 s barely dents 120.
    expect(reverse(fast, T30(8))[T30(8) - 1]!).toBeCloseTo(120 - T30(8) * 40 * TICK_DT, 3)
  })

  it('brakes until it turns over, then the accel ceiling takes it', () => {
    // A reversal is not one long brake. 10 m/s to rest at 20 m/s² is 0.5 s = 15 ticks; past rest it is
    // accelerating the other way with no ceiling, so the time-based 100 m/s² finishes it in three.
    const vz = reverse(split(10, 20), T30(20))
    expect(vz[T30(14) - 1]!, 'still coming down').toBeGreaterThan(0)
    expect(vz[T30(18) - 1]!, 'away at the accel rate once it turned over').toBeCloseTo(-10, 4)
  })

  it('grows a ceiling with the square root of speed', () => {
    // Quoted at ACCEL_REF_SPEED: four times the speed is twice the ceiling, sixteen times is four.
    expect(brakeRate(split(ACCEL_REF_SPEED, 60, 0.5))).toBeCloseTo(60, 3)
    expect(brakeRate(split(ACCEL_REF_SPEED * 4, 60, 0.5))).toBeCloseTo(120, 3)
    expect(brakeRate(split(ACCEL_REF_SPEED * 16, 60, 0.5))).toBeCloseTo(240, 3)
  })

  it('spans fixed acceleration at 0 and constant time at 1', () => {
    const ratio = (scaling: number): number => brakeRate(split(ACCEL_REF_SPEED * 4, 50, scaling)) / brakeRate(split(ACCEL_REF_SPEED, 50, scaling))
    // Four times the speed, and the ceiling is: the same (so the time quadruples), doubled (the time
    // doubles), or four times bigger (the time is unchanged). That last one is why 1 means "no weight".
    expect(ratio(0)).toBeCloseTo(1, 4)
    expect(ratio(0.5)).toBeCloseTo(2, 4)
    expect(ratio(1)).toBeCloseTo(4, 4)
  })

  it('leaves a game that sets no ceiling bit-for-bit unchanged', () => {
    // Infinity short-circuits the scaling, so parkour and swing cannot be moved by `maxAccelScaling`.
    expect(reverse({ ...DEFAULT_TUNING, maxAccelScaling: 0 }, 10)).toEqual(reverse({ ...DEFAULT_TUNING, maxAccelScaling: 1 }, 10))
  })
})

describe('steering is one vector, not two axes (ADR 0078)', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  // A reversal along a diagonal must stay on that diagonal. Per-axis approach let the shorter axis finish first
  // and the velocity swing off the line; forward-back-forward then walked a circle.
  it('keeps a capped reversal on the line it was pushed along', () => {
    const tuning: CharacterTuning = { ...DEFAULT_TUNING, moveSpeed: 30, groundBrakeMaxAccel: 40, maxAccelScaling: 0 }
    const world = makeWideWorld()
    const c = addCharacter(world, playerSpawn(1000))
    // Diagonal, 30° off the z axis — the case an axis-aligned camera never exercises.
    const dx = Math.sin(Math.PI / 6)
    const dz = Math.cos(Math.PI / 6)
    for (let i = 0; i < 60; i++) {
      stepCharacter(c, cmd(dx, dz), TICK_DT, tuning)
      world.step(TICK_DT)
    }
    for (let i = 0; i < 40; i++) {
      stepCharacter(c, cmd(-dx, -dz), TICK_DT, tuning)
      world.step(TICK_DT)
      // Velocity stays parallel to the line: no component across it.
      const across = c.vx * dz - c.vz * dx
      expect(Math.abs(across)).toBeLessThan(1e-6)
    }
    world.free()
  })
})

describe('the two caps are independent (ADR 0078)', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  /** Sprint one way, jump, and at the apex flip the stick; read the horizontal velocity change per air tick. */
  const airReverse = (tuning: CharacterTuning): number[] => {
    const world = makeWideWorld()
    const c = addCharacter(world, playerSpawn(1000))
    for (let i = 0; i < 60; i++) {
      stepCharacter(c, cmd(0, 1), TICK_DT, tuning)
      world.step(TICK_DT)
    }
    stepCharacter(c, cmd(0, 1, true), TICK_DT, tuning)
    world.step(TICK_DT)
    const out: number[] = []
    let prev = c.vz
    for (let i = 0; i < 6 && !c.grounded; i++) {
      stepCharacter(c, cmd(0, -1), TICK_DT, tuning)
      world.step(TICK_DT)
      out.push(prev - c.vz)
      prev = c.vz
    }
    world.free()
    return out
  }

  it('a ground cap leaves the air alone, and an air cap binds only there', () => {
    const groundOnly: CharacterTuning = { ...DEFAULT_TUNING, moveSpeed: 30, groundBrakeMaxAccel: 40, maxAccelScaling: 0 }
    const airOnly: CharacterTuning = { ...DEFAULT_TUNING, moveSpeed: 30, airMaxAccel: 40, maxAccelScaling: 0 }
    // Uncapped air at 30 m/s over 0.1 s is 300 m/s² — ten m/s a tick. The ground cap must not touch that.
    expect(airReverse(groundOnly)[0]).toBeCloseTo(300 * TICK_DT, 5)
    // The air cap holds every air tick to 40 m/s² × dt.
    for (const d of airReverse(airOnly)) expect(d).toBeLessThanOrEqual(40 * TICK_DT + 1e-6)
    expect(airReverse(airOnly)[0]).toBeCloseTo(40 * TICK_DT, 5)
  })
})

/**
 * Air drag (ADR 0107): horizontal speed decays every airborne tick, stick or no stick, by a fraction of
 * itself. Off by default.
 */
describe('airDrag (ADR 0107)', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  /** Run up to speed, jump, then fly for `ticks` air ticks on the given stick. Horizontal speed each tick. */
  const fly = (tuning: CharacterTuning, stick: InputCommand, ticks: number): number[] => {
    const world = makeWideWorld()
    const c = addCharacter(world, playerSpawn(1000))
    for (let i = 0; i < 40; i++) {
      stepCharacter(c, cmd(0, 1), TICK_DT, tuning)
      world.step(TICK_DT)
    }
    // Jump, held so `jumpCutScale` does not read it as a deliberate short hop.
    stepCharacter(c, cmd(0, 1, true), TICK_DT, tuning)
    world.step(TICK_DT)
    const out: number[] = []
    for (let i = 0; i < ticks; i++) {
      stepCharacter(c, { ...stick, jump: c.vy > 0 }, TICK_DT, tuning)
      world.step(TICK_DT)
      out.push(Math.hypot(c.vx, c.vz))
    }
    world.free()
    return out
  }

  it('is off in DEFAULT_TUNING — speed is held through the whole flight, as before', () => {
    const coast = fly(DEFAULT_TUNING, cmd(0, 0), 10)
    for (const v of coast) expect(v).toBeCloseTo(DEFAULT_TUNING.moveSpeed, 6)
  })

  it('decays a coast by the implicit fraction, exactly — a slice at a time (ADR 0215)', () => {
    const drag: CharacterTuning = { ...DEFAULT_TUNING, airDrag: 0.5 }
    const keep = (1 / (1 + 0.5 / INTEGRATION_HZ)) ** Math.round(TICK_DT * INTEGRATION_HZ)
    const coast = fly(drag, cmd(0, 0), 8)
    let want = DEFAULT_TUNING.moveSpeed
    for (const v of coast) {
      want *= keep
      expect(v).toBeCloseTo(want, 6)
    }
  })

  it('slows you with the stick held too, not only on release', () => {
    const drag: CharacterTuning = { ...DEFAULT_TUNING, airDrag: 0.5 }
    const held = fly(drag, cmd(0, 1), 6)
    // Air control re-accelerates toward `moveSpeed` each tick and drag then takes its cut, so holding
    // forward settles just under the target rather than at it. Held is still slower than no drag at all.
    for (const v of held) {
      expect(v).toBeLessThan(DEFAULT_TUNING.moveSpeed)
      expect(v).toBeGreaterThan(DEFAULT_TUNING.moveSpeed * 0.95)
    }
  })

  it('slows a fling — the excess air control may not spend is not exempt', () => {
    const drag: CharacterTuning = { ...DEFAULT_TUNING, airDrag: 0.5 }
    const world = makeWideWorld()
    const c = addCharacter(world, playerSpawn(1000))
    // Airborne with a 100 m/s fling: twenty times `moveSpeed`, so every tick is ADR 0096's excess branch.
    stepCharacter(c, cmd(0, 1, true), TICK_DT, drag)
    world.step(TICK_DT)
    c.vz = 100
    const keep = (1 / (1 + 0.5 / INTEGRATION_HZ)) ** Math.round(TICK_DT * INTEGRATION_HZ)
    let want = 100
    for (let i = 0; i < 6; i++) {
      // Pressing the way you are going: air control is a no-op on the excess, so this reads drag alone.
      stepCharacter(c, { moveX: 0, moveZ: 1, jump: c.vy > 0 }, TICK_DT, drag)
      world.step(TICK_DT)
      want *= keep
      expect(c.vz).toBeCloseTo(want, 4)
    }
    world.free()
  })

  it('never reverses or overshoots, whatever the drag and the step', () => {
    // k·dt > 1 — a slider at the top with a long step. The explicit `1 − k·dt` would fling us backwards.
    const fierce: CharacterTuning = { ...DEFAULT_TUNING, airDrag: 40 }
    const coast = fly(fierce, cmd(0, 0), 4)
    let prev = DEFAULT_TUNING.moveSpeed
    for (const v of coast) {
      expect(v).toBeGreaterThan(0)
      expect(v).toBeLessThan(prev)
      prev = v
    }
  })

  it('leaves the ground alone: a walk at speed is untouched', () => {
    const drag: CharacterTuning = { ...DEFAULT_TUNING, airDrag: 2 }
    const world = makeWideWorld()
    const c = addCharacter(world, playerSpawn(1000))
    for (let i = 0; i < 40; i++) {
      stepCharacter(c, cmd(0, 1), TICK_DT, drag)
      world.step(TICK_DT)
    }
    expect(c.grounded).toBe(true)
    expect(Math.hypot(c.vx, c.vz)).toBeCloseTo(drag.moveSpeed, 6)
    world.free()
  })
})

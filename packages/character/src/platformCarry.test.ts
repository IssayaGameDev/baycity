import { axisAngleToQuat, quat, vec3, type Quat, type Vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics, type PhysicsBody, type PhysicsWorld } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  addCharacter,
  CHAR_HALF_HEIGHT,
  CHAR_RADIUS,
  DEFAULT_TUNING,
  stepCharacter,
  TICK_DT,
  type PlatformFrame,
} from './character'

/**
 * Platform carry: standing on a moving piece must track it exactly, every tick.
 *
 * The platform here is driven the way `@mp/content`'s loader drives one — posed outright *and*
 * targeted at the same pose, so Rapier derives zero velocity and the character controller adds
 * nothing of its own. That pairing is the whole design: the character is the only thing that
 * moves the character. If the loader ever goes back to `setNextKinematicTranslation` alone, the
 * controller starts contributing the platform's velocity on *some* ticks and these tests fail.
 *
 * Sizes are realistic (4 m platforms, walking and running speeds). Two earlier harnesses hid
 * their own bugs — a character that had fallen off an unrealistically small platform, and one
 * that was never supported at all — so every case here asserts the character is still grounded
 * on the platform it is supposed to be riding.
 */
const STAND = CHAR_HALF_HEIGHT + CHAR_RADIUS
const STILL = { moveX: 0, moveZ: 0, jump: false }

interface Platform {
  body: PhysicsBody
  /** Pose it for this tick with zero derived velocity (what the loader's `poseFrozen` does). */
  pose: (p: Vec3, r: Quat) => void
  frame: () => PlatformFrame | undefined
}

const makeWorld = (): PhysicsWorld => createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })

const addPlatform = (world: PhysicsWorld, half: Vec3, at: Vec3): Platform => {
  const body = world.addKinematicBody({ position: at, shape: { kind: 'cuboid', halfExtents: half } })
  const handle = body.colliderHandle
  return {
    body,
    pose: (p, r) => {
      body.setPosition(p)
      body.setRotation(r)
      body.setNextKinematicTranslation(p)
      body.setNextKinematicRotation(r)
    },
    frame: () => (body.colliderHandle === handle ? { position: body.translation(), rotation: body.rotation() } : undefined),
  }
}

/** Only the platform is rideable; anything else (ground, walls) reports no frame. */
const lookupFor =
  (...plats: Platform[]) =>
  (colliderHandle: number): PlatformFrame | undefined => {
    for (const p of plats) if (p.body.colliderHandle === colliderHandle) return p.frame()
    return undefined
  }

describe('platform carry', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('baseline: rests on static geometry without drifting', () => {
    const world = makeWorld()
    world.addFixedBody({ position: vec3(0, 0, 0), shape: { kind: 'cuboid', halfExtents: vec3(2, 0.2, 2) } })
    const c = addCharacter(world, vec3(0, 0.2 + STAND + 0.02, 0))
    for (let t = 0; t < 60; t++) {
      stepCharacter(c, STILL, TICK_DT, undefined, () => undefined)
      world.step(TICK_DT)
    }
    const p = c.body.translation()
    expect(c.grounded).toBe(true)
    expect(c.base).toBeUndefined() // static ground is not a movement base
    expect(Math.hypot(p.x, p.z)).toBeLessThan(0.01)
    world.free()
  })

  // The reported bug, at the size and speed it was reported at: a 4 m platform, standing still.
  // Worst-tick slip is the number that matters — an average hides a once-a-second jolt.
  for (const speed of [1, 3, 4.5, 9] as const) {
    it(`tracks a horizontal mover at ${speed} m/s with no per-tick slip`, () => {
      const world = makeWorld()
      const plat = addPlatform(world, vec3(2, 0.2, 2), vec3(0, 0, 0))
      const c = addCharacter(world, vec3(0, 0.2 + STAND + 0.02, 0))
      const platforms = lookupFor(plat)

      let x = 0
      let worstSlip = 0
      let grounded = 0
      let counted = 0
      for (let t = 0; t < 200; t++) {
        const prev = c.body.translation()
        const prevPlat = plat.body.translation().x
        x += speed * TICK_DT
        plat.pose(vec3(x, 0, 0), quat())
        world.step(TICK_DT) // (A) platform moves
        stepCharacter(c, STILL, TICK_DT, undefined, platforms)
        world.step(TICK_DT) // (B) character resolves
        if (t < 15) continue // settle + one tick to establish the base
        counted++
        grounded += c.grounded ? 1 : 0
        const slip = c.body.translation().x - prev.x - (plat.body.translation().x - prevPlat)
        worstSlip = Math.max(worstSlip, Math.abs(slip))
      }
      // Worst single tick, not the mean: 1 mm is far below anything visible.
      expect(worstSlip).toBeLessThan(0.001)
      // `grounded` comes from the controller, which flickers false for isolated ticks while
      // resting on a mover — an artifact, not a state change, so it is not asserted absolutely.
      // Staying on the surface is asserted by the slip bound and by the base surviving.
      expect(grounded).toBeGreaterThan(counted * 0.9)
      expect(c.base).toBeDefined()
      world.free()
    })
  }

  it('tracks a rising and falling elevator, keeping its feet on the surface', () => {
    const world = makeWorld()
    const plat = addPlatform(world, vec3(2, 0.2, 2), vec3(0, 0, 0))
    const c = addCharacter(world, vec3(0, 0.2 + STAND + 0.02, 0))
    const platforms = lookupFor(plat)

    let y = 0
    let minGap = Infinity
    let maxGap = -Infinity
    let grounded = 0
    let counted = 0
    for (let t = 0; t < 200; t++) {
      y += (t < 100 ? 3 : -3) * TICK_DT // up then down, both directions fail differently
      plat.pose(vec3(0, y, 0), quat())
      world.step(TICK_DT)
      stepCharacter(c, STILL, TICK_DT, undefined, platforms)
      world.step(TICK_DT)
      if (t < 15 || t === 100) continue // settle; skip the direction reversal tick
      counted++
      grounded += c.grounded ? 1 : 0
      const gap = c.body.translation().y - STAND - (plat.body.translation().y + 0.2)
      minGap = Math.min(minGap, gap)
      maxGap = Math.max(maxGap, gap)
    }
    // The invariant that matters is the feet staying on the surface, in both directions. (See the
    // horizontal cases on why the controller's `grounded` flag is not asserted absolutely.)
    expect(grounded).toBeGreaterThan(counted * 0.9)
    expect(minGap).toBeGreaterThan(-0.1) // not sinking into it
    expect(maxGap).toBeLessThan(0.1) // not being left behind by it
    world.free()
  })

  it('orbits with a rotating platform when standing off-centre', () => {
    const world = makeWorld()
    const plat = addPlatform(world, vec3(4, 0.2, 4), vec3(0, 0, 0))
    const radius = 2.5
    const c = addCharacter(world, vec3(radius, 0.2 + STAND + 0.02, 0))
    const platforms = lookupFor(plat)

    const periodTicks = 240 // one turn
    let worstRadius = 0
    let grounded = 0
    let counted = 0
    for (let t = 0; t < 200; t++) {
      const angle = (t / periodTicks) * Math.PI * 2
      plat.pose(vec3(0, 0, 0), axisAngleToQuat(vec3(0, 1, 0), angle))
      world.step(TICK_DT)
      stepCharacter(c, STILL, TICK_DT, undefined, platforms)
      world.step(TICK_DT)
      if (t < 15) continue
      counted++
      grounded += c.grounded ? 1 : 0
      const p = c.body.translation()
      // Riding a spin keeps you at a constant radius from the axis...
      worstRadius = Math.max(worstRadius, Math.abs(Math.hypot(p.x, p.z) - radius))
    }
    expect(worstRadius).toBeLessThan(0.05)
    expect(grounded).toBeGreaterThan(counted * 0.9)

    // ...and actually goes round, rather than sitting still at the same radius.
    const p = c.body.translation()
    const turned = Math.atan2(p.z, p.x)
    expect(Math.abs(turned)).toBeGreaterThan(0.5) // radians swept, well past noise
    world.free()
  })

  it('lets the player walk across a moving platform (carry and input compose)', () => {
    const world = makeWorld()
    // Wide enough that 3 s of walking stays aboard — the point is composition, not the edge.
    const plat = addPlatform(world, vec3(20, 0.2, 20), vec3(0, 0, 0))
    const c = addCharacter(world, vec3(-2, 0.2 + STAND + 0.02, 0))
    const platforms = lookupFor(plat)

    let x = 0
    for (let t = 0; t < 90; t++) {
      x += 3 * TICK_DT
      plat.pose(vec3(x, 0, 0), quat())
      world.step(TICK_DT)
      stepCharacter(c, { moveX: 0, moveZ: 1, jump: false }, TICK_DT, undefined, platforms) // walk +z
      world.step(TICK_DT)
    }
    const p = c.body.translation()
    // Carried in x with the platform, and moved in z under its own power.
    expect(Math.abs(p.x - (-2 + x))).toBeLessThan(0.1)
    expect(p.z).toBeGreaterThan(1)
    expect(c.grounded).toBe(true)
    world.free()
  })

  it('a coyote jump off a mover still inherits its velocity (lift momentum storage)', () => {
    // Walk off the edge, then jump out of the coyote window. The live `ride` is gone by then — footing
    // is what carries it — so without stored lift the mover's momentum silently vanishes for exactly the
    // late jumps coyote time exists to permit, and the fast platform reads as eating your jump.
    const run = (liftStoreTime: number): number => {
      const world = makeWorld()
      const speed = 6
      const plat = addPlatform(world, vec3(2, 0.2, 2), vec3(0, 0, 0))
      const c = addCharacter(world, vec3(0, 0.2 + STAND + 0.02, 0))
      const platforms = lookupFor(plat)
      const tuning = { ...DEFAULT_TUNING, liftStoreTime }
      let x = 0
      const tick = (cmd: typeof STILL): void => {
        x += speed * TICK_DT
        plat.pose(vec3(x, 0, 0), quat())
        world.step(TICK_DT)
        stepCharacter(c, cmd, TICK_DT, tuning, platforms)
        world.step(TICK_DT)
      }
      const WALK = { moveX: 0, moveZ: 1, jump: false }
      for (let t = 0; t < 20; t++) tick(STILL) // settle and lock the base
      expect(c.vx).toBe(0) // riding accrues no velocity of its own
      let guard = 0
      while (c.grounded && guard++ < 60) tick(WALK) // walk +z until the deck runs out
      expect(c.grounded).toBe(false)
      tick({ moveX: 0, moveZ: 1, jump: true }) // still inside the coyote window
      const vx = c.vx
      world.free()
      return vx
    }
    expect(run(0.1), 'stored lift hands the mover velocity to a late jump').toBeGreaterThan(4)
    expect(run(0), 'and at 0 it is dropped, which is what this closes').toBeLessThan(1)
  })

  it('inherits the platform velocity when jumping off, and releases the base', () => {
    const world = makeWorld()
    const speed = 6
    const plat = addPlatform(world, vec3(2, 0.2, 2), vec3(0, 0, 0))
    const c = addCharacter(world, vec3(0, 0.2 + STAND + 0.02, 0))
    const platforms = lookupFor(plat)

    let x = 0
    const tick = (cmd: typeof STILL): void => {
      x += speed * TICK_DT
      plat.pose(vec3(x, 0, 0), quat())
      world.step(TICK_DT)
      stepCharacter(c, cmd, TICK_DT, undefined, platforms)
      world.step(TICK_DT)
    }

    for (let t = 0; t < 40; t++) tick(STILL)
    expect(c.vx).toBe(0) // riding accrues no velocity
    expect(c.base).toBeDefined()

    tick({ moveX: 0, moveZ: 0, jump: true })
    expect(c.vx).toBeCloseTo(speed, 2) // the platform's speed became ours
    expect(c.grounded).toBe(false)
    expect(c.base).toBeUndefined() // airborne: no base
    world.free()
  })

  // A vertical mover is the case that broke: fast enough and the surface outruns both the ground probe's
  // reach and, on the way up, the meaning of "standing on it".
  const verticalMover = (speed: number, ease: boolean) => {
    const world = makeWorld()
    const plat = addPlatform(world, vec3(3, 0.2, 3), vec3(0, 20, 0))
    const c = addCharacter(world, vec3(0, 20.2 + STAND + 0.02, 0))
    const platforms = lookupFor(plat)
    let y = 20
    let t = 0
    const tick = (cmd: typeof STILL): void => {
      // Eased, as an authored keyframe track is: a real platform is not at full speed on tick one.
      y += speed * TICK_DT * (ease ? Math.min(1, t / 15) : 1)
      t++
      plat.pose(vec3(0, y, 0), quat())
      world.step(TICK_DT / 2)
      stepCharacter(c, cmd, TICK_DT, undefined, platforms)
      world.step(TICK_DT / 2)
    }
    return { world, c, tick, deckTop: () => y + 0.2 }
  }

  it('rides a fast descending platform without ever losing it', () => {
    // Was: from ~7 m/s down the probe's 0.4 m reach could not keep up with a tick of drop plus the
    // rider's lag, footing vanished, and the character bounce-fell after the deck the whole way.
    for (const speed of [6, 9, 12, 20]) {
      const { world, c, tick, deckTop } = verticalMover(-speed, true)
      let lost = 0
      let worst = 0
      for (let i = 0; i < 60; i++) {
        tick(STILL)
        if (c.base === undefined) lost++
        worst = Math.max(worst, Math.abs(c.body.translation().y - STAND - deckTop()))
      }
      expect(lost, `${speed} m/s down: ticks without a base`).toBe(0)
      expect(worst, `${speed} m/s down: worst gap above the deck`).toBeLessThan(0.05)
      world.free()
    }
  })

  it('lands on a platform already descending fast, and keeps it', () => {
    // The controller reports contact before the probe's centre ray can reach a surface dropping away, so
    // `grounded` cancelled the fall while no base was acquired — the fall lost for nothing, on repeat.
    for (const speed of [6, 12, 20]) {
      const world = makeWorld()
      const plat = addPlatform(world, vec3(3, 0.2, 3), vec3(0, 20, 0))
      const c = addCharacter(world, vec3(0, 24, 0)) // dropped in from ~3 m up
      const platforms = lookupFor(plat)
      let y = 20
      for (let i = 0; i < 90; i++) {
        y -= speed * TICK_DT
        plat.pose(vec3(0, y, 0), quat())
        world.step(TICK_DT / 2)
        stepCharacter(c, STILL, TICK_DT, undefined, platforms)
        world.step(TICK_DT / 2)
      }
      expect(c.base, `${speed} m/s down: base after landing`).not.toBe(undefined)
      expect(c.body.translation().y - STAND - (y + 0.2)).toBeLessThan(0.05)
      world.free()
    }
  })

  it('a jump off a fast riser is not re-captured by the deck', () => {
    // Was: the riser stayed inside the probe's reach, so footing and the base both came back on the tick
    // after take-off while `vy` was still 20+ m/s upward. A held button re-jumped and threw away the
    // platform velocity it had just inherited; a released one had `riding` zero the climb outright.
    for (const speed of [6, 9]) {
      const { world, c, tick } = verticalMover(speed, false)
      for (let i = 0; i < 30; i++) tick(STILL)
      tick({ moveX: 0, moveZ: 0, jump: true })
      const launched = c.vy
      expect(launched, 'inherits the riser velocity on top of the jump').toBeGreaterThan(speed + 10)
      // Next few ticks must be gravity and nothing else.
      for (let i = 0; i < 4; i++) {
        const expected = c.vy - DEFAULT_TUNING.gravity * TICK_DT
        tick(STILL)
        expect(c.base, 'no base while climbing away from the deck').toBe(undefined)
        expect(c.grounded, 'not grounded while climbing away from the deck').toBe(false)
        expect(c.vy, 'gravity only — nothing re-captured the jump').toBeCloseTo(expected, 5)
      }
      world.free()
    }
  })

  it('stops carrying the moment the platform is no longer underfoot', () => {
    const world = makeWorld()
    // Narrow platform beside static ground: walk off the side and the ride must end cleanly.
    world.addFixedBody({ position: vec3(0, -0.5, 0), shape: { kind: 'cuboid', halfExtents: vec3(30, 0.3, 30) } })
    const plat = addPlatform(world, vec3(1, 0.2, 1), vec3(0, 0, 0))
    const c = addCharacter(world, vec3(0, 0.2 + STAND + 0.02, 0))
    const platforms = lookupFor(plat)

    let y = 0
    for (let t = 0; t < 60; t++) {
      y += 2 * TICK_DT // ride it upward so leaving it is unambiguous
      plat.pose(vec3(0, y, 0), quat())
      world.step(TICK_DT)
      stepCharacter(c, t < 30 ? STILL : { moveX: 1, moveZ: 0, jump: false }, TICK_DT, undefined, platforms)
      world.step(TICK_DT)
    }
    // Walked off the side and fell to the static ground; no longer riding, and not dragged up.
    expect(c.base).toBeUndefined()
    expect(c.body.translation().y).toBeLessThan(y)
    world.free()
  })

  it('is unaffected by a lookup that reports nothing (static-only levels)', () => {
    const world = makeWorld()
    world.addFixedBody({ position: vec3(0, 0, 0), shape: { kind: 'cuboid', halfExtents: vec3(5, 0.2, 5) } })
    const c = addCharacter(world, vec3(0, 0.2 + STAND + 0.02, 0))
    const withLookup = () => undefined

    let a = 0
    for (let t = 0; t < 40; t++) {
      stepCharacter(c, { moveX: 1, moveZ: 0, jump: false }, TICK_DT, undefined, withLookup)
      world.step(TICK_DT)
    }
    a = c.body.translation().x

    // Same run with no lookup argument at all must land in the same place.
    const world2 = makeWorld()
    world2.addFixedBody({ position: vec3(0, 0, 0), shape: { kind: 'cuboid', halfExtents: vec3(5, 0.2, 5) } })
    const c2 = addCharacter(world2, vec3(0, 0.2 + STAND + 0.02, 0))
    for (let t = 0; t < 40; t++) {
      stepCharacter(c2, { moveX: 1, moveZ: 0, jump: false }, TICK_DT)
      world2.step(TICK_DT)
    }
    expect(c2.body.translation().x).toBeCloseTo(a, 6)
    world.free()
    world2.free()
  })

  it('rotating a platform under a rider moves them with it, not through a wall', () => {
    // A wall on the platform's path. The ride is a teleport, so the controller has to push the
    // capsule back out of the wall on the same tick; the rider must not end up on the far side.
    const world = makeWorld()
    const plat = addPlatform(world, vec3(2, 0.2, 2), vec3(0, 0, 0))
    world.addFixedBody({ position: vec3(3.2, 1.5, 0), shape: { kind: 'cuboid', halfExtents: vec3(0.3, 1.5, 4) } })
    const c = addCharacter(world, vec3(0, 0.2 + STAND + 0.02, 0))
    const platforms = lookupFor(plat)

    let x = 0
    for (let t = 0; t < 120; t++) {
      x += 4 * TICK_DT // drives the rider into the wall
      plat.pose(vec3(x, 0, 0), quat())
      world.step(TICK_DT)
      stepCharacter(c, STILL, TICK_DT, undefined, platforms)
      world.step(TICK_DT)
    }
    // Wall's near face is at x = 2.9; the capsule (r = 0.4) must stay on this side of it.
    expect(c.body.translation().x).toBeLessThan(2.9)
    world.free()
  })
})

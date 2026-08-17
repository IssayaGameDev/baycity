import { axisAngleToQuat } from '@mp/core'
import { beforeAll, describe, expect, it } from 'vitest'

import { createPhysicsWorld, initPhysics } from './world'

describe('physics world', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('drops a dynamic ball under gravity and rests it on a fixed ground', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: -9.81, z: 0 } })
    world.addFixedBody({
      position: { x: 0, y: 0, z: 0 },
      shape: { kind: 'cuboid', halfExtents: { x: 20, y: 0.1, z: 20 } },
    })
    const ball = world.addDynamicBody({
      position: { x: 0, y: 5, z: 0 },
      shape: { kind: 'ball', radius: 0.5 },
      restitution: 0.2,
    })

    const y0 = ball.translation().y
    for (let i = 0; i < 120; i++) world.step(1 / 60)
    const y1 = ball.translation().y

    expect(y1).toBeLessThan(y0) // it fell
    expect(y1).toBeGreaterThan(0.4) // rests on ground (0.1) + radius (0.5)
    expect(y1).toBeLessThan(0.9)
    world.free()
  })

  it('teleport resets a settled body back up and it falls again', () => {
    const world = createPhysicsWorld()
    world.addFixedBody({
      position: { x: 0, y: 0, z: 0 },
      shape: { kind: 'cuboid', halfExtents: { x: 20, y: 0.1, z: 20 } },
    })
    const ball = world.addDynamicBody({
      position: { x: 0, y: 5, z: 0 },
      shape: { kind: 'ball', radius: 0.5 },
    })

    for (let i = 0; i < 120; i++) world.step(1 / 60)
    expect(ball.translation().y).toBeLessThan(0.9) // settled

    ball.teleport({ x: 0, y: 5, z: 0 })
    expect(ball.translation().y).toBeCloseTo(5) // lifted back up
    for (let i = 0; i < 20; i++) world.step(1 / 60)
    expect(ball.translation().y).toBeLessThan(5) // falling again
    world.free()
  })

  it('a kinematic obstacle blocks a moving dynamic body (no tunneling)', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const obstacle = world.addKinematicBody({
      position: { x: 2, y: 0, z: 0 },
      shape: { kind: 'ball', radius: 0.5 },
    })
    const mover = world.addDynamicBody({
      position: { x: 0, y: 0, z: 0 },
      shape: { kind: 'ball', radius: 0.5 },
    })
    for (let i = 0; i < 120; i++) {
      obstacle.setNextKinematicTranslation({ x: 2, y: 0, z: 0 })
      mover.setLinvel({ x: 6, y: 0, z: 0 }) // driven right at the obstacle
      world.step(1 / 60)
    }
    // Unobstructed it would reach x≈12; it must be stopped near contact (~x=1).
    expect(mover.translation().x).toBeLessThan(1.5)
    world.free()
  })

  it('setPosition keeps velocity while teleport zeros it', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const body = world.addDynamicBody({ position: { x: 0, y: 0, z: 0 }, shape: { kind: 'ball', radius: 0.5 } })
    body.setLinvel({ x: 5, y: 0, z: 0 })
    world.step(1 / 60)
    expect(body.translation().x).toBeGreaterThan(0) // moving

    body.setPosition({ x: 0, y: 0, z: 0 }) // relocate, keep momentum
    world.step(1 / 60)
    expect(body.translation().x).toBeGreaterThan(0) // still moving

    body.teleport({ x: 0, y: 0, z: 0 }) // relocate, kill momentum
    world.step(1 / 60)
    expect(body.translation().x).toBeCloseTo(0, 3) // stopped
    world.free()
  })

  it('character controller falls, rests on the ground, and reports grounded', () => {
    const world = createPhysicsWorld()
    world.addFixedBody({ position: { x: 0, y: 0, z: 0 }, shape: { kind: 'cuboid', halfExtents: { x: 10, y: 0.1, z: 10 } } })
    const char = world.addCharacter({ position: { x: 0, y: 3, z: 0 }, radius: 0.4, halfHeight: 0.5 })
    let result = { grounded: false }
    for (let i = 0; i < 180; i++) {
      result = char.move({ x: 0, y: -0.08, z: 0 })
      world.step(1 / 60)
    }
    expect(result.grounded).toBe(true)
    const y = char.translation().y
    expect(y).toBeGreaterThan(0.5) // resting above the ground, not sunk
    expect(y).toBeLessThan(1.6) // came down from y=3
    world.free()
  })

  it('character controller is blocked by a wall', () => {
    const world = createPhysicsWorld()
    world.addFixedBody({ position: { x: 0, y: 0, z: 0 }, shape: { kind: 'cuboid', halfExtents: { x: 10, y: 0.1, z: 10 } } })
    world.addFixedBody({ position: { x: 2, y: 1, z: 0 }, shape: { kind: 'cuboid', halfExtents: { x: 0.1, y: 1, z: 5 } } })
    const char = world.addCharacter({ position: { x: 0, y: 1, z: 0 }, radius: 0.4, halfHeight: 0.5 })
    for (let i = 0; i < 120; i++) {
      char.move({ x: 0.1, y: -0.05, z: 0 })
      world.step(1 / 60)
    }
    expect(char.translation().x).toBeLessThan(1.7) // stopped before the wall face (~1.5)
    world.free()
  })

  it('a kinematic capsule blocks a character controller (remote-player mirror)', () => {
    const world = createPhysicsWorld()
    world.addFixedBody({ position: { x: 0, y: 0, z: 0 }, shape: { kind: 'cuboid', halfExtents: { x: 10, y: 0.1, z: 10 } } })
    world.addKinematicBody({
      position: { x: 2, y: 1.01, z: 0 },
      shape: { kind: 'capsule', halfHeight: 0.5, radius: 0.4 },
    })
    const char = world.addCharacter({ position: { x: 0, y: 1.01, z: 0 }, radius: 0.4, halfHeight: 0.5 })
    for (let i = 0; i < 120; i++) {
      char.move({ x: 0.1, y: -0.05, z: 0 })
      world.step(1 / 60)
    }
    // Unblocked it would pass x≈2; it must stop near contact (2 − 2·radius = 1.2).
    expect(char.translation().x).toBeLessThan(1.5)
    world.free()
  })

  it('character replay after setPosition reproduces the original trajectory', () => {
    // Reconciliation contract: setPosition back to a past position and re-running
    // the same moves must yield the same result — requires the collider to be
    // synced on setPosition (computeColliderMovement runs outside world.step).
    const makeWorld = () => {
      const world = createPhysicsWorld()
      world.addFixedBody({ position: { x: 0, y: 0, z: 0 }, shape: { kind: 'cuboid', halfExtents: { x: 10, y: 0.1, z: 10 } } })
      return world
    }
    const moves = Array.from({ length: 30 }, (_, i) => ({
      x: 0.05,
      y: i < 4 ? 0.25 : -0.1, // a short jump arc, then falling
      z: 0,
    }))

    const run = (world: ReturnType<typeof makeWorld>, char: ReturnType<(typeof world)['addCharacter']>): number[] => {
      const ys: number[] = []
      for (const m of moves) {
        char.move(m)
        world.step(1 / 60)
        ys.push(char.translation().y)
      }
      return ys
    }

    const world = makeWorld()
    const char = world.addCharacter({ position: { x: 0, y: 1.01, z: 0 }, radius: 0.4, halfHeight: 0.5 })
    // settle onto the ground first
    for (let i = 0; i < 30; i++) {
      char.move({ x: 0, y: -0.05, z: 0 })
      world.step(1 / 60)
    }
    const start = char.translation()
    const first = run(world, char)
    char.setPosition(start)
    const replay = run(world, char)
    for (let i = 0; i < moves.length; i++) expect(replay[i]).toBeCloseTo(first[i]!, 6)
    world.free()
  })

  it('places a fixed body at its initial rotation (tilted ramp collider)', () => {
    const world = createPhysicsWorld()
    const q = axisAngleToQuat({ x: 0, y: 0, z: 1 }, Math.PI / 6) // tilt 30° about Z
    const ramp = world.addFixedBody({
      position: { x: 0, y: 0, z: 0 },
      shape: { kind: 'cuboid', halfExtents: { x: 2, y: 0.1, z: 2 } },
      rotation: q,
    })
    for (let i = 0; i < 10; i++) world.step(1 / 60)
    const r = ramp.rotation()
    expect(r.x).toBeCloseTo(q.x, 6)
    expect(r.y).toBeCloseTo(q.y, 6)
    expect(r.z).toBeCloseTo(q.z, 6)
    expect(r.w).toBeCloseTo(q.w, 6)
    world.free()
  })

  it('setNextKinematicRotation spins a kinematic body (rotating bar)', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const bar = world.addKinematicBody({
      position: { x: 0, y: 1, z: 0 },
      shape: { kind: 'cuboid', halfExtents: { x: 2, y: 0.1, z: 0.1 } },
    })
    expect(bar.rotation().w).toBeCloseTo(1, 6) // starts at identity
    const q = axisAngleToQuat({ x: 0, y: 1, z: 0 }, Math.PI / 2) // quarter turn about Y
    bar.setNextKinematicRotation(q)
    world.step(1 / 60)
    const r = bar.rotation()
    expect(r.y).toBeCloseTo(q.y, 5)
    expect(r.w).toBeCloseTo(q.w, 5)
    world.free()
  })

  it('reports the colliders the character actually contacts, and only those', () => {
    const world = createPhysicsWorld()
    const floor = world.addFixedBody({ position: { x: 0, y: 0, z: 0 }, shape: { kind: 'cuboid', halfExtents: { x: 10, y: 0.1, z: 10 } } })
    // A slab floating well above the head — never touched.
    const overhead = world.addFixedBody({ position: { x: 0, y: 6, z: 0 }, shape: { kind: 'cuboid', halfExtents: { x: 10, y: 0.1, z: 10 } } })
    const char = world.addCharacter({ position: { x: 0, y: 2, z: 0 }, radius: 0.4, halfHeight: 0.5 })

    for (let i = 0; i < 180; i++) {
      char.move({ x: 0, y: -0.08, z: 0 })
      world.step(1 / 60)
    }
    const contacts = char.collisions()
    expect(contacts).toContain(floor.colliderHandle) // resting on the floor → contact reported
    expect(contacts).not.toContain(overhead.colliderHandle) // never touched → never reported
    world.free()
  })

  it('a character rides a rising kinematic platform when the platform steps first (two-phase)', () => {
    const world = createPhysicsWorld()
    const platform = world.addKinematicBody({ position: { x: 0, y: 0, z: 0 }, shape: { kind: 'cuboid', halfExtents: { x: 2, y: 0.25, z: 2 } } })
    const char = world.addCharacter({ position: { x: 0, y: 1.5, z: 0 }, radius: 0.4, halfHeight: 0.5 })

    // Settle onto the platform (two-phase each tick: platform, then character).
    for (let i = 0; i < 120; i++) {
      platform.setNextKinematicTranslation({ x: 0, y: 0, z: 0 })
      world.step(1 / 60)
      char.move({ x: 0, y: -0.05, z: 0 })
      world.step(1 / 60)
    }
    const startY = char.translation().y
    const clearance = startY - 0.25 // platform top starts at y = 0.25

    // Raise the platform 3 cm/tick for 1 s; the player must ride up, not sink through.
    let py = 0
    for (let i = 0; i < 60; i++) {
      py += 0.03
      platform.setNextKinematicTranslation({ x: 0, y: py, z: 0 }) // move platform first...
      world.step(1 / 60)
      char.move({ x: 0, y: -0.05, z: 0 }) // ...then resolve the character against it
      world.step(1 / 60)
    }
    const topNow = 0.25 + py
    expect(char.translation().y - topNow).toBeCloseTo(clearance, 1) // same clearance — rode up with it
    expect(char.translation().y).toBeGreaterThan(startY + 1.5) // actually rose ~py (1.8 m)
    world.free()
  })

  describe('castSphere', () => {
    // A wall centred 5 m along +x, 0.5 m thick, so its near face is at x = 4.75.
    const walled = () => {
      const world = createPhysicsWorld()
      const wall = world.addFixedBody({
        position: { x: 5, y: 0, z: 0 },
        shape: { kind: 'cuboid', halfExtents: { x: 0.25, y: 5, z: 5 } },
      })
      return { world, wall }
    }

    it('stops a sphere its own radius short of the surface, and names what it hit', () => {
      const { world, wall } = walled()
      const hit = world.castSphere({
        origin: { x: 0, y: 0, z: 0 },
        direction: { x: 1, y: 0, z: 0 },
        maxDistance: 20,
        radius: 0.3,
      })
      // Centre travel = 4.75 (face) - 0.3 (radius). This is the whole point of a sphere over a ray:
      // whatever sits at the result keeps that much clearance.
      expect(hit?.distance).toBeCloseTo(4.45, 3)
      expect(hit?.colliderHandle).toBe(wall.colliderHandle)
      world.free()
    })

    it('reports clear when the sweep ends short of anything', () => {
      const { world } = walled()
      expect(
        world.castSphere({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, maxDistance: 3, radius: 0.3 }),
      ).toBeUndefined()
      world.free()
    })

    it('ignores excluded colliders — a caster cannot hit itself', () => {
      const { world, wall } = walled()
      const near = world.addFixedBody({
        position: { x: 1, y: 0, z: 0 },
        shape: { kind: 'cuboid', halfExtents: { x: 0.25, y: 1, z: 1 } },
      })
      const opts = { origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, maxDistance: 20, radius: 0.3 }
      expect(world.castSphere(opts)?.colliderHandle).toBe(near.colliderHandle)
      expect(world.castSphere({ ...opts, exclude: [near.colliderHandle] })?.colliderHandle).toBe(wall.colliderHandle)
      world.free()
    })

    it('normalizes the direction, so distance is metres either way', () => {
      const { world } = walled()
      const opts = { origin: { x: 0, y: 0, z: 0 }, maxDistance: 20, radius: 0.3 }
      const unit = world.castSphere({ ...opts, direction: { x: 1, y: 0, z: 0 } })
      const long = world.castSphere({ ...opts, direction: { x: 17, y: 0, z: 0 } })
      expect(long?.distance).toBeCloseTo(unit?.distance ?? -1, 6)
      world.free()
    })

    it('ignores what it starts inside when it is heading out of it, but not when heading further in', () => {
      const { world } = walled()
      // Radius 0.3 from x = 4.6 reaches 4.9, past the wall's face at 4.75 — overlapping at the start.
      const opts = { origin: { x: 4.6, y: 0, z: 0 }, maxDistance: 20, radius: 0.3 }
      expect(world.castSphere({ ...opts, direction: { x: 1, y: 0, z: 0 } })?.distance).toBe(0) // deeper in
      expect(world.castSphere({ ...opts, direction: { x: -1, y: 0, z: 0 } })).toBeUndefined() // on the way out
      // Why it matters: the camera's boom starts at the character's head. Under a low roof the probe
      // sphere grazes the ceiling every frame, and stopping there would collapse the camera onto the
      // player even with the whole boom pointing down and away, clear of everything.
      world.free()
    })

    it('gives the character controller a collider handle to exclude itself by', () => {
      const world = createPhysicsWorld()
      const char = world.addCharacter({ position: { x: 0, y: 0, z: 0 }, radius: 0.4, halfHeight: 0.6 })
      const opts = { origin: { x: 0, y: 1, z: 0 }, direction: { x: 0, y: -1, z: 0 }, maxDistance: 5, radius: 0.3 }
      // Cast from the capsule's crown down through the body — the camera's boom at negative pitch.
      // The sphere starts overlapping the capsule and is heading deeper in, so without the exclusion
      // it never leaves the character.
      expect(world.castSphere(opts)?.colliderHandle).toBe(char.colliderHandle)
      expect(world.castSphere({ ...opts, exclude: [char.colliderHandle] })).toBeUndefined()
      world.free()
    })
  })

  describe('collision layers', () => {
    const A = { belongsTo: 0x0001, collidesWith: 0xffff & ~0x0002 }
    const B = { belongsTo: 0x0002, collidesWith: 0xffff & ~0x0001 }

    it('lets a dynamic body fall through a body whose layers it excludes, but not through the floor', () => {
      const world = createPhysicsWorld({ gravity: { x: 0, y: -9.81, z: 0 } })
      // Floor with default layers: it never claimed one, and must still stop everything.
      world.addFixedBody({ position: { x: 0, y: -3, z: 0 }, shape: { kind: 'cuboid', halfExtents: { x: 20, y: 0.5, z: 20 } } })
      world.addFixedBody({ position: { x: 0, y: 0, z: 0 }, shape: { kind: 'cuboid', halfExtents: { x: 2, y: 0.5, z: 2 } }, layers: A })
      const through = world.addDynamicBody({ position: { x: 0, y: 3, z: 0 }, shape: { kind: 'ball', radius: 0.3 }, layers: B })
      const onto = world.addDynamicBody({ position: { x: 1, y: 3, z: 0 }, shape: { kind: 'ball', radius: 0.3 }, layers: A })
      for (let i = 0; i < 240; i++) world.step(1 / 60)
      expect(through.translation().y).toBeLessThan(-2) // passed the slab, stopped by the floor
      expect(through.translation().y).toBeGreaterThan(-3)
      expect(onto.translation().y).toBeGreaterThan(0) // rested on the slab
      world.free()
    })

    it('stops a character being blocked by, or standing on, a layer it excludes', () => {
      const world = createPhysicsWorld()
      // A slab right under the capsule's feet, in the layer the capsule excludes.
      world.addFixedBody({ position: { x: 0, y: 0, z: 0 }, shape: { kind: 'cuboid', halfExtents: { x: 2, y: 0.5, z: 2 } }, layers: B })
      const char = world.addCharacter({ position: { x: 0, y: 1.5, z: 0 }, radius: 0.4, halfHeight: 0.5, layers: A })
      for (let i = 0; i < 30; i++) {
        char.move({ x: 0, y: -0.05, z: 0 })
        world.step(1 / 60)
      }
      // Neither resolved against nor probed: the controller takes its groups per call, so a capsule that
      // ignores a layer must not be able to walk on it either.
      expect(char.translation().y).toBeLessThan(0.5) // fell straight through
      expect(char.probeGround()).toBeUndefined()
      expect(char.collisions()).toHaveLength(0)
      world.free()
    })
  })

  it('leaves a fixed body where it was placed', () => {
    const world = createPhysicsWorld()
    const ground = world.addFixedBody({
      position: { x: 1, y: 2, z: 3 },
      shape: { kind: 'cuboid', halfExtents: { x: 1, y: 1, z: 1 } },
    })
    for (let i = 0; i < 30; i++) world.step(1 / 60)
    expect(ground.translation()).toEqual({ x: 1, y: 2, z: 3 })
    world.free()
  })
})

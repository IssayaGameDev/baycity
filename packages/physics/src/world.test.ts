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

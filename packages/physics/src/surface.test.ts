import { describe, expect, it, beforeAll } from 'vitest'

import { createPhysicsWorld, initPhysics } from './world'

/** A loose body takes the surface as it is (ADR 0231): a floor's friction and bounciness, not halved by its own. */

beforeAll(async () => {
  await initPhysics()
})

const DT = 1 / 60
const floorWorld = (floor: { friction?: number; restitution?: number }) => {
  const world = createPhysicsWorld()
  world.addFixedBody({ position: { x: 0, y: -0.5, z: 0 }, shape: { kind: 'cuboid', halfExtents: { x: 100, y: 0.5, z: 100 } }, ...floor })
  return world
}

/** Dropped from 2 m: the highest it gets after first touching the floor. */
const rebound = (floor: { restitution?: number }, takesSurface: boolean): number => {
  const world = floorWorld(floor)
  const box = world.addDynamicBody({ position: { x: 0, y: 2.25, z: 0 }, shape: { kind: 'cuboid', halfExtents: { x: 0.25, y: 0.25, z: 0.25 } }, takesSurface })
  let touched = false
  let top = 0
  for (let i = 0; i < 180; i++) {
    world.step(DT)
    const y = box.translation().y - 0.25
    if (y < 0.02) touched = true
    else if (touched) top = Math.max(top, y)
  }
  world.free()
  return top
}

/** Pushed along the floor at 5 m/s: its speed a second later. */
const slide = (floor: { friction?: number }, takesSurface: boolean): number => {
  const world = floorWorld(floor)
  const box = world.addDynamicBody({ position: { x: 0, y: 0.25, z: 0 }, shape: { kind: 'cuboid', halfExtents: { x: 0.25, y: 0.25, z: 0.25 } }, takesSurface })
  for (let i = 0; i < 10; i++) world.step(DT)
  box.setLinvel({ x: 5, y: 0, z: 0 })
  for (let i = 0; i < 60; i++) world.step(DT)
  const v = box.linvel().x
  world.free()
  return v
}

describe('a loose body on a surface', () => {
  it('bounces by the floor’s bounciness, where a plain one gets half', () => {
    const takes = rebound({ restitution: 0.8 }, true)
    // A ball: 0.8 of the speed back is 0.64 of the 2 m.
    expect(takes).toBeGreaterThan(1)
    expect(rebound({ restitution: 0.8 }, false), 'averaged with its own 0').toBeLessThan(takes / 2)
  })

  it('slides on the floor’s friction, where a plain one still grips', () => {
    expect(slide({ friction: 0 }, true), 'ice: no friction, no slowing').toBeCloseTo(5, 1)
    expect(slide({ friction: 0 }, false), 'averaged with its own 0.5').toBeLessThan(4)
  })

  it('is as before on a floor nobody set', () => {
    expect(slide({}, true)).toBeCloseTo(slide({}, false), 3)
    expect(rebound({}, true)).toBeCloseTo(rebound({}, false), 3)
  })
})

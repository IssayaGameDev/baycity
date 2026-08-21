import { instantiateLevel, COLLIDER } from '@mp/content'
import { Hazard } from '@mp/components'
import type { Vec3 } from '@mp/core'
import { PARKOUR_REGISTRY } from './rules'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { DEFAULT_NAME, levelByName, levelNames } from './levels'

describe('level selection', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('defaults to default.json when no name is given', () => {
    expect(levelByName(null).id).toBe(levelByName(DEFAULT_NAME).id)
  })

  it('lists the default first, then the rest', () => {
    const names = levelNames()
    expect(names[0]).toBe(DEFAULT_NAME)
    expect(new Set(names).size, 'no duplicates').toBe(names.length)
  })

  it('names the alternatives when asked for a level that is not there', () => {
    expect(() => levelByName('nope')).toThrow(/no level "nope"/)
    expect(() => levelByName('nope')).toThrow(new RegExp(DEFAULT_NAME))
  })

  // Every file the mode will now load, actually loading. `validateLevel` only checks structure, so
  // instantiating is what proves the colliders and behaviors are real — and it covers whatever the
  // editor last wrote, which is the point of wiring the directory up at all.
  it.each(levelNames())('loads and instantiates %s', (name) => {
    const level = levelByName(name)
    const world = createPhysicsWorld({ gravity: { x: 0, y: -30, z: 0 } })
    const loaded = instantiateLevel(world, level, PARKOUR_REGISTRY)
    expect(loaded.visuals.length, `${name} has no geometry`).toBeGreaterThan(0)
    world.free()
  })
})

/**
 * The kill plane is authored content now, not a `fallY` number (ADR 0053) — a `Hazard` on a wide flat collider
 * under the level. That makes it visible and draggable, and it makes one new mistake possible: drag it up into
 * the level and you have made the level instantly lethal, or spawn inside it and die forever.
 *
 * `Hazard` → `kill` is covered in `@mp/components`; what needs guarding here is the *placement*.
 */
describe('the kill plane', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  const planeOf = (name: string): { top: number; halfXZ: number } | null => {
    const node = levelByName(name).nodes.find((n) => n.components.some((c) => c.type === Hazard.type))
    if (node === undefined) return null
    const shape = node.components.find((c) => c.type === COLLIDER)?.params.shape as { halfExtents?: Vec3 } | undefined
    const half = shape?.halfExtents
    if (half === undefined) return null
    return { top: node.transform.position.y + half.y, halfXZ: Math.min(half.x, half.z) }
  }

  it.each(levelNames())('%s keeps its plane below everything you can stand on', (name) => {
    const plane = planeOf(name)
    if (plane === null) return // a tower has none, and that is legal
    const level = levelByName(name)
    for (const node of level.nodes) {
      if (node.components.some((c) => c.type === Hazard.type)) continue
      expect(node.transform.position.y, `${node.name ?? node.id} is at or below the kill plane`).toBeGreaterThan(plane.top)
    }
  })

  it.each(levelNames())('%s spawns above its plane, not inside it', (name) => {
    const plane = planeOf(name)
    if (plane === null) return
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateLevel(world, levelByName(name), PARKOUR_REGISTRY)
    for (const marker of loaded.markers) expect(marker.position.y, 'spawn is inside the kill plane').toBeGreaterThan(plane.top)
    world.free()
  })

  // 60 m/s terminal (`maxFallSpeed`) at a 1/60 s step is one metre travelled per step, so a plane thinner than
  // that could be fallen straight through between two overlap checks. Six metres is six steps of margin.
  it.each(levelNames())('%s has a plane thick and wide enough to catch a fall', (name) => {
    const plane = planeOf(name)
    if (plane === null) return
    const node = levelByName(name).nodes.find((n) => n.components.some((c) => c.type === Hazard.type))!
    const half = (node.components.find((c) => c.type === COLLIDER)!.params.shape as { halfExtents: Vec3 }).halfExtents
    expect(half.y * 2, 'thinner than one tick of terminal velocity').toBeGreaterThanOrEqual(2)
    expect(plane.halfXZ, 'narrower than the levels we author').toBeGreaterThanOrEqual(60)
  })

  /**
   * A **trigger**, not a solid (ADR 0054). Turn the flag off and the plane becomes a floor: you land on the
   * thing that is supposed to be empty space with a rule in it, and the level stops being a fall at all.
   */
  it.each(levelNames())('%s keeps its plane a trigger, not a floor', (name) => {
    const node = levelByName(name).nodes.find((n) => n.components.some((c) => c.type === Hazard.type))
    if (node === undefined) return
    expect(node.components.find((c) => c.type === COLLIDER)?.params.trigger).toBe(true)
  })
})

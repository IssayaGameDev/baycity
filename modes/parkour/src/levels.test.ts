import { instantiateLevel } from '@mp/content'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { GYM, levelByName, levelNames } from './levels'

describe('level selection', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('defaults to the gym when no name is given', () => {
    expect(levelByName(null).id).toBe(levelByName(GYM).id)
  })

  it('lists the gym first, then the files', () => {
    const names = levelNames()
    expect(names[0]).toBe(GYM)
    expect(new Set(names).size, 'no duplicates').toBe(names.length)
  })

  it('names the alternatives when asked for a level that is not there', () => {
    expect(() => levelByName('nope')).toThrow(/no level "nope"/)
    expect(() => levelByName('nope')).toThrow(new RegExp(GYM))
  })

  // Every file the mode will now load, actually loading. `validateLevel` only checks structure, so
  // instantiating is what proves the colliders and behaviors are real — and it covers whatever the
  // editor last wrote, which is the point of wiring the directory up at all.
  it.each(levelNames())('loads and instantiates %s', (name) => {
    const level = levelByName(name)
    const world = createPhysicsWorld({ gravity: { x: 0, y: -30, z: 0 } })
    const loaded = instantiateLevel(world, level)
    expect(loaded.visuals.length, `${name} has no geometry`).toBeGreaterThan(0)
    world.free()
  })
})

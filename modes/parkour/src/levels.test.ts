import { instantiateLevel, scaleCollider, validateLevel, COLLIDER, DEFAULT_LEVEL, type ColliderDesc, type Level } from '@mp/content'
import { Hazard } from '@mp/components'
import { vec3 } from '@mp/core'
import { PARKOUR_REGISTRY } from './rules'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { REPO_CONTENT } from '../../../content-root'
import { diskContent } from '../../../game-content'

/** Parkour's own levels, as its page is served them (ADR 0169), validated against its own registry as the page does. */
const disk = diskContent(REPO_CONTENT, 'parkour')
const index = disk.index()
const levels = {
  names: (): string[] => index.levels,
  byName: (name: string | null): Level => validateLevel(disk.level(name ?? index.default), PARKOUR_REGISTRY),
}

describe('level selection', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('defaults to default.level.json when no name is given', () => {
    expect(index.default).toBe(DEFAULT_LEVEL)
  })

  it('lists the default first, then the rest', () => {
    const names = levels.names()
    expect(names[0]).toBe(DEFAULT_LEVEL)
    expect(new Set(names).size, 'no duplicates').toBe(names.length)
  })

  it('has no level it was not given', () => {
    expect(disk.level('nope')).toBeUndefined()
  })

  // Every file the mode will now load, actually loading. `validateLevel` only checks structure, so
  // instantiating is what proves the colliders and behaviors are real — and it covers whatever the
  // editor last wrote, which is the point of wiring the directory up at all.
  it.each(levels.names())('loads and instantiates %s', (name) => {
    const level = levels.byName(name)
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

  /**
   * The plane's real dimensions, with the node's scale baked into its collider as the loader bakes it
   * (`scaleCollider`). A kill plane authored after the built-in shapes landed is a **unit** box carrying its
   * size as scale (ADR 0090), so reading half extents alone would call a six-metre plane one metre thick.
   */
  const planeOf = (name: string): { top: number; halfY: number; halfXZ: number } | null => {
    const node = levels.byName(name).nodes.find((n) => n.components.some((c) => c.type === Hazard.type))
    if (node === undefined) return null
    const shape = node.components.find((c) => c.type === COLLIDER)?.params.shape as ColliderDesc | undefined
    if (shape === undefined) return null
    const baked = scaleCollider(shape, node.transform.scale ?? vec3(1, 1, 1))
    if (baked.kind !== 'box') return null
    const half = baked.halfExtents
    return { top: node.transform.position.y + half.y, halfY: half.y, halfXZ: Math.min(half.x, half.z) }
  }

  it.each(levels.names())('%s keeps its plane below everything you can stand on', (name) => {
    const plane = planeOf(name)
    if (plane === null) return // a tower has none, and that is legal
    const level = levels.byName(name)
    for (const node of level.nodes) {
      if (node.components.some((c) => c.type === Hazard.type)) continue
      expect(node.transform.position.y, `${node.name ?? node.id} is at or below the kill plane`).toBeGreaterThan(plane.top)
    }
  })

  it.each(levels.names())('%s spawns above its plane, not inside it', (name) => {
    const plane = planeOf(name)
    if (plane === null) return
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateLevel(world, levels.byName(name), PARKOUR_REGISTRY)
    for (const marker of loaded.markers) expect(marker.position.y, 'spawn is inside the kill plane').toBeGreaterThan(plane.top)
    world.free()
  })

  // 60 m/s terminal (`maxFallSpeed`) at a 1/60 s step is one metre travelled per step, so a plane thinner than
  // that could be fallen straight through between two overlap checks. Six metres is six steps of margin.
  it.each(levels.names())('%s has a plane thick and wide enough to catch a fall', (name) => {
    const plane = planeOf(name)
    if (plane === null) return
    expect(plane.halfY * 2, 'thinner than one tick of terminal velocity').toBeGreaterThanOrEqual(2)
    expect(plane.halfXZ, 'narrower than the levels we author').toBeGreaterThanOrEqual(60)
  })

  /**
   * A **trigger**, not a solid (ADR 0054). Turn the flag off and the plane becomes a floor: you land on the
   * thing that is supposed to be empty space with a rule in it, and the level stops being a fall at all.
   */
  it.each(levels.names())('%s keeps its plane a trigger, not a floor', (name) => {
    const node = levels.byName(name).nodes.find((n) => n.components.some((c) => c.type === Hazard.type))
    if (node === undefined) return
    expect(node.components.find((c) => c.type === COLLIDER)?.params.trigger).toBe(true)
  })
})

/**
 * A game's levels are the ones in its own folder, `content/parkour/levels/` (ADR 0108). The tag inside each
 * file is kept in step with the folder, so it is still worth asserting: a level whose tag says another game
 * is refused by `loadLevel` when it arrives over HTTP.
 */
describe('whose levels these are', () => {
  it('only lists levels that name this game, or name none', () => {
    for (const name of levels.names()) {
      const named = levels.byName(name).config.mode?.name
      expect(named ?? 'parkour', `${name} belongs to another game`).toBe('parkour')
    }
  })

  it('serves no level of another game’s, whoever owns the name', () => {
    expect(diskContent(REPO_CONTENT, 'swing').index().levels).not.toContain('default')
    expect(disk.level('swing')).toBeUndefined()
  })
})

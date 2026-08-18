import { vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { instantiateLevel } from './loader'
import { freeTableId, instancesOf, resolvePrefab, walkInstances } from './resolve'
import { validateLevel } from './validate'
import type { Level, Prefab } from './types'

const pad = (style?: string): Prefab => ({
  id: 'pad',
  pieces: [
    {
      collider: { kind: 'box', halfExtents: vec3(1, 0.2, 1) },
      transform: { position: vec3(0, 0, 0) },
      ...(style !== undefined ? { visual: { kind: 'primitive' as const, style } } : {}),
    },
  ],
})

/** A level whose three instances all reference one table entry — the shape the editor now writes. */
const referenced: Level = {
  id: 'refs',
  config: { fallBehavior: 'physical-fall', fallY: -20 },
  prefabs: { pad: pad('platform') },
  instances: [
    { prefab: 'pad', transform: { position: vec3(0, 0, 0) } },
    { prefab: 'pad', transform: { position: vec3(4, 0, 0) } },
    { prefab: 'pad', transform: { position: vec3(8, 0, 0) }, style: 'hazard' },
  ],
}

describe('prefab references', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('resolves an id against the table and hands back the one shared object', () => {
    const a = resolvePrefab(referenced, referenced.instances[0]!)
    const b = resolvePrefab(referenced, referenced.instances[1]!)
    expect(a, 'two instances of one prefab see the same object, not copies').toBe(b)
    expect(a).toBe(referenced.prefabs!['pad'])
  })

  it('returns an inline definition as itself', () => {
    const inline = pad()
    const level: Level = { ...referenced, instances: [{ prefab: inline, transform: { position: vec3(0, 0, 0) } }] }
    expect(resolvePrefab(level, level.instances[0]!)).toBe(inline)
  })

  it('names the missing id when a reference dangles', () => {
    const level: Level = { ...referenced, prefabs: {}, instances: [{ prefab: 'gone', transform: { position: vec3(0, 0, 0) } }] }
    expect(() => resolvePrefab(level, level.instances[0]!)).toThrow(/'gone'/)
  })

  it('counts the instances watching an id', () => {
    expect(instancesOf(referenced, 'pad')).toEqual(referenced.instances)
    expect(instancesOf(referenced, 'nothing')).toEqual([])
  })

  it('finds referencing instances at any depth, and walks parents before children', () => {
    const nested: Level = {
      ...referenced,
      instances: [
        {
          prefab: 'pad',
          transform: { position: vec3(0, 0, 0) },
          children: [
            {
              prefab: 'pad',
              transform: { position: vec3(0, 1, 0) },
              children: [{ prefab: 'pad', transform: { position: vec3(0, 2, 0) } }],
            },
          ],
        },
      ],
    }
    expect(instancesOf(nested, 'pad'), 'three deep, all counted').toHaveLength(3)

    const walk = walkInstances(nested)
    expect(
      walk.map((v) => v.depth),
      'depth-first, parents before children',
    ).toEqual([0, 1, 2])
    expect(walk[1]!.parent).toBe(walk[0]!.inst)
    expect(walk[2]!.siblings, 'siblings is the array it can be spliced within').toBe(walk[1]!.inst.children)
    expect(walk[0]!.index).toBe(0)
  })

  it('editing the shared definition moves every instance at once', () => {
    const level = structuredClone(referenced)
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    // The point of a reference: one edit to the table entry, and all three pieces are 2 m thick.
    level.prefabs!['pad']!.pieces[0]!.collider = { kind: 'box', halfExtents: vec3(1, 1, 1) }
    const loaded = instantiateLevel(world, level)
    expect(loaded.visuals).toHaveLength(3)
    for (const v of loaded.visuals) expect(v.collider).toEqual({ kind: 'box', halfExtents: vec3(1, 1, 1) })
    world.free()
  })

  it("an instance's style override beats the prefab's, and only for that instance", () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateLevel(world, referenced)
    expect(loaded.visuals.map((v) => v.style)).toEqual(['platform', 'platform', 'hazard'])
    expect(referenced.prefabs!['pad']!.pieces[0]!.visual, 'the shared definition is untouched').toEqual({
      kind: 'primitive',
      style: 'platform',
    })
    world.free()
  })

  it('validates a referencing level, and rejects a style that is not a string', () => {
    expect(() => validateLevel(structuredClone(referenced))).not.toThrow()
    const bad = structuredClone(referenced) as unknown as { instances: { style?: unknown }[] }
    bad.instances[0]!.style = 7
    expect(() => validateLevel(bad)).toThrow(/style/)
  })
})

describe('freeTableId', () => {
  it('reuses an entry holding the same content, so placing twice shares one', () => {
    const table: Record<string, Prefab> = { pad: pad('platform') }
    expect(freeTableId(table, pad('platform'))).toBe('pad')
  })

  it('ignores the id when comparing content — the id is the thing allowed to differ', () => {
    const table: Record<string, Prefab> = { pad: pad('platform') }
    expect(freeTableId(table, { ...pad('platform'), id: 'pad' })).toBe('pad')
  })

  it('suffixes when the id is taken by different content', () => {
    const table: Record<string, Prefab> = { pad: pad('platform') }
    expect(freeTableId(table, pad('hazard'))).toBe('pad-2')
  })

  it('keeps counting past a taken suffix, and still reuses a match further along', () => {
    const table: Record<string, Prefab> = { pad: pad('platform'), 'pad-2': pad('hazard') }
    expect(freeTableId(table, pad('goal')), 'third distinct pad').toBe('pad-3')
    expect(freeTableId(table, pad('hazard')), 'matches pad-2 exactly').toBe('pad-2')
  })

  it('takes a free id in an empty table', () => {
    expect(freeTableId({}, pad())).toBe('pad')
  })
})

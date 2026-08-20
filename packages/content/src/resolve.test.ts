import { vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { instantiateLegacyLevel } from './loader'
import { effectivePieces, freeTableId, instancesOf, overriddenFields, resolvePrefab, walkInstances } from './resolve'
import { validateLevel } from './validate'
import type { Level, Prefab } from './types'

const pad = (material?: string): Prefab => ({
  id: 'pad',
  pieces: [
    {
      collider: { kind: 'box', halfExtents: vec3(1, 0.2, 1) },
      transform: { position: vec3(0, 0, 0) },
      ...(material !== undefined ? { visual: { kind: 'primitive' as const, material } } : {}),
    },
  ],
})

/** A level whose three instances all reference one table entry — the shape the editor now writes. */
const referenced: Level = {
  id: 'refs',
  config: { fallBehavior: 'physical-fall', fallY: -20 },
  prefabs: { pad: pad('mat-platform') },
  instances: [
    { prefab: 'pad', transform: { position: vec3(0, 0, 0) } },
    { prefab: 'pad', transform: { position: vec3(4, 0, 0) } },
    { prefab: 'pad', transform: { position: vec3(8, 0, 0) }, material: 'mat-hazard' },
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
    const loaded = instantiateLegacyLevel(world, level)
    expect(loaded.visuals).toHaveLength(3)
    for (const v of loaded.visuals) expect(v.collider).toEqual({ kind: 'box', halfExtents: vec3(1, 1, 1) })
    world.free()
  })

  it("an instance's material override beats the prefab's, and only for that instance", () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateLegacyLevel(world, referenced)
    expect(loaded.visuals.map((v) => v.material)).toEqual(['mat-platform', 'mat-platform', 'mat-hazard'])
    expect(referenced.prefabs!['pad']!.pieces[0]!.visual, 'the shared definition is untouched').toEqual({
      kind: 'primitive',
      material: 'mat-platform',
    })
    world.free()
  })

  it('validates a referencing level, and rejects a material that is not a string', () => {
    expect(() => validateLevel(structuredClone(referenced))).not.toThrow()
    const bad = structuredClone(referenced) as unknown as { instances: { material?: unknown }[] }
    bad.instances[0]!.material = 7
    expect(() => validateLevel(bad)).toThrow(/material/)
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

describe('effectivePieces: per-instance overrides (ADR 0033)', () => {
  const withPieces = (): Level => ({
    id: 'ov',
    config: { fallBehavior: 'physical-fall', fallY: -20 },
    prefabs: {
      pad: {
        id: 'pad',
        pieces: [
          {
            id: 'p1',
            collider: { kind: 'box', halfExtents: vec3(1, 0.2, 1) },
            transform: { position: vec3(0, 0, 0) },
            visual: { kind: 'primitive', material: 'mat-shared' },
            trigger: { kind: 'hazard' },
            name: 'top',
          },
          { id: 'p2', collider: { kind: 'box', halfExtents: vec3(1, 1, 1) }, transform: { position: vec3(0, 2, 0) } },
        ],
      },
    },
    instances: [{ prefab: 'pad', transform: { position: vec3(0, 0, 0) } }],
  })

  it('is the prefab itself when nothing is overridden, objects and all', () => {
    const level = withPieces()
    const pieces = effectivePieces(level, level.instances[0]!)
    // Identity, not just equality: the editor writes through these to edit the shared definition, so copying
    // unconditionally would turn a prefab edit into a no-op.
    expect(pieces[0]).toBe(level.prefabs!['pad']!.pieces[0])
  })

  it('replaces only the fields the override names', () => {
    const level = withPieces()
    level.instances[0]!.overrides = { p1: { material: 'mat-mine' } }
    const [first] = effectivePieces(level, level.instances[0]!)

    expect(first!.visual).toEqual({ kind: 'primitive', material: 'mat-mine' })
    expect(first!.trigger, 'untouched fields inherit').toEqual({ kind: 'hazard' })
    expect(first!.name).toBe('top')
    expect(level.prefabs!['pad']!.pieces[0]!.visual, 'and the prefab is not written to').toEqual({
      kind: 'primitive',
      material: 'mat-shared',
    })
  })

  it('leaves the pieces it has no override for alone', () => {
    const level = withPieces()
    level.instances[0]!.overrides = { p1: { name: 'mine' } }
    const pieces = effectivePieces(level, level.instances[0]!)
    expect(pieces[1]).toBe(level.prefabs!['pad']!.pieces[1])
  })

  // Absence means inherit, so clearing needs a value. Otherwise "no material here" and "say nothing about the
  // material" would be the same JSON.
  it('clears a material with the empty string rather than by omission', () => {
    const level = withPieces()
    level.instances[0]!.overrides = { p1: { material: '' } }
    expect(effectivePieces(level, level.instances[0]!)[0]!.visual).toBeUndefined()
  })

  it('clears a trigger with an explicit none', () => {
    const level = withPieces()
    level.instances[0]!.overrides = { p1: { trigger: { kind: 'none' } } }
    expect(effectivePieces(level, level.instances[0]!)[0]!.trigger).toBeUndefined()
  })

  it('overrides a trigger with a different one, parameters and all', () => {
    const level = withPieces()
    level.instances[0]!.overrides = { p1: { trigger: { kind: 'bumper', power: 30 } } }
    expect(effectivePieces(level, level.instances[0]!)[0]!.trigger).toEqual({ kind: 'bumper', power: 30 })
  })

  it('overrides a transform and a behavior', () => {
    const level = withPieces()
    level.instances[0]!.overrides = {
      p1: { transform: { position: vec3(5, 5, 5) }, behavior: { kind: 'track', keys: [{ t: 0 }, { t: 500, position: vec3(0, 1, 0) }] } },
    }
    const [first] = effectivePieces(level, level.instances[0]!)
    expect(first!.transform.position).toEqual(vec3(5, 5, 5))
    expect(first!.behavior).toMatchObject({ kind: 'track' })
  })

  // The blunt override predates the fine-grained one (ADR 0028) and is the coarser statement, so it wins.
  it("lets the instance-wide material beat a piece's own override", () => {
    const level = withPieces()
    level.instances[0]!.material = 'mat-all'
    level.instances[0]!.overrides = { p1: { material: 'mat-mine' } }
    expect(effectivePieces(level, level.instances[0]!)[0]!.visual).toEqual({ kind: 'primitive', material: 'mat-all' })
  })

  it('keeps a model when only its material is overridden', () => {
    const level = withPieces()
    level.prefabs!['pad']!.pieces[0]!.visual = { kind: 'model', asset: 'crate', material: 'mat-shared' }
    level.instances[0]!.overrides = { p1: { material: 'mat-mine' } }
    expect(effectivePieces(level, level.instances[0]!)[0]!.visual).toEqual({ kind: 'model', asset: 'crate', material: 'mat-mine' })
  })

  it('drops a model\'s material override without dropping the model', () => {
    const level = withPieces()
    level.prefabs!['pad']!.pieces[0]!.visual = { kind: 'model', asset: 'crate', material: 'mat-shared' }
    level.instances[0]!.overrides = { p1: { material: '' } }
    expect(effectivePieces(level, level.instances[0]!)[0]!.visual).toEqual({ kind: 'model', asset: 'crate' })
  })

  // The reason ids exist. An index-keyed override would follow the position, not the piece.
  it('ignores an override whose key matches no piece id', () => {
    const level = withPieces()
    level.instances[0]!.overrides = { nobody: { material: 'mat-mine' } }
    expect(effectivePieces(level, level.instances[0]!)[0]!.visual).toEqual({ kind: 'primitive', material: 'mat-shared' })
  })

  it('follows the piece when the prefab reorders, which an index could not', () => {
    const level = withPieces()
    level.instances[0]!.overrides = { p2: { name: 'mine' } }
    const pieces = level.prefabs!['pad']!.pieces
    pieces.reverse() // p2 is now first

    const effective = effectivePieces(level, level.instances[0]!)
    expect(effective[0]!.id, 'the override still belongs to p2').toBe('p2')
    expect(effective[0]!.name).toBe('mine')
    expect(effective[1]!.name, 'and p1 keeps its own').toBe('top')
  })

  it('leaves a piece with no id unoverridable rather than guessing', () => {
    const level = withPieces()
    delete level.prefabs!['pad']!.pieces[0]!.id
    level.instances[0]!.overrides = { p1: { material: 'mat-mine' } }
    expect(effectivePieces(level, level.instances[0]!)[0]!.visual).toEqual({ kind: 'primitive', material: 'mat-shared' })
  })
})

describe('overriddenFields', () => {
  it('lists what a placement has changed, in a stable order', () => {
    expect(overriddenFields({ material: 'm', name: 'n' })).toEqual(['material', 'name'])
    expect(overriddenFields({ transform: { position: vec3(0, 0, 0) }, behavior: { kind: 'static' } })).toEqual([
      'transform',
      'behavior',
    ])
  })

  it('is empty for no override and for an empty one', () => {
    expect(overriddenFields(undefined)).toEqual([])
    expect(overriddenFields({})).toEqual([])
  })
})

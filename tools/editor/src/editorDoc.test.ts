import { instantiateLevel, validateLevel, type Level, type Prefab } from '@mp/content'
import { vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { levelDoc, prefabDoc, type ItemProps } from './editorDoc'

const blank = (): Level => ({ id: 'untitled', config: { fallBehavior: 'physical-fall', fallY: -20 }, instances: [] })

const props = (over: Partial<ItemProps> = {}): ItemProps => ({
  behavior: 'static',
  distance: 3,
  periodMs: 4000,
  axis: vec3(0, 1, 0),
  pieceLevel: false,
  style: '',
  trigger: 'none',
  material: '',
  ...over,
})

const inlineInstance = (id: string, half = vec3(1, 0.5, 1)): Prefab => ({
  id,
  pieces: [{ collider: { kind: 'box', halfExtents: half }, transform: { position: vec3(0, 0, 0) } }],
})

/**
 * The prefab files a level's palette offers. Generators are gone (ADR 0027), so everything placeable is
 * data — which is what these stand in for.
 */
const LIBRARY: Record<string, Prefab> = {
  platform: inlineInstance('platform', vec3(1.5, 0.15, 1.5)),
  ramp: inlineInstance('ramp', vec3(1.5, 0.15, 2)),
  'moving platform': {
    id: 'moving platform',
    pieces: [
      {
        collider: { kind: 'box', halfExtents: vec3(1.5, 0.15, 1.5) },
        transform: { position: vec3(0, 0, 0) },
        visual: { kind: 'primitive', style: 'moving' },
      },
    ],
    behavior: { kind: 'move', axis: vec3(0, 1, 0), distance: 1.5, periodMs: 4000 },
  },
  'checkpoint pad': {
    id: 'checkpoint pad',
    pieces: [
      {
        collider: { kind: 'box', halfExtents: vec3(1.5, 0.1, 1.5) },
        transform: { position: vec3(0, 0, 0) },
        visual: { kind: 'primitive', style: 'checkpoint' },
        trigger: 'checkpoint',
      },
    ],
  },
}

describe('levelDoc: placing references, not copies', () => {
  it('places two of the same prefab as one table entry and two references', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))
    doc.place('platform', vec3(4, 0, 0))

    expect(Object.keys(level.prefabs ?? {}), 'one shared definition').toEqual(['platform'])
    expect(level.instances.map((i) => i.prefab)).toEqual(['platform', 'platform'])
    expect(doc.refCount('platform')).toBe(2)
  })

  it('lets an edit to the shared definition through to every instance', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))
    doc.place('platform', vec3(4, 0, 0))

    // Exactly what "Edit prefab" does: a prefabDoc over the table object the instances reference.
    const shared = doc.prefabAt('platform')!
    prefabDoc(shared).setProps(0, props({ pieceLevel: true, style: 'hazard' }))

    expect(doc.meshSpecs(0)[0]!.style).toBe('hazard')
    expect(doc.meshSpecs(1)[0]!.style, 'the second instance followed without being touched').toBe('hazard')
  })

  it('keeps the reference when an instance is duplicated', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))
    const copy = doc.duplicate(0)

    expect(level.instances[copy]!.prefab, 'still an id, not an inlined clone').toBe('platform')
    expect(doc.refCount('platform')).toBe(2)
  })

  it('places a library prefab under its file name, not the id stored in the file', () => {
    const level = blank()
    // The real case: content/prefabs/FastElevator.json carries "id": "untitled".
    const doc = levelDoc(level, { FastElevator: inlineInstance('untitled') })
    doc.place('FastElevator', vec3(0, 0, 0))

    expect(Object.keys(level.prefabs ?? {})).toEqual(['FastElevator'])
    expect(level.prefabs!['FastElevator']!.id).toBe('FastElevator')
  })

  // The palette is only what *this level* defines. Prefab files are placed from the Project explorer by
  // asset id; listing them here too is what made one prefab appear in two places (ADR 0027).
  it("offers only the level's own table entries in the palette", () => {
    const level = blank()
    const doc = levelDoc(level, { ...LIBRARY, MyRamp: inlineInstance('MyRamp') })

    expect(doc.palette(), 'nothing placed yet, so nothing of its own').toEqual([])

    doc.place('platform', vec3(0, 0, 0))

    expect(doc.palette(), 'now it has one').toEqual(['platform'])
    expect(doc.palette(), "an unplaced prefab file is the explorer's to offer").not.toContain('MyRamp')
  })

  it('extracts an inline one-off into a shared entry, keeping its geometry', () => {
    const level = blank()
    level.instances.push({ prefab: inlineInstance('slab', vec3(2, 0.25, 2)), transform: { position: vec3(1, 2, 3) } })
    const doc = levelDoc(level, LIBRARY)

    expect(doc.refOf(0), 'inline to start with').toBeNull()
    const id = doc.extract(0)

    expect(id).toBe('slab')
    expect(doc.refOf(0)).toBe('slab')
    expect(doc.refCount('slab')).toBe(1)
    expect(doc.meshSpecs(0)[0]!.collider).toEqual({ kind: 'box', halfExtents: vec3(2, 0.25, 2) })
    expect(level.instances[0]!.transform.position, 'placement untouched').toEqual(vec3(1, 2, 3))
    expect(doc.extract(0), 'already a reference — nothing to do').toBeNull()
  })

  it('suffixes an extracted prefab whose id is taken by different content', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))
    // A different shape claiming the name the placed prefab already holds.
    level.instances.push({ prefab: inlineInstance('platform', vec3(9, 9, 9)), transform: { position: vec3(0, 0, 0) } })

    expect(doc.extract(1)).toBe('platform-2')
    expect(doc.prefabAt('platform')!.pieces[0]!.collider, 'the existing entry is not overwritten').not.toEqual({
      kind: 'box',
      halfExtents: vec3(9, 9, 9),
    })
  })
})

describe('nesting', () => {
  /** Four top-level platforms named a..d, the shape most of these start from. */
  const four = (): { doc: ReturnType<typeof levelDoc>; level: Level } => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    for (const n of ['a', 'b', 'c', 'd']) doc.setName(doc.place('platform', vec3(0, 0, 0)), n)
    return { doc, level }
  }
  const order = (doc: ReturnType<typeof levelDoc>): string[] =>
    Array.from({ length: doc.count() }, (_, i) => `${'  '.repeat(doc.depthOf(i))}${doc.label(i)}`)

  it('parents one instance under another, and the index follows the depth-first walk', () => {
    const { doc, level } = four()
    // Drop `c` onto `a` as its first child.
    const landed = doc.reparent(2, 0, 0)

    expect(landed, 'right after its new parent').toBe(1)
    expect(order(doc)).toEqual(['a', '  c', 'b', 'd'])
    expect(doc.depthOf(1)).toBe(1)
    expect(doc.parentOf(1)).toBe(0)
    expect(doc.childCount(0)).toBe(1)
    expect(level.instances).toHaveLength(3)
  })

  it('keeps the local transform, so the child sits at that offset from its parent', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(10, 0, 0))
    const child = doc.place('platform', vec3(3, 0, 0))
    doc.reparent(child, 0, 0)

    // Unchanged numbers, new meaning: 3 m along the parent, not 3 m along the world.
    expect(doc.transformOf(1).position).toEqual(vec3(3, 0, 0))
  })

  it('removes the `children` key it emptied, and creates it only when needed', () => {
    const { doc, level } = four()
    expect('children' in level.instances[0]!, 'nothing nested yet').toBe(false)

    doc.reparent(1, 0, 0)
    expect(level.instances[0]!.children).toHaveLength(1)

    doc.reparent(1, null, 4) // back out to the top level
    expect('children' in level.instances[0]!, 'emptied, so the key goes').toBe(false)
  })

  it('refuses to make an instance its own descendant', () => {
    const { doc } = four()
    doc.reparent(1, 0, 0) // b under a
    doc.reparent(2, 1, 0) // c under b  →  a > b > c

    expect(doc.canReparent(0, 0), 'onto itself').toBe(false)
    expect(doc.canReparent(0, 1), 'onto its own child').toBe(false)
    expect(doc.canReparent(0, 2), 'onto its own grandchild').toBe(false)
    expect(doc.canReparent(1, 2), 'a middle node onto its own child').toBe(false)
    expect(doc.canReparent(2, 0), 'a grandchild onto its grandparent is fine').toBe(true)
    expect(doc.canReparent(0, null), 'to the top level, always').toBe(true)

    const before = order(doc)
    expect(doc.reparent(0, 2, 0), 'an illegal move is a no-op').toBe(0)
    expect(order(doc)).toEqual(before)
  })

  it('takes the whole subtree when an instance is removed', () => {
    const { doc } = four()
    doc.reparent(1, 0, 0) // b under a
    doc.reparent(2, 1, 0) // c under b
    expect(doc.count()).toBe(4)

    doc.remove(0) // a, and everything under it
    expect(order(doc)).toEqual(['d'])
  })

  it('duplicates an instance with its children', () => {
    const { doc } = four()
    doc.reparent(1, 0, 0) // b under a

    const copy = doc.duplicate(0)
    expect(order(doc)).toEqual(['a', '  b', 'a', '  b', 'c', 'd'])
    expect(doc.childCount(copy), 'the copy has its own child').toBe(1)
  })

  it('reorders within one parent when reparented to where it already is', () => {
    const { doc } = four()
    doc.reparent(2, 0, 0) // c under a
    doc.reparent(3, 0, 1) // d under a, after c
    expect(order(doc)).toEqual(['a', '  c', '  d', 'b'])

    doc.reparent(2, 0, 0) // d to the front of a's children
    expect(order(doc)).toEqual(['a', '  d', '  c', 'b'])
  })

  it('moves a child out to the top level', () => {
    const { doc, level } = four()
    doc.reparent(1, 0, 0)
    expect(level.instances).toHaveLength(3)

    doc.reparent(1, null, 0)
    expect(order(doc)).toEqual(['b', 'a', 'c', 'd'])
    expect(level.instances).toHaveLength(4)
  })

  it('is flat in prefab mode: nothing to parent, nothing to nest', () => {
    const doc = prefabDoc(inlineInstance('p'))
    expect(doc.depthOf(0)).toBe(0)
    expect(doc.parentOf(0)).toBeNull()
    expect(doc.childCount(0)).toBe(0)
    expect(doc.canReparent(0, null)).toBe(false)
  })
})

describe('names', () => {
  it('falls back to the prefab id until one is typed, and keeps the JSON clean', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))

    expect(doc.nameOf(0), 'nothing typed').toBe('')
    expect(doc.label(0), 'so the display name is what it is').toBe('platform')
    expect('name' in level.instances[0]!, 'and nothing is written').toBe(false)
  })

  it('shows a typed name and stores it on the instance', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))
    doc.place('platform', vec3(4, 0, 0))

    doc.setName(0, 'first gap')

    expect(doc.nameOf(0)).toBe('first gap')
    expect(doc.label(0)).toBe('first gap')
    expect(level.instances[0]!.name).toBe('first gap')
    // The whole point of naming per instance: two placements of one prefab are now distinguishable.
    expect(doc.label(1), 'the sibling is untouched').toBe('platform')
    expect(doc.prefabAt('platform')!.id, 'and the shared definition is not renamed').toBe('platform')
  })

  it('reverts to the fallback when the name is cleared', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('ramp', vec3(0, 0, 0))

    doc.setName(0, 'entry ramp')
    doc.setName(0, '')

    expect(doc.nameOf(0)).toBe('')
    expect(doc.label(0)).toBe('ramp')
    expect('name' in level.instances[0]!, 'the key is removed, not blanked').toBe(false)
  })

  it('names a piece too, so a prefab of three boxes is readable', () => {
    const doc = prefabDoc(inlineInstance('rails'))
    expect(doc.label(0), 'fallback is the collider kind').toBe('box')
    doc.setName(0, 'left rail')
    expect(doc.label(0)).toBe('left rail')
    expect(doc.toJSON()).toMatchObject({ pieces: [{ name: 'left rail' }] })
  })

  it('survives a round trip through validate + JSON', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))
    doc.setName(0, 'start pad')

    const parsed = validateLevel(JSON.parse(JSON.stringify(doc.toJSON())))
    expect(parsed.instances[0]!.name).toBe('start pad')
  })
})

describe('reordering', () => {
  const named = (): ReturnType<typeof levelDoc> => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    for (const n of ['a', 'b', 'c', 'd']) {
      const i = doc.place('platform', vec3(0, 0, 0))
      doc.setName(i, n)
    }
    return doc
  }
  const order = (doc: ReturnType<typeof levelDoc>): string[] =>
    Array.from({ length: doc.count() }, (_, i) => doc.label(i))

  // `to` is an insertion point against the array as it was, which is what a drop between two rows
  // gives. Moving down therefore shifts by one, because removing the item first pulls later indices back.
  it('moves an item down to sit before the given original index', () => {
    const doc = named()
    expect(doc.move(0, 2)).toBe(1)
    expect(order(doc)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('moves an item up', () => {
    const doc = named()
    expect(doc.move(3, 0)).toBe(0)
    expect(order(doc)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('appends when dropped past the last row', () => {
    const doc = named()
    expect(doc.move(0, 4)).toBe(3)
    expect(order(doc)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('is a no-op when dropped either side of its own slot', () => {
    const doc = named()
    expect(doc.move(1, 1)).toBe(1)
    expect(order(doc)).toEqual(['a', 'b', 'c', 'd'])
    expect(doc.move(1, 2), 'inserting before the next row is where it already is').toBe(1)
    expect(order(doc)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('ignores an out-of-range source', () => {
    const doc = named()
    expect(doc.move(9, 0)).toBe(9)
    expect(order(doc)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('reorders pieces in prefab mode too', () => {
    const doc = prefabDoc({
      id: 'p',
      pieces: [
        { collider: { kind: 'box', halfExtents: vec3(1, 1, 1) }, transform: { position: vec3(0, 0, 0) }, name: 'x' },
        { collider: { kind: 'ball', radius: 1 }, transform: { position: vec3(0, 0, 0) }, name: 'y' },
      ],
    })
    expect(doc.move(1, 0)).toBe(0)
    expect([doc.label(0), doc.label(1)]).toEqual(['y', 'x'])
  })

  // Order is load-bearing: checkpoint progression and the movement-base index both follow it.
  it('changes the order the loader sees', () => {
    const doc = named()
    doc.move(3, 0)
    const level = doc.toJSON() as { instances: { name?: string }[] }
    expect(level.instances.map((i) => i.name)).toEqual(['d', 'a', 'b', 'c'])
  })
})

describe('levelDoc: instance overrides', () => {
  it('round-trips a style override without touching the shared definition', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))
    doc.place('platform', vec3(4, 0, 0))

    doc.setProps(0, props({ style: 'hazard' }))

    expect(doc.props(0).style).toBe('hazard')
    expect(level.instances[0]!.style).toBe('hazard')
    expect(doc.meshSpecs(0)[0]!.style).toBe('hazard')
    expect(doc.meshSpecs(1)[0]!.style, 'the other instance keeps the prefab style').not.toBe('hazard')
  })

  it('drops the override rather than writing an empty string', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))

    doc.setProps(0, props({ style: 'hazard' }))
    doc.setProps(0, props({ style: '' }))

    expect('style' in level.instances[0]!, 'no empty key left in the JSON').toBe(false)
  })

  it('writes a behavior override onto the instance, not the prefab', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))
    doc.place('platform', vec3(4, 0, 0))

    doc.setProps(1, props({ behavior: 'move', distance: 5, periodMs: 2000, axis: vec3(1, 0, 0) }))

    expect(level.instances[1]!.behavior).toEqual({ kind: 'move', axis: vec3(1, 0, 0), distance: 5, periodMs: 2000 })
    expect(level.instances[0]!.behavior, 'the first instance stays static').toBeUndefined()
    expect(doc.prefabAt('platform')!.behavior).toBeUndefined()
  })
})

describe('what the editor writes is what the game loads', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('validates and instantiates, references and overrides included', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))
    doc.place('platform', vec3(4, 0, 0))
    doc.place('moving platform', vec3(8, 2, 0))
    doc.place('checkpoint pad', vec3(12, 0, 0))
    doc.setProps(1, props({ style: 'hazard' }))
    doc.setId('gym')

    const json: unknown = JSON.parse(JSON.stringify(doc.toJSON()))
    const parsed = validateLevel(json)
    expect(parsed.id, 'the id follows the save name').toBe('gym')

    const world = createPhysicsWorld({ gravity: { x: 0, y: -30, z: 0 } })
    const loaded = instantiateLevel(world, parsed)
    expect(loaded.visuals.length).toBeGreaterThanOrEqual(4)
    expect(loaded.visuals.some((v) => v.style === 'hazard'), 'the override survived the round trip').toBe(true)
    expect(loaded.triggers.map((t) => t.kind)).toContain('checkpoint')
    expect(loaded.baseIndex(loaded.triggers[0]!.colliderHandle), 'a static pad is no movement base').toBeUndefined()
    world.free()
  })
})

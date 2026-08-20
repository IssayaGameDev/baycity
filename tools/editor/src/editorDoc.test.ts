import { instantiateLevel, moveTrack, validateLevel, type Level, type Prefab } from '@mp/content'
import { vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { DEFAULT_BUMPER_POWER, levelDoc, prefabDoc, type Doc, type ItemProps } from './editorDoc'

const blank = (): Level => ({ id: 'untitled', config: { fallBehavior: 'physical-fall', fallY: -20 }, instances: [] })

const props = (over: Partial<ItemProps> = {}): ItemProps => ({
  pieceLevel: false,
  trigger: 'none',
  bumperPower: DEFAULT_BUMPER_POWER,
  material: '',
  ...over,
})

/**
 * The nth *instance* index. Indices address pieces as well as instances since ADR 0033, so four one-piece
 * platforms number 0, 2, 4, 6 — and every structural edit renumbers. Written as a lookup so the tests say what
 * they mean rather than encoding the interleaving.
 */
const nth = (doc: Doc, n: number): number => {
  let seen = 0
  for (let i = 0; i < doc.count(); i++) {
    if (doc.kindOf(i) !== 'instance') continue
    if (seen === n) return i
    seen += 1
  }
  throw new Error(`no instance #${n}`)
}

/** The instance called `name`. */
const byName = (doc: Doc, name: string): number => {
  for (let i = 0; i < doc.count(); i++) if (doc.kindOf(i) === 'instance' && doc.label(i) === name) return i
  throw new Error(`no instance named ${name}`)
}

/** The first piece of an instance: a node's pieces follow it immediately in the walk. */
const pieceOf = (_doc: Doc, instance: number, p = 0): number => instance + 1 + p

/** Instance labels, indented by depth — the shape these tests are about, with pieces left out. */
const instanceOrder = (doc: Doc): string[] => {
  const out: string[] = []
  for (let i = 0; i < doc.count(); i++) {
    if (doc.kindOf(i) === 'instance') out.push(`${'  '.repeat(doc.depthOf(i))}${doc.label(i)}`)
  }
  return out
}

/** How many placements the level holds, pieces excluded. */
const instanceCount = (doc: Doc): number => {
  let n = 0
  for (let i = 0; i < doc.count(); i++) if (doc.kindOf(i) === 'instance') n += 1
  return n
}


/** A two-piece prefab, so a test can tell "this piece" from "that piece". */
const twoPieceLibrary = (): Prefab => ({
  id: 'pad',
  pieces: [
    { collider: { kind: 'box', halfExtents: vec3(1.5, 0.15, 1.5) }, transform: { position: vec3(0, 0, 0) } },
    { collider: { kind: 'box', halfExtents: vec3(0.5, 1, 0.5) }, transform: { position: vec3(0, 1, 0) } },
  ],
})

const inlineInstance = (id: string, half = vec3(1, 0.5, 1)): Prefab => ({
  id,
  pieces: [{ collider: { kind: 'box', halfExtents: half }, transform: { position: vec3(0, 0, 0) } }],
})

/**
 * The prefab files a level's palette offers. Generators are gone (ADR 0027), so everything placeable is
 * data — which is what these stand in for.
 */
// Material asset ids the fixtures reference. Any string works: the doc stores ids and never resolves
// them, which is the point of referencing an asset rather than naming a palette entry.
const MAT_MOVING = 'mat-moving'
const MAT_CHECKPOINT = 'mat-checkpoint'
const MAT_HAZARD = 'mat-hazard'

const LIBRARY: Record<string, Prefab> = {
  platform: inlineInstance('platform', vec3(1.5, 0.15, 1.5)),
  ramp: inlineInstance('ramp', vec3(1.5, 0.15, 2)),
  'moving platform': {
    id: 'moving platform',
    pieces: [
      {
        collider: { kind: 'box', halfExtents: vec3(1.5, 0.15, 1.5) },
        transform: { position: vec3(0, 0, 0) },
        visual: { kind: 'primitive', material: MAT_MOVING },
      },
    ],
    behavior: { kind: 'track', keys: moveTrack(vec3(0, 0, 0), vec3(0, 1, 0), 1.5, 4000) },
  },
  'checkpoint pad': {
    id: 'checkpoint pad',
    pieces: [
      {
        collider: { kind: 'box', halfExtents: vec3(1.5, 0.1, 1.5) },
        transform: { position: vec3(0, 0, 0) },
        visual: { kind: 'primitive', material: MAT_CHECKPOINT },
        trigger: { kind: 'checkpoint' },
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
    prefabDoc(shared).setProps(0, props({ pieceLevel: true, material: MAT_HAZARD }))

    // A piece draws itself now, so the mesh comes from the piece node rather than from its placement.
    expect(doc.meshSpecs(pieceOf(doc, nth(doc, 0)))[0]!.material).toBe(MAT_HAZARD)
    expect(doc.meshSpecs(pieceOf(doc, nth(doc, 1)))[0]!.material, 'the second instance followed untouched').toBe(MAT_HAZARD)
  })

  it('keeps the reference when an instance is duplicated', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))
    doc.duplicate(nth(doc, 0))

    expect(level.instances[1]!.prefab, 'still an id, not an inlined clone').toBe('platform')
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
    expect(doc.meshSpecs(pieceOf(doc, 0))[0]!.collider).toEqual({ kind: 'box', halfExtents: vec3(2, 0.25, 2) })
    expect(level.instances[0]!.transform.position, 'placement untouched').toEqual(vec3(1, 2, 3))
    expect(doc.extract(0), 'already a reference — nothing to do').toBeNull()
  })

  it('suffixes an extracted prefab whose id is taken by different content', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))
    // A different shape claiming the name the placed prefab already holds.
    level.instances.push({ prefab: inlineInstance('platform', vec3(9, 9, 9)), transform: { position: vec3(0, 0, 0) } })

    expect(doc.extract(nth(doc, 1))).toBe('platform-2')
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
  const order = instanceOrder

  it('parents one instance under another, and the index follows the depth-first walk', () => {
    const { doc, level } = four()
    // Drop `c` onto `a` as its first child.
    const landed = doc.reparent(byName(doc, 'c'), byName(doc, 'a'), 0)

    // `a` is 0, its own piece is 1, so its first child lands at 2.
    expect(landed, "after its new parent and that parent's pieces").toBe(2)
    expect(order(doc)).toEqual(['a', '  c', 'b', 'd'])
    expect(doc.depthOf(landed)).toBe(1)
    expect(doc.parentOf(landed)).toBe(0)
    expect(doc.childCount(0), 'one piece and one child').toBe(2)
    expect(level.instances).toHaveLength(3)
  })

  it('keeps the local transform, so the child sits at that offset from its parent', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(10, 0, 0))
    const child = doc.place('platform', vec3(3, 0, 0))
    const landed = doc.reparent(child, nth(doc, 0), 0)

    // Unchanged numbers, new meaning: 3 m along the parent, not 3 m along the world.
    expect(doc.transformOf(landed).position).toEqual(vec3(3, 0, 0))
  })

  it('removes the `children` key it emptied, and creates it only when needed', () => {
    const { doc, level } = four()
    expect('children' in level.instances[0]!, 'nothing nested yet').toBe(false)

    const landed = doc.reparent(byName(doc, 'b'), byName(doc, 'a'), 0)
    expect(level.instances[0]!.children).toHaveLength(1)

    doc.reparent(landed, null, 4) // back out to the top level
    expect('children' in level.instances[0]!, 'emptied, so the key goes').toBe(false)
  })

  it('refuses to make an instance its own descendant', () => {
    const { doc } = four()
    doc.reparent(byName(doc, 'b'), byName(doc, 'a'), 0)
    doc.reparent(byName(doc, 'c'), byName(doc, 'b'), 0) //  a > b > c
    const [a, b, c] = [byName(doc, 'a'), byName(doc, 'b'), byName(doc, 'c')]

    expect(doc.canReparent(a, a), 'onto itself').toBe(false)
    expect(doc.canReparent(a, b), 'onto its own child').toBe(false)
    expect(doc.canReparent(a, c), 'onto its own grandchild').toBe(false)
    expect(doc.canReparent(b, c), 'a middle node onto its own child').toBe(false)
    expect(doc.canReparent(c, a), 'a grandchild onto its grandparent is fine').toBe(true)
    expect(doc.canReparent(a, null), 'to the top level, always').toBe(true)
    // A piece is not a placement: it can be neither moved nor made a parent.
    expect(doc.canReparent(pieceOf(doc, a), null), 'a piece cannot be re-parented').toBe(false)
    expect(doc.canReparent(b, pieceOf(doc, a)), 'nor can anything be parented to one').toBe(false)

    const before = order(doc)
    expect(doc.reparent(a, c, 0), 'an illegal move is a no-op').toBe(a)
    expect(order(doc)).toEqual(before)
  })

  it('takes the whole subtree when an instance is removed', () => {
    const { doc } = four()
    doc.reparent(byName(doc, 'b'), byName(doc, 'a'), 0)
    doc.reparent(byName(doc, 'c'), byName(doc, 'b'), 0)
    expect(instanceCount(doc)).toBe(4)

    doc.remove(byName(doc, 'a')) // a, and everything under it
    expect(order(doc)).toEqual(['d'])
  })

  it('duplicates an instance with its children', () => {
    const { doc } = four()
    doc.reparent(byName(doc, 'b'), byName(doc, 'a'), 0)

    const copy = doc.duplicate(byName(doc, 'a'))
    expect(order(doc)).toEqual(['a', '  b', 'a', '  b', 'c', 'd'])
    expect(doc.childCount(copy), 'the copy has its own piece and child').toBe(2)
  })

  it('reorders within one parent when reparented to where it already is', () => {
    const { doc } = four()
    doc.reparent(byName(doc, 'c'), byName(doc, 'a'), 0)
    doc.reparent(byName(doc, 'd'), byName(doc, 'a'), 1)
    expect(order(doc)).toEqual(['a', '  c', '  d', 'b'])

    doc.reparent(byName(doc, 'd'), byName(doc, 'a'), 0)
    expect(order(doc)).toEqual(['a', '  d', '  c', 'b'])
  })

  it('moves a child out to the top level', () => {
    const { doc, level } = four()
    doc.reparent(byName(doc, 'b'), byName(doc, 'a'), 0)
    expect(level.instances).toHaveLength(3)

    doc.reparent(byName(doc, 'b'), null, 0)
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
    expect(doc.label(nth(doc, 1)), 'the sibling is untouched').toBe('platform')
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
  const order = (doc: Doc): string[] => instanceOrder(doc)

  // `to` is an insertion point against the array as it was, which is what a drop between two rows
  // gives. Moving down therefore shifts by one, because removing the item first pulls later indices back.
  it('moves an item down to sit before the given original index', () => {
    const doc = named()
    // `to` is a *sibling* position; the return is a node index, and `a` is the second instance afterwards.
    expect(doc.move(nth(doc, 0), 2)).toBe(nth(doc, 1))
    expect(order(doc)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('moves an item up', () => {
    const doc = named()
    expect(doc.move(nth(doc, 3), 0)).toBe(0)
    expect(order(doc)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('appends when dropped past the last row', () => {
    const doc = named()
    expect(doc.move(nth(doc, 0), 4)).toBe(nth(doc, 3))
    expect(order(doc)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('is a no-op when dropped either side of its own slot', () => {
    const doc = named()
    expect(doc.move(nth(doc, 1), 1)).toBe(nth(doc, 1))
    expect(order(doc)).toEqual(['a', 'b', 'c', 'd'])
    expect(doc.move(nth(doc, 1), 2), 'inserting before the next row is where it already is').toBe(nth(doc, 1))
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
    doc.move(nth(doc, 3), 0)
    const level = doc.toJSON() as { instances: { name?: string }[] }
    expect(level.instances.map((i) => i.name)).toEqual(['d', 'a', 'b', 'c'])
  })
})

describe('levelDoc: instance overrides', () => {
  it('round-trips a material override without touching the shared definition', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))
    doc.place('platform', vec3(4, 0, 0))

    const [first, second] = [nth(doc, 0), nth(doc, 1)]
    doc.setProps(first, props({ material: MAT_HAZARD }))

    expect(doc.props(first).material).toBe(MAT_HAZARD)
    expect(level.instances[0]!.material).toBe(MAT_HAZARD)
    // The override reaches the piece's mesh, which is where the material is actually read.
    expect(doc.meshSpecs(pieceOf(doc, first))[0]!.material).toBe(MAT_HAZARD)
    expect(doc.meshSpecs(pieceOf(doc, second))[0]!.material, "the other instance keeps the prefab's").not.toBe(MAT_HAZARD)
  })

  it('drops the override rather than writing an empty string', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))

    doc.setProps(0, props({ material: MAT_HAZARD }))
    doc.setProps(0, props({ material: '' }))

    expect('material' in level.instances[0]!, 'no empty key left in the JSON').toBe(false)
  })

  it('writes a track onto the instance, not the prefab', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))
    doc.place('platform', vec3(4, 0, 0))

    doc.setTrack(nth(doc, 1), { keys: moveTrack(vec3(4, 0, 0), vec3(1, 0, 0), 5, 2000), loop: 'loop', phaseMs: 0 })

    expect(level.instances[1]!.behavior).toMatchObject({ kind: 'track' })
    expect(level.instances[0]!.behavior, 'the first instance stays static').toBeUndefined()
    expect(doc.prefabAt('platform')!.behavior, 'and the shared definition is untouched').toBeUndefined()
  })

  // `loop` and `phaseMs` at their defaults carry no information, so writing them would put noise in every
  // authored file. Round-tripping through `trackOf` has to give them back anyway.
  it('leaves default loop and phase out of the JSON but reads them back', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))

    doc.setTrack(0, { keys: [{ t: 0 }, { t: 1000, position: vec3(0, 2, 0) }], loop: 'loop', phaseMs: 0 })
    expect(Object.keys(level.instances[0]!.behavior!)).toEqual(['kind', 'keys'])
    expect(doc.trackOf(0)).toMatchObject({ loop: 'loop', phaseMs: 0 })

    doc.setTrack(0, { keys: [{ t: 0 }, { t: 1000, position: vec3(0, 2, 0) }], loop: 'pingPong', phaseMs: 250 })
    expect(level.instances[0]!.behavior).toMatchObject({ loop: 'pingPong', phaseMs: 250 })
  })

  it('stores keys in time order however they arrive, since the timeline drags them past each other', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))

    doc.setTrack(0, { keys: [{ t: 900 }, { t: 0 }, { t: 400 }], loop: 'loop', phaseMs: 0 })
    expect(doc.trackOf(0)!.keys.map((k) => k.t)).toEqual([0, 400, 900])
  })

  it('removes the behavior for a null track rather than writing an empty one', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))

    doc.setTrack(0, { keys: [{ t: 0 }, { t: 500, position: vec3(0, 1, 0) }], loop: 'loop', phaseMs: 0 })
    doc.setTrack(0, null)
    expect('behavior' in level.instances[0]!, 'no empty key left in the JSON').toBe(false)
    expect(doc.trackOf(0)).toBeNull()
  })

  // The scrub, and what the gizmo writes back into a key.
  it('poses an item at a track time, and at its authored transform when static', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(3, 0, 0))

    expect(doc.poseOf(0, 1234).position, 'static: the authored transform').toEqual(vec3(3, 0, 0))

    doc.setTrack(0, { keys: moveTrack(vec3(3, 0, 0), vec3(0, 1, 0), 4, 1000), loop: 'loop', phaseMs: 0 })
    expect(doc.poseOf(0, 500).position.y, 'half a period is full travel').toBeCloseTo(4, 9)
    expect(doc.poseOf(0, 0).position.y, 'and it starts home').toBeCloseTo(0, 9)
  })

  it('reads a piece track in prefab mode', () => {
    const prefab = inlineInstance('p')
    const doc = prefabDoc(prefab)
    expect(doc.trackOf(0)).toBeNull()

    doc.setTrack(0, { keys: [{ t: 0, position: vec3(0, 0, 0) }, { t: 800, position: vec3(0, 2, 0) }], loop: 'pingPong', phaseMs: 0 })
    expect(prefab.pieces[0]!.behavior).toMatchObject({ kind: 'track', loop: 'pingPong' })
    expect(doc.poseOf(0, 800).position.y).toBeCloseTo(2, 9)
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
    doc.setProps(1, props({ material: MAT_HAZARD }))
    doc.setId('gym')

    const json: unknown = JSON.parse(JSON.stringify(doc.toJSON()))
    const parsed = validateLevel(json)
    expect(parsed.id, 'the id follows the save name').toBe('gym')

    const world = createPhysicsWorld({ gravity: { x: 0, y: -30, z: 0 } })
    const loaded = instantiateLevel(world, parsed)
    expect(loaded.visuals.length).toBeGreaterThanOrEqual(4)
    expect(loaded.visuals.some((v) => v.material === MAT_HAZARD), 'the override survived the round trip').toBe(true)
    expect(loaded.triggers.map((t) => t.kind)).toContain('checkpoint')
    expect(loaded.baseIndex(loaded.triggers[0]!.colliderHandle), 'a static pad is no movement base').toBeUndefined()
    world.free()
  })
})

describe('clipboard', () => {
  it('copies an instance detached from the document', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(1, 2, 3))
    doc.setName(0, 'first')

    const item = doc.copy(0)!
    doc.remove(0)

    expect(doc.count(), 'the original is gone').toBe(0)
    expect(item.kind).toBe('instance')
    expect(doc.paste(item, null), 'and the copy still pastes').toBe(0)
    expect(doc.nameOf(0)).toBe('first')
    expect(doc.transformOf(0).position).toEqual(vec3(1, 2, 3))
  })

  it('copies the whole subtree, not just the root', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))
    const second = doc.place('platform', vec3(4, 0, 0))
    doc.reparent(second, nth(doc, 0), 0)

    const item = doc.copy(nth(doc, 0))!
    const pasted = doc.paste(item, null)

    // Original parent + child, then the pasted parent + its child.
    expect(instanceCount(doc)).toBe(4)
    expect(doc.childCount(pasted), 'the pasted copy kept its piece and its child').toBe(2)
  })

  /**
   * The reason a clip carries prefab definitions. Without them, pasting into a level whose table has no such
   * id would leave a reference nothing resolves — and `validateLevel` rejects exactly that.
   */
  it('pastes into another level, carrying the prefab it references', () => {
    const source = blank()
    const from = levelDoc(source, LIBRARY)
    from.place('moving platform', vec3(0, 0, 0))
    const item = from.copy(nth(from, 0))!

    const target = blank()
    const to = levelDoc(target, {})
    expect(to.paste(item, null)).toBe(0)

    expect(() => validateLevel(structuredClone(target)), 'every reference resolves').not.toThrow()
    expect(to.refOf(0), 'and it is still a reference, not inlined').not.toBeNull()
    expect(to.meshSpecs(pieceOf(to, 0)).length, 'and its piece draws').toBeGreaterThan(0)
  })

  it('reuses the table entry when pasting back into the level it came from', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))
    const before = Object.keys(level.prefabs ?? {}).length

    doc.paste(doc.copy(nth(doc, 0))!, null)

    expect(Object.keys(level.prefabs ?? {}).length, 'an identical definition is not duplicated').toBe(before)
    expect(doc.refOf(nth(doc, 1))).toBe(doc.refOf(nth(doc, 0)))
  })

  it('pastes into an instance as a child when given one', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))
    const item = doc.copy(0)!

    const pasted = doc.paste(item, 0)

    expect(doc.parentOf(pasted)).toBe(0)
    expect(doc.depthOf(pasted)).toBe(1)
  })

  it('refuses a paste of the wrong kind rather than guessing', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))
    const instance = doc.copy(0)!

    const prefab = inlineInstance('p')
    const pieces = prefabDoc(prefab)
    expect(pieces.paste(instance, null), 'an instance is not a piece').toBe(-1)
    expect(prefab.pieces).toHaveLength(1)

    const piece = pieces.copy(0)!
    expect(doc.paste(piece, null), 'nor the other way round').toBe(-1)
  })

  it('copies and pastes a piece in prefab mode', () => {
    const prefab = inlineInstance('p')
    const doc = prefabDoc(prefab)
    doc.setName(0, 'rail')

    const pasted = doc.paste(doc.copy(0)!, null)

    expect(doc.count()).toBe(2)
    expect(pasted).toBe(1)
    expect(doc.nameOf(1)).toBe('rail')
  })

  it('returns null for an index that is not there', () => {
    const doc = levelDoc(blank(), LIBRARY)
    expect(doc.copy(0)).toBeNull()
  })

  it('carries a track along, since a copied mover has to keep moving', () => {
    const level = blank()
    const doc = levelDoc(level, LIBRARY)
    doc.place('platform', vec3(0, 0, 0))
    doc.setTrack(nth(doc, 0), { keys: moveTrack(vec3(0, 0, 0), vec3(0, 1, 0), 2, 1000), loop: 'pingPong', phaseMs: 100 })

    doc.paste(doc.copy(nth(doc, 0))!, null)
    const copy = nth(doc, 1)

    expect(doc.trackOf(copy)).toMatchObject({ loop: 'pingPong', phaseMs: 100 })
    // The far key is at 500ms and the phase shifts the clock forward by 100, so the peak arrives at 400.
    expect(doc.poseOf(copy, 400).position.y).toBeCloseTo(2, 9)
    expect(doc.poseOf(copy, 500).position.y, 'and it is on the way back by 500').toBeLessThan(2)
  })
})

describe('per-instance prefab overrides (ADR 0033)', () => {
  /** One placement of a two-piece prefab, with the indices worth naming. */
  const placed = () => {
    const level = blank()
    const doc = levelDoc(level, { pad: twoPieceLibrary() })
    doc.place('pad', vec3(0, 0, 0))
    const instance = nth(doc, 0)
    return { level, doc, instance, piece: pieceOf(doc, instance) }
  }

  it('writes a material edit onto the placement, not the shared prefab', () => {
    const { level, doc, piece } = placed()
    doc.setProps(piece, props({ pieceLevel: true, material: MAT_HAZARD }))

    expect(doc.props(piece).material, 'the piece reads back its own value').toBe(MAT_HAZARD)
    expect(doc.prefabAt('pad')!.pieces[0]!.visual, 'and the prefab is untouched').toBeUndefined()
    expect(level.instances[0]!.overrides, 'stored against the placement').toBeDefined()
  })

  it('does not touch a second placement of the same prefab', () => {
    const level = blank()
    const doc = levelDoc(level, { pad: twoPieceLibrary() })
    doc.place('pad', vec3(0, 0, 0))
    doc.place('pad', vec3(8, 0, 0))
    const [a, b] = [nth(doc, 0), nth(doc, 1)]

    doc.setProps(pieceOf(doc, a), props({ pieceLevel: true, material: MAT_HAZARD }))

    expect(doc.props(pieceOf(doc, a)).material).toBe(MAT_HAZARD)
    expect(doc.props(pieceOf(doc, b)).material, 'the sibling placement still matches the prefab').toBe('')
  })

  // Minting on demand is why no authored content had to migrate: a piece becomes referenceable exactly when
  // something first refers to it.
  it('mints a piece id when the first override needs a name', () => {
    const { doc, piece } = placed()
    expect(doc.prefabAt('pad')!.pieces[0]!.id, 'no id until something refers to it').toBeUndefined()

    doc.setProps(piece, props({ pieceLevel: true, material: MAT_HAZARD }))

    const id = doc.prefabAt('pad')!.pieces[0]!.id
    expect(id).toBeDefined()
    const json = doc.toJSON() as Level
    expect(Object.keys(json.instances[0]!.overrides!), 'and the override is keyed by it').toEqual([id!])
  })

  it('lists which fields are overridden, and nothing before any edit', () => {
    const { doc, piece } = placed()
    expect(doc.overridesOf(piece)).toEqual([])

    doc.setProps(piece, props({ pieceLevel: true, material: MAT_HAZARD }))
    // `setProps` writes both of the fields it owns, so a material edit records the trigger too.
    expect(doc.overridesOf(piece)).toEqual(['material', 'trigger'])

    doc.setTransform(piece, { position: vec3(1, 2, 3) })
    expect(doc.overridesOf(piece)).toEqual(['transform', 'material', 'trigger'])
  })

  it('reverts one field and leaves the others', () => {
    const { doc, piece } = placed()
    doc.setProps(piece, props({ pieceLevel: true, material: MAT_HAZARD }))
    doc.setTransform(piece, { position: vec3(1, 2, 3) })

    doc.revert(piece, 'transform')

    expect(doc.overridesOf(piece)).not.toContain('transform')
    expect(doc.overridesOf(piece)).toContain('material')
    expect(doc.transformOf(piece).position, 'back to what the prefab says').toEqual(vec3(0, 0, 0))
  })

  it('reverts everything, and leaves no husk in the JSON', () => {
    const { level, doc, piece } = placed()
    doc.setProps(piece, props({ pieceLevel: true, material: MAT_HAZARD }))
    doc.setTransform(piece, { position: vec3(1, 2, 3) })

    doc.revert(piece)

    expect(doc.overridesOf(piece)).toEqual([])
    expect('overrides' in level.instances[0]!, 'the empty map goes too').toBe(false)
  })

  it('applies an override to the prefab, so every instance follows and this one is clean', () => {
    const level = blank()
    const doc = levelDoc(level, { pad: twoPieceLibrary() })
    doc.place('pad', vec3(0, 0, 0))
    doc.place('pad', vec3(8, 0, 0))
    const [a, b] = [nth(doc, 0), nth(doc, 1)]
    doc.setProps(pieceOf(doc, a), props({ pieceLevel: true, material: MAT_HAZARD }))

    doc.applyToPrefab(pieceOf(doc, a))

    expect(doc.overridesOf(pieceOf(doc, a)), 'no longer an override').toEqual([])
    expect(doc.props(pieceOf(doc, a)).material, 'still what was chosen').toBe(MAT_HAZARD)
    expect(doc.props(pieceOf(doc, b)).material, 'and the other instance followed').toBe(MAT_HAZARD)
    expect('overrides' in level.instances[0]!).toBe(false)
  })

  it('overrides a track on one placement without moving the others', () => {
    const level = blank()
    const doc = levelDoc(level, { pad: twoPieceLibrary() })
    doc.place('pad', vec3(0, 0, 0))
    doc.place('pad', vec3(8, 0, 0))
    const [a, b] = [nth(doc, 0), nth(doc, 1)]

    doc.setTrack(pieceOf(doc, a), { keys: moveTrack(vec3(0, 0, 0), vec3(0, 1, 0), 3, 1000), loop: 'loop', phaseMs: 0 })

    expect(doc.poseOf(pieceOf(doc, a), 500).position.y, 'this one moves').toBeCloseTo(3, 9)
    expect(doc.poseOf(pieceOf(doc, b), 500).position.y, 'that one does not').toBeCloseTo(0, 9)
  })

  // Absence means inherit, so "does not move here" needs a value of its own.
  it('says static rather than nothing when a track is cleared on a placement', () => {
    const level = blank()
    const doc = levelDoc(level, { pad: twoPieceLibrary() })
    doc.place('pad', vec3(0, 0, 0))
    const piece = pieceOf(doc, nth(doc, 0))
    doc.prefabAt('pad')!.pieces[0]!.behavior = { kind: 'track', keys: moveTrack(vec3(0, 0, 0), vec3(0, 1, 0), 3, 1000) }

    doc.setTrack(piece, null)

    expect(doc.trackOf(piece), 'no motion here').toBeNull()
    expect(doc.overridesOf(piece), 'recorded as an override, not as silence').toContain('behavior')
  })

  it('survives a round trip through validate and JSON', () => {
    const { doc, piece } = placed()
    doc.setProps(piece, props({ pieceLevel: true, material: MAT_HAZARD }))
    doc.setTransform(piece, { position: vec3(1, 2, 3) })

    const parsed = validateLevel(JSON.parse(JSON.stringify(doc.toJSON())))
    const reopened = levelDoc(parsed, {})
    const reopenedPiece = pieceOf(reopened, nth(reopened, 0))
    expect(reopened.overridesOf(reopenedPiece)).toEqual(['transform', 'material', 'trigger'])
    expect(reopened.transformOf(reopenedPiece).position).toEqual(vec3(1, 2, 3))
  })

  it('has nothing to override in prefab mode, where the piece is the definition', () => {
    const doc = prefabDoc(twoPieceLibrary())
    expect(doc.overridesOf(0)).toEqual([])
    doc.revert(0)
    doc.applyToPrefab(0)
    expect(doc.count(), 'and neither is a no-op that breaks anything').toBe(2)
  })
})

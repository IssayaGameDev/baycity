import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  COLLIDER,
  MATERIAL_OVERRIDE,
  SPAWN,
  TRACK,
  MESH,
  RENDERER,
  instantiateLevel,
  moveTrack,
  validateLevel,
  type ComponentData,
  type Node,
  type Level,
} from '@mp/content'
import { Bumper, Checkpoint, DEFAULT_REGISTRY, ENGINE_COMPONENTS, GAMEPLAY_COMPONENTS, Hazard, createRegistry, defineComponent } from '@mp/components'
import { vec3, type Vec3 } from '@mp/core'

import { levelDoc, prefabDoc, type Doc } from './editorDoc'

/**
 * The editor document over a node tree (PLAN-component-system, stage C1).
 *
 * Nodes are looked up **by name** rather than by literal index wherever the shape is not the point. Indices
 * interleave what a node inherits from its prefab with its own children, so a literal is a claim about tree
 * shape that any structural edit invalidates — which is exactly how the piece-shaped version of these tests
 * broke when pieces became addressable.
 */

const ZERO: Vec3 = { x: 0, y: 0, z: 0 }
const BOX = { kind: 'box', halfExtents: vec3(1, 0.5, 1) }
const MAT_A = 'aaaaaaaaaaaaaaaa'
const MAT_B = 'bbbbbbbbbbbbbbbb'

const comp = (id: string, type: string, params: Record<string, unknown> = {}): ComponentData => ({ id, type, params })

/** A solid, visible node — the shape every migrated piece became. */
const solid = (id: string, position: Vec3): Node => ({
  id,
  name: id,
  transform: { position },
  components: [comp(`${id}-col`, COLLIDER, { shape: BOX, center: ZERO }), comp(`${id}-vis`, RENDERER, { material: '' })],
})

const blank = (): Level => ({ id: 'lv', config: {}, nodes: [] })

/** A two-node prefab: a root carrying only a transform, and a pad under it carrying the geometry. */
const padPrefab = (): Node => ({ id: 'root', name: 'pad', transform: { position: ZERO }, components: [], children: [solid('pad', ZERO)] })

const library = (): Record<string, Node> => ({ pad: padPrefab() })

const named = (doc: Doc, name: string): number => {
  for (let i = 0; i < doc.count(); i++) if (doc.label(i) === name) return i
  throw new Error(`no node named ${name}`)
}
const labels = (doc: Doc): string[] => Array.from({ length: doc.count() }, (_, i) => doc.label(i))
const typesOn = (doc: Doc, i: number): string[] => doc.components(i).map((c) => c.type)
const idOf = (doc: Doc, i: number, type: string): string => {
  const found = doc.components(i).find((c) => c.type === type)
  if (found === undefined) throw new Error(`no ${type} on node ${i}`)
  return found.id
}
const paramOn = (doc: Doc, i: number, type: string, key: string): unknown => doc.components(i).find((c) => c.type === type)?.params[key]

/** A level with one placement of `pad`: index 0 is the placement, index 1 the pad it inherits. */
const placed = (): { level: Level; doc: Doc } => {
  const level = blank()
  const doc = levelDoc(level, library())
  doc.place('pad', vec3(0, 0, 0))
  return { level, doc }
}

describe('addressing a node tree', () => {
  it('lists a placement, then what it inherits, then its own children', () => {
    const { doc } = placed()
    doc.paste(doc.copy(0)!, 0)
    expect(doc.count(), 'placement, inherited pad, pasted child, its inherited pad').toBe(4)
    expect(doc.depthOf(0)).toBe(0)
    expect(doc.depthOf(1)).toBe(1)
    expect(doc.parentOf(1)).toBe(0)
    expect(doc.parentOf(0)).toBeNull()
  })

  it('calls an inherited node inherited, and a placement its own', () => {
    const { doc } = placed()
    expect(doc.kindOf(0)).toBe('own')
    expect(doc.kindOf(1)).toBe('inherited')
  })

  it('counts what one twist opens: the prefab’s nodes and the placement’s children alike', () => {
    const { doc } = placed()
    expect(doc.childCount(0), 'one inherited pad').toBe(1)
    expect(doc.childCount(1), 'and nothing under the pad').toBe(0)
  })

  it('keys UI state by a sibling path, so an edit elsewhere does not shuffle it', () => {
    const { doc } = placed()
    expect(doc.pathOf(0)).toBe('0')
    expect(doc.pathOf(1)).toBe('0#0')
  })

  it('falls back to the prefab key when nothing is named, and back again when a name is cleared', () => {
    const { doc } = placed()
    expect(doc.label(0), 'the placement shows the prefab it references').toBe('pad')
    doc.setName(0, 'first gap')
    expect(doc.label(0)).toBe('first gap')
    expect(doc.nameOf(0), 'the typed name, so the field can show the fallback as a placeholder').toBe('first gap')
    doc.setName(0, '')
    expect(doc.label(0)).toBe('pad')
  })

  it('falls back to the collider shape for a node with no name', () => {
    const doc = levelDoc(blank(), {})
    const i = doc.placeModel('m', vec3(0, 0, 0))
    expect(doc.label(i)).toBe('box')
  })
})

describe('placing', () => {
  it('interns the prefab as a copy, so deleting the file cannot empty the level', () => {
    const lib = library()
    const doc = levelDoc(blank(), lib)
    doc.place('pad', vec3(1, 0, 0))
    delete lib['pad']
    expect(doc.prefabAt('pad'), 'the level carries its own copy').toBeDefined()
  })

  it('shares one table entry when the same thing is placed twice', () => {
    const level = blank()
    const doc = levelDoc(level, library())
    doc.place('pad', vec3(0, 0, 0))
    doc.place('pad', vec3(4, 0, 0))
    expect(Object.keys(level.prefabs ?? {})).toEqual(['pad'])
    expect(doc.refCount('pad')).toBe(2)
  })

  it('refuses a name the library no longer has, rather than throwing', () => {
    expect(levelDoc(blank(), {}).place('ghost', vec3(0, 0, 0))).toBe(-1)
  })

  // The bug behind commit 0fc0b9f: a prefab file shipped carrying someone else's name.
  it('names a placed prefab by its file, not by a name stored inside it', () => {
    const doc = levelDoc(blank(), {})
    doc.placePrefab({ ...padPrefab(), name: 'FastElevator' }, 'AlternatingDanger', vec3(0, 0, 0))
    expect(doc.prefabAt('AlternatingDanger')).toBeDefined()
    expect(doc.prefabAt('FastElevator')).toBeUndefined()
    expect(doc.refOf(0)).toBe('AlternatingDanger')
  })

  it('gives two files with colliding stored names two table entries', () => {
    const doc = levelDoc(blank(), {})
    doc.placePrefab({ ...padPrefab(), name: 'stale' }, 'one', vec3(0, 0, 0))
    doc.placePrefab({ ...padPrefab(), name: 'stale', children: [solid('other', ZERO)] }, 'two', vec3(4, 0, 0))
    expect(doc.prefabAt('one')).toBeDefined()
    expect(doc.prefabAt('two')).toBeDefined()
  })

  it('places a model as a node with the mesh and an authored box', () => {
    const doc = levelDoc(blank(), {})
    const i = doc.placeModel('modelasset', vec3(0, 0, 0))
    // What it collides as, what it looks like, that it draws (ADR 0039). Visual is not collision (ADR 0014).
    expect(typesOn(doc, i)).toEqual([COLLIDER, MESH, RENDERER])
    expect(paramOn(doc, i, MESH, 'model')).toBe('modelasset')
  })

  it('offers only this level’s own table in the palette', () => {
    expect(placed().doc.palette()).toEqual(['pad'])
  })
})

describe('structure', () => {
  it('takes the subtree with a deleted node', () => {
    const { doc } = placed()
    doc.paste(doc.copy(0)!, 0)
    expect(doc.count()).toBe(4)
    doc.remove(0)
    expect(doc.count()).toBe(0)
  })

  it('refuses to delete, reorder or copy an inherited node', () => {
    const { doc } = placed()
    expect(doc.kindOf(1)).toBe('inherited')
    doc.remove(1)
    expect(doc.count(), 'still there — its place belongs to the prefab').toBe(2)
    expect(doc.duplicate(1)).toBe(1)
    expect(doc.copy(1)).toBeNull()
    expect(doc.canReparent(1, null)).toBe(false)
  })

  it('re-mints ids when duplicating, so the copy is a distinct node', () => {
    const { level, doc } = placed()
    doc.duplicate(0)
    expect(new Set(level.nodes.map((n) => n.id)).size, 'two placements, two ids').toBe(2)
  })

  it('keeps a duplicate pointing at the same shared definition', () => {
    const { doc } = placed()
    doc.duplicate(0)
    expect(doc.refCount('pad')).toBe(2)
  })

  it('never lets a node become its own ancestor', () => {
    const doc = levelDoc(blank(), {})
    doc.placeModel('m', vec3(0, 0, 0))
    doc.placeModel('m', vec3(4, 0, 0))
    doc.reparent(1, 0, 0)
    expect(doc.canReparent(0, 1), 'a parent cannot move under its own child').toBe(false)
    expect(doc.canReparent(0, 0)).toBe(false)
  })

  it('keeps the local transform when re-parenting, so the node lands at that offset', () => {
    const doc = levelDoc(blank(), {})
    doc.placeModel('m', vec3(0, 0, 0))
    doc.placeModel('m', vec3(4, 0, 0))
    const moved = doc.reparent(1, 0, 0)
    expect(doc.transformOf(moved).position).toEqual(vec3(4, 0, 0))
    expect(doc.parentOf(moved)).toBe(0)
  })

  it('leaves no empty children array behind after a move out', () => {
    const level = blank()
    const doc = levelDoc(level, {})
    doc.placeModel('m', vec3(0, 0, 0))
    doc.placeModel('m', vec3(4, 0, 0))
    doc.reparent(1, 0, 0)
    doc.reparent(1, null, 0)
    expect('children' in (level.nodes[0] ?? {}), 'the husk goes too').toBe(false)
  })

  it('reorders within a sibling list, which decides checkpoint progression', () => {
    const doc = levelDoc(blank(), {})
    doc.placeModel('a', vec3(0, 0, 0))
    doc.placeModel('b', vec3(1, 0, 0))
    doc.setName(0, 'a')
    doc.setName(1, 'b')
    doc.move(1, 0)
    expect(labels(doc)).toEqual(['b', 'a'])
  })
})

describe('components', () => {
  it('adds one at its declared defaults', () => {
    const doc = levelDoc(blank(), {})
    const i = doc.placeModel('m', vec3(0, 0, 0))
    doc.addComponent(i, Bumper.type)
    expect(paramOn(doc, i, Bumper.type, 'power'), 'the schema owns the default, not the editor').toBe(26)
  })

  it('refuses a second singleton and allows a second collider', () => {
    const doc = levelDoc(blank(), {})
    const i = doc.placeModel('m', vec3(0, 0, 0))
    expect(doc.canAdd(i, RENDERER), 'already has one').toBe(false)
    expect(doc.addComponent(i, RENDERER)).toBeNull()
    expect(doc.canAdd(i, COLLIDER), 'a node holds as many as it likes').toBe(true)
    expect(doc.addComponent(i, COLLIDER)).not.toBeNull()
    expect(typesOn(doc, i).filter((t) => t === COLLIDER)).toHaveLength(2)
  })

  it('patches some parameters and leaves the rest', () => {
    const doc = levelDoc(blank(), {})
    const i = doc.placeModel('m', vec3(0, 0, 0))
    doc.setParams(i, idOf(doc, i, RENDERER), { material: MAT_A })
    expect(paramOn(doc, i, RENDERER, 'material')).toBe(MAT_A)
    expect(paramOn(doc, i, MESH, 'model'), 'a different component, untouched').toBe('m')
  })

  it('removes one', () => {
    const doc = levelDoc(blank(), {})
    const i = doc.placeModel('m', vec3(0, 0, 0))
    doc.removeComponent(i, idOf(doc, i, RENDERER))
    expect(typesOn(doc, i)).toEqual([COLLIDER, MESH])
  })

  // Unity's rule: geometry with nothing to render it shows nothing (ADR 0039).
  it('draws nothing once the Renderer is gone, even with a Mesh still there', () => {
    const doc = levelDoc(blank(), {})
    const i = doc.placeModel('m', vec3(0, 0, 0))
    expect(doc.meshSpecs(i)).toHaveLength(1)
    doc.removeComponent(i, idOf(doc, i, RENDERER))
    expect(doc.meshSpecs(i)).toEqual([])
  })

  it('draws the colliders once the Mesh is gone, since the Renderer still says to draw', () => {
    const doc = levelDoc(blank(), {})
    const i = doc.placeModel('m', vec3(0, 0, 0))
    doc.removeComponent(i, idOf(doc, i, MESH))
    expect(doc.meshSpecs(i)).toHaveLength(1)
    expect(doc.meshSpecs(i)[0]?.model, 'the collider shape, not a model').toBeUndefined()
  })

  it('switches one off without deleting it', () => {
    const doc = levelDoc(blank(), {})
    const i = doc.placeModel('m', vec3(0, 0, 0))
    doc.removeComponent(i, idOf(doc, i, MESH))
    const collider = idOf(doc, i, COLLIDER)
    doc.setComponentEnabled(i, collider, false)
    expect(doc.components(i).find((c) => c.id === collider)?.enabled).toBe(false)
    expect(doc.meshSpecs(i), 'nothing left for the Visual to draw').toEqual([])
    doc.setComponentEnabled(i, collider, true)
    expect(doc.components(i).find((c) => c.id === collider)?.enabled).toBe(true)
  })

  it('draws one mesh per collider, each at its own centre', () => {
    const doc = levelDoc(blank(), {})
    const i = doc.placeModel('m', vec3(0, 0, 0))
    doc.removeComponent(i, idOf(doc, i, MESH))
    const second = doc.addComponent(i, COLLIDER)!
    doc.setParams(i, second, { center: vec3(3, 0, 0) })
    expect(doc.meshSpecs(i).map((m) => m.transform.position)).toEqual([ZERO, vec3(3, 0, 0)])
  })

  it('lets a MaterialOverride above a node beat that node’s own material', () => {
    const doc = levelDoc(blank(), {})
    const parent = doc.placeModel('m', vec3(0, 0, 0))
    doc.addComponent(parent, MATERIAL_OVERRIDE)
    doc.setParams(parent, idOf(doc, parent, MATERIAL_OVERRIDE), { material: MAT_B })
    const child = doc.placeModel('m', vec3(1, 0, 0))
    const moved = doc.reparent(child, parent, 0)
    doc.removeComponent(moved, idOf(doc, moved, MESH))
    doc.setParams(moved, idOf(doc, moved, RENDERER), { material: MAT_A })
    expect(doc.meshSpecs(moved)[0]?.material).toBe(MAT_B)
  })

  it('collects every asset the document references, definitions included', () => {
    const { doc } = placed()
    doc.setParams(1, idOf(doc, 1, RENDERER), { material: MAT_A })
    doc.addComponent(0, MATERIAL_OVERRIDE)
    doc.setParams(0, idOf(doc, 0, MATERIAL_OVERRIDE), { material: MAT_B })
    expect(new Set(doc.assetIds())).toEqual(new Set([MAT_A, MAT_B]))
  })
})

describe('editing an inherited node writes an override', () => {
  it('changes this placement and not the prefab', () => {
    const { level, doc } = placed()
    doc.setParams(1, idOf(doc, 1, RENDERER), { material: MAT_A })

    expect(paramOn(doc, 1, RENDERER, 'material'), 'reads back its own value').toBe(MAT_A)
    expect(doc.prefabAt('pad')!.children![0]!.components[1]!.params.material, 'the definition is untouched').toBe('')
    expect(level.nodes[0]!.overrides, 'stored against the placement').toBeDefined()
  })

  it('does not touch a second placement of the same prefab', () => {
    const doc = levelDoc(blank(), library())
    doc.place('pad', vec3(0, 0, 0))
    doc.place('pad', vec3(8, 0, 0))
    doc.setParams(1, idOf(doc, 1, RENDERER), { material: MAT_A })
    expect(paramOn(doc, 1, RENDERER, 'material')).toBe(MAT_A)
    expect(paramOn(doc, 3, RENDERER, 'material'), 'the sibling placement still matches the prefab').toBe('')
  })

  it('records a transform, a name, an added component and a removal', () => {
    const { doc } = placed()
    doc.setTransform(1, { position: vec3(1, 2, 3) })
    doc.setName(1, 'moved')
    doc.addComponent(1, Bumper.type)
    doc.removeComponent(1, idOf(doc, 1, COLLIDER))

    const listed = doc.overridesOf(1)
    expect(listed).toContain('transform')
    expect(listed).toContain('name')
    expect(listed.some((s) => s.includes('added'))).toBe(true)
    expect(listed.some((s) => s.includes('removed'))).toBe(true)
    expect(doc.transformOf(1).position).toEqual(vec3(1, 2, 3))
  })

  it('marks which parameters differ, so the panel can say so', () => {
    const { doc } = placed()
    const visual = idOf(doc, 1, RENDERER)
    doc.setParams(1, visual, { material: MAT_A })
    expect(doc.components(1).find((c) => c.id === visual)?.overridden).toEqual(['material'])
  })

  it('marks a component this placement added as added, not inherited', () => {
    const { doc } = placed()
    const added = doc.addComponent(1, Hazard.type)!
    const view = doc.components(1).find((c) => c.id === added)
    expect(view?.added).toBe(true)
    expect(view?.inherited).toBe(false)
  })

  it('reverts one field and leaves the others', () => {
    const { doc } = placed()
    doc.setTransform(1, { position: vec3(1, 2, 3) })
    doc.setName(1, 'moved')

    doc.revert(1, 'transform')

    expect(doc.overridesOf(1)).not.toContain('transform')
    expect(doc.overridesOf(1)).toContain('name')
    expect(doc.transformOf(1).position, 'back to what the prefab says').toEqual(ZERO)
  })

  it('reverts everything and leaves no husk in the JSON', () => {
    const { level, doc } = placed()
    doc.setTransform(1, { position: vec3(1, 2, 3) })
    doc.addComponent(1, Hazard.type)

    doc.revert(1)

    expect(doc.overridesOf(1)).toEqual([])
    expect('overrides' in level.nodes[0]!, 'the empty map goes too').toBe(false)
  })

  it('treats removing a component it added as an undo, not as a removal', () => {
    const { level, doc } = placed()
    const added = doc.addComponent(1, Bumper.type)!
    doc.removeComponent(1, added)
    expect(doc.overridesOf(1)).toEqual([])
    expect('overrides' in level.nodes[0]!).toBe(false)
  })

  it('applies overrides to the prefab, so every placement follows and this one is clean', () => {
    const level = blank()
    const doc = levelDoc(level, library())
    doc.place('pad', vec3(0, 0, 0))
    doc.place('pad', vec3(8, 0, 0))
    doc.setParams(1, idOf(doc, 1, RENDERER), { material: MAT_A })
    doc.addComponent(1, Checkpoint.type)

    doc.applyToPrefab(1)

    expect(doc.overridesOf(1), 'no longer an override').toEqual([])
    expect(paramOn(doc, 1, RENDERER, 'material'), 'still what was chosen').toBe(MAT_A)
    expect(paramOn(doc, 3, RENDERER, 'material'), 'and the other placement followed').toBe(MAT_A)
    expect(typesOn(doc, 3)).toContain(Checkpoint.type)
    expect('overrides' in level.nodes[0]!).toBe(false)
  })

  it('has nothing to override in prefab mode, where the node is the definition', () => {
    const doc = prefabDoc(padPrefab())
    expect(doc.overridesOf(1)).toEqual([])
    doc.revert(1)
    doc.applyToPrefab(1)
    expect(doc.count(), 'and neither is a no-op that breaks anything').toBe(2)
  })
})

describe('keyframes', () => {
  const keys = (): ReturnType<typeof moveTrack> => moveTrack(vec3(0, 1, 0), 3, 1000)

  /** The one keyframe parameter on a node — what the timeline would open. */
  const editor = (doc: Doc, i: number) => {
    const found = doc.keyEditors(i)[0]
    if (found === undefined) throw new Error(`nothing animatable on node ${i}`)
    return found
  }

  /**
   * The timeline addresses a **component and a parameter**, not "the node's Track". A `keys` parameter is a
   * declaration like any other, so a second animatable component would be editable by the same strip with no
   * new plumbing.
   */
  it('reports a keyframe parameter only once a component declares one', () => {
    const doc = levelDoc(blank(), {})
    const i = doc.placeModel('m', vec3(0, 0, 0))
    expect(doc.keyEditors(i)).toEqual([])
    doc.addComponent(i, TRACK)
    expect(doc.keyEditors(i)).toEqual([{ componentId: idOf(doc, i, TRACK), type: TRACK, param: 'keys', clipParam: 'clip' }])
  })

  it('starts a fresh Track empty, so adding one moves nothing', () => {
    const doc = levelDoc(blank(), {})
    const i = doc.placeModel('m', vec3(0, 0, 0))
    doc.addComponent(i, TRACK)
    expect(doc.keysOf(i, editor(doc, i))).toEqual([])
    expect(doc.poseOf(i, 500).position, 'no keys means static').toEqual(ZERO)
  })

  it('writes keys through the component, leaving its other parameters alone', () => {
    const doc = levelDoc(blank(), {})
    const i = doc.placeModel('m', vec3(0, 0, 0))
    doc.addComponent(i, TRACK)
    const e = editor(doc, i)
    doc.setParams(i, e.componentId, { loop: 'pingPong', phaseMs: 250 })

    doc.setKeys(i, e, keys())

    expect(doc.keysOf(i, e)).toHaveLength(3)
    expect(paramOn(doc, i, TRACK, 'loop'), 'a keys edit is not a whole-component write').toBe('pingPong')
    expect(paramOn(doc, i, TRACK, 'phaseMs')).toBe(250)
  })

  it('sorts keys on the way in, so the strip and the evaluator agree on order', () => {
    const doc = levelDoc(blank(), {})
    const i = doc.placeModel('m', vec3(0, 0, 0))
    doc.addComponent(i, TRACK)
    doc.setKeys(i, editor(doc, i), [{ t: 900 }, { t: 100 }, { t: 500 }])
    expect((doc.keysOf(i, editor(doc, i)) ?? []).map((k) => k.t)).toEqual([100, 500, 900])
  })

  it('poses a node along its keys, and at its authored transform without them', () => {
    const doc = levelDoc(blank(), {})
    const i = doc.placeModel('m', vec3(0, 0, 0))
    expect(doc.poseOf(i, 500).position).toEqual(ZERO)
    doc.addComponent(i, TRACK)
    doc.setKeys(i, editor(doc, i), keys())
    expect(doc.poseOf(i, 500).position.y).toBeCloseTo(3, 9)
  })

  it('honours loop mode when posing, since that is the component’s parameter', () => {
    const doc = levelDoc(blank(), {})
    const i = doc.placeModel('m', vec3(0, 0, 0))
    doc.addComponent(i, TRACK)
    const e = editor(doc, i)
    doc.setKeys(i, e, keys())
    doc.setParams(i, e.componentId, { phaseMs: 500 })
    // Phase shifts the clock, so t=0 now reads what t=500 used to.
    expect(doc.poseOf(i, 0).position.y).toBeCloseTo(3, 9)
  })

  it('keys one placement without moving the others', () => {
    const doc = levelDoc(blank(), library())
    doc.place('pad', vec3(0, 0, 0))
    doc.place('pad', vec3(8, 0, 0))
    doc.addComponent(1, TRACK)
    doc.setKeys(1, editor(doc, 1), keys())
    expect(doc.poseOf(1, 500).position.y, 'this one moves').toBeCloseTo(3, 9)
    expect(doc.poseOf(3, 500).position.y, 'that one does not').toBeCloseTo(0, 9)
    expect(doc.overridesOf(1).some((x) => x.includes('added')), 'as a structural override').toBe(true)
  })

  // Absence means inherit, so "does not move here" is removing the inherited component — emptying its keys
  // says something different and weaker, and both are now expressible.
  it('tells emptying the keys apart from removing the component', () => {
    const lib = library()
    lib['pad']!.children![0]!.components.push(comp('t0', TRACK, { keys: moveTrack(vec3(0, 1, 0), 3, 1000), loop: 'loop', phaseMs: 0 }))
    const doc = levelDoc(blank(), lib)
    doc.place('pad', vec3(0, 0, 0))
    expect(doc.keysOf(1, editor(doc, 1))).toHaveLength(3)

    doc.setKeys(1, editor(doc, 1), [])
    expect(doc.poseOf(1, 500).position.y, 'no keys, so static').toBeCloseTo(0, 9)
    expect(typesOn(doc, 1), 'but the component is still there to add keys back to').toContain(TRACK)

    doc.removeComponent(1, editor(doc, 1).componentId)
    expect(typesOn(doc, 1)).not.toContain(TRACK)
    expect(doc.overridesOf(1).some((x) => x.includes('removed'))).toBe(true)
  })

  it('reads nothing for a component that is no longer there', () => {
    const doc = levelDoc(blank(), {})
    const i = doc.placeModel('m', vec3(0, 0, 0))
    doc.addComponent(i, TRACK)
    const e = editor(doc, i)
    doc.removeComponent(i, e.componentId)
    expect(doc.keysOf(i, e)).toBeNull()
  })

  it('ignores a component that is switched off, since the strip cannot edit what does not run', () => {
    const doc = levelDoc(blank(), {})
    const i = doc.placeModel('m', vec3(0, 0, 0))
    doc.addComponent(i, TRACK)
    doc.setComponentEnabled(i, idOf(doc, i, TRACK), false)
    expect(doc.keyEditors(i)).toEqual([])
  })
})

describe('clipboard', () => {
  it('carries the definitions the subtree references, so a paste is self-contained', () => {
    expect(Object.keys(placed().doc.copy(0)!.prefabs)).toEqual(['pad'])
  })

  it('re-mints ids, so two pastes of one clipboard are two nodes', () => {
    const { level, doc } = placed()
    const item = doc.copy(0)!
    doc.paste(item, null)
    doc.paste(item, null)
    expect(new Set(level.nodes.map((n) => n.id)).size).toBe(3)
  })

  it('reuses an identical table entry rather than filling the table with copies', () => {
    const { level, doc } = placed()
    doc.paste(doc.copy(0)!, null)
    expect(Object.keys(level.prefabs ?? {})).toEqual(['pad'])
  })

  it('pastes into a node when given a parent', () => {
    const { doc } = placed()
    expect(doc.parentOf(doc.paste(doc.copy(0)!, 0))).toBe(0)
  })

  it('refuses a placement pasted into a prefab, which holds no prefabs', () => {
    const { doc } = placed()
    expect(prefabDoc(padPrefab()).paste(doc.copy(0)!, null)).toBe(-1)
  })
})

describe('references', () => {
  it('says what a node references, and nothing for a one-off', () => {
    const { doc } = placed()
    expect(doc.refOf(0)).toBe('pad')
    expect(doc.refOf(doc.placeModel('m', vec3(0, 0, 0)))).toBeNull()
  })

  it('extracts a one-off into a shared entry and points the node at it', () => {
    const doc = levelDoc(blank(), {})
    const i = doc.placeModel('m', vec3(5, 0, 0))
    doc.setName(i, 'lamp')
    expect(doc.extract(i)).toBe('lamp')
    expect(doc.refOf(i)).toBe('lamp')
    expect(doc.transformOf(i).position, 'the placement keeps its transform').toEqual(vec3(5, 0, 0))
    expect(typesOn(doc, i), 'and reads its contents through the reference').toEqual([COLLIDER, MESH, RENDERER])
  })

  it('refuses to extract something that is already a reference', () => {
    expect(placed().doc.extract(0)).toBeNull()
  })
})

describe('prefab mode', () => {
  it('edits one root and the nodes under it', () => {
    const doc = prefabDoc(padPrefab())
    expect(doc.mode).toBe('prefab')
    expect(labels(doc)).toEqual(['pad', 'pad'])
    expect(doc.kindOf(1), 'inside a prefab everything is the definition').toBe('own')
  })

  it('offers primitives, and appends one under the root', () => {
    const doc = prefabDoc(padPrefab())
    expect(doc.palette()).toContain('platform')
    const i = doc.place('platform', vec3(0, 1, 0))
    expect(doc.parentOf(i)).toBe(0)
    expect(typesOn(doc, i)).toEqual([COLLIDER, RENDERER])
  })

  it('protects the root, which is the file', () => {
    const doc = prefabDoc(padPrefab())
    doc.remove(0)
    expect(doc.count()).toBe(2)
    expect(doc.duplicate(0)).toBe(0)
  })

  it('returns the root node as its JSON, not a level', () => {
    const root = padPrefab()
    expect(prefabDoc(root).toJSON()).toBe(root)
  })

  it('renames the root when the file is renamed, so the two cannot diverge', () => {
    const root = padPrefab()
    prefabDoc(root).setId('Trampoline')
    expect(root.name).toBe('Trampoline')
  })
})

describe('what it writes is what the game loads', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('survives a round trip through validate, and instantiates', () => {
    const { doc } = placed()
    doc.setTransform(1, { position: vec3(1, 2, 3) })
    doc.addComponent(1, Bumper.type)
    doc.setParams(1, idOf(doc, 1, Bumper.type), { power: 40 })
    const spawn = doc.placeModel('m', vec3(0, 0, 0))
    doc.removeComponent(spawn, idOf(doc, spawn, RENDERER))
    doc.removeComponent(spawn, idOf(doc, spawn, COLLIDER))
    doc.addComponent(spawn, SPAWN)

    const parsed = validateLevel(JSON.parse(JSON.stringify(doc.toJSON())), DEFAULT_REGISTRY)
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateLevel(world, parsed, DEFAULT_REGISTRY)

    expect(loaded.visuals).toHaveLength(1)
    expect(loaded.visuals[0]!.position, 'the override moved it').toEqual(vec3(1, 2, 3))
    expect(loaded.markers).toEqual([{ kind: 'spawn', position: ZERO }])
    expect(loaded.nodes[0]!.components.find((c) => c.type === Bumper.type)?.params.power, 'the parameter reached the world').toBe(40)
    world.free()
  })

  it('reopens with the same overrides after a round trip', () => {
    const { doc } = placed()
    doc.setName(1, 'moved')
    const parsed = validateLevel(JSON.parse(JSON.stringify(doc.toJSON())), DEFAULT_REGISTRY)
    const reopened = levelDoc(parsed, {})
    expect(reopened.overridesOf(1)).toContain('name')
    expect(reopened.label(1)).toBe('moved')
  })
})

describe('node references (stage C4)', () => {
  const Linked = defineComponent({ type: 'Linked', params: { target: { kind: 'nodeRef' } } })
  const REG = createRegistry([...ENGINE_COMPONENTS, ...GAMEPLAY_COMPONENTS, Linked])

  const linked = (): { level: Level; doc: Doc } => {
    const level = blank()
    const doc = levelDoc(level, library(), REG)
    const a = doc.placeModel('m', vec3(0, 0, 0))
    doc.setName(a, 'watcher')
    const b = doc.placeModel('m', vec3(3, 0, 0))
    doc.setName(b, 'anchor')
    doc.addComponent(a, Linked.type)
    doc.setParams(a, idOf(doc, a, Linked.type), { target: level.nodes[1]!.id })
    return { level, doc }
  }

  it('offers the level’s own nodes to an own node, labelled', () => {
    const { doc } = linked()
    expect(doc.nodeChoices(0).map((c) => c.label)).toEqual(['watcher', 'anchor'])
  })

  /**
   * A reference authored inside a prefab is stored in the prefab file, so offering a level node there would
   * author something that dangles in every other level the prefab is used in.
   */
  it('offers a node inside a prefab only its own siblings, plus the level for an override', () => {
    const level = blank()
    const doc = levelDoc(level, library(), REG)
    doc.place('pad', vec3(0, 0, 0))
    doc.placeModel('m', vec3(5, 0, 0))
    expect(doc.nodeChoices(1), 'the inherited pad, plus the two level nodes').toHaveLength(3)
    // The other direction: an own node is not offered anything living inside a prefab.
    const inheritedId = doc.prefabAt('pad')!.children![0]!.id
    expect(doc.nodeChoices(2).map((c) => c.id)).not.toContain(inheritedId)
  })

  it('re-points a reference when the subtree carrying it is duplicated', () => {
    const { level, doc } = linked()
    const watcher = named(doc, 'watcher')
    const anchor = named(doc, 'anchor')
    // Park the anchor under the watcher, so a duplicate copies both and the reference is internal.
    doc.reparent(anchor, watcher, 0)
    const copy = doc.duplicate(named(doc, 'watcher'))

    const original = level.nodes[0]!
    const duplicate = level.nodes[1]!
    const refOf = (n: Node): unknown => n.components.find((c) => c.type === Linked.type)?.params.target
    expect(refOf(original), 'still its own child').toBe(original.children![0]!.id)
    expect(refOf(duplicate), 'and the copy points at the copy').toBe(duplicate.children![0]!.id)
    expect(refOf(original)).not.toBe(refOf(duplicate))
    expect(copy).toBeGreaterThan(0)
  })

  it('re-points a reference when the subtree carrying it is pasted', () => {
    const { level, doc } = linked()
    doc.reparent(named(doc, 'anchor'), named(doc, 'watcher'), 0)
    doc.paste(doc.copy(named(doc, 'watcher'))!, null)
    const refOf = (n: Node): unknown => n.components.find((c) => c.type === Linked.type)?.params.target
    expect(refOf(level.nodes[1]!)).toBe(level.nodes[1]!.children![0]!.id)
    expect(refOf(level.nodes[0]!)).not.toBe(refOf(level.nodes[1]!))
  })

  it('leaves a reference to something outside the copy pointing where it did', () => {
    const { level, doc } = linked()
    doc.duplicate(named(doc, 'watcher'))
    const refOf = (n: Node): unknown => n.components.find((c) => c.type === Linked.type)?.params.target
    // The anchor is a sibling, not inside the copied subtree, so both still name it.
    expect(refOf(level.nodes[0]!)).toBe(refOf(level.nodes[1]!))
  })
})

describe('component order', () => {
  it('moves a component up and down its own list', () => {
    const doc = levelDoc(blank(), {})
    const i = doc.placeModel('m', vec3(0, 0, 0))
    doc.addComponent(i, Bumper.type)
    expect(typesOn(doc, i)).toEqual([COLLIDER, MESH, RENDERER, Bumper.type])

    doc.moveComponent(i, idOf(doc, i, Bumper.type), -1)
    expect(typesOn(doc, i)).toEqual([COLLIDER, MESH, Bumper.type, RENDERER])

    doc.moveComponent(i, idOf(doc, i, Bumper.type), 1)
    expect(typesOn(doc, i)).toEqual([COLLIDER, MESH, RENDERER, Bumper.type])
  })

  it('does nothing at either end', () => {
    const doc = levelDoc(blank(), {})
    const i = doc.placeModel('m', vec3(0, 0, 0))
    doc.moveComponent(i, idOf(doc, i, COLLIDER), -1)
    doc.moveComponent(i, idOf(doc, i, RENDERER), 1)
    expect(typesOn(doc, i)).toEqual([COLLIDER, MESH, RENDERER])
  })

  // The list belongs to the prefab, and a reordering is not something a per-placement override can express.
  it('refuses on an inherited node', () => {
    const { doc } = placed()
    const before = typesOn(doc, 1)
    doc.moveComponent(1, idOf(doc, 1, RENDERER), -1)
    expect(typesOn(doc, 1)).toEqual(before)
  })
})

/**
 * Which game a level is for, and that game's own settings (ADR 0052).
 *
 * `fallBehavior`/`fallY` used to be required fields of `LevelConfig`, so every level of every game declared a
 * fall rule that might mean nothing to it. They are parkour's parameters now, and this is the door to them.
 */
describe('the level’s game', () => {
  it('is absent on a fresh level, which is what unassigned means', () => {
    expect(levelDoc(blank(), {}).modeRef()).toBeUndefined()
  })

  it('is assigned and cleared, and shows up in the saved JSON', () => {
    const doc = levelDoc(blank(), {})
    doc.setMode('parkour')
    expect(doc.modeRef()).toEqual({ name: 'parkour' })
    expect((doc.toJSON() as Level).config.mode).toEqual({ name: 'parkour' })
    doc.setMode(null)
    expect(doc.modeRef()).toBeUndefined()
    expect((doc.toJSON() as Level).config.mode, 'the key is removed, not left as undefined').toBeUndefined()
  })

  it('is reassigned outright, since a name is all it holds', () => {
    const doc = levelDoc(blank(), {})
    doc.setMode('parkour')
    doc.setMode('racing')
    expect(doc.modeRef()).toEqual({ name: 'racing' })
  })

  it('leaves the environment alone, since they are separate blocks', () => {
    const doc = levelDoc(blank(), {})
    doc.setEnvironment({ ambient: { intensity: 0.5 } })
    doc.setMode('parkour')
    expect(doc.environment()).toEqual({ ambient: { intensity: 0.5 } })
    doc.setMode(null)
    expect(doc.environment(), 'and clearing the game does not clear the sun').toEqual({ ambient: { intensity: 0.5 } })
  })

  // A prefab is a node tree with no level of its own; its wrapper config is thrown away on save.
  it('reports and refuses on a prefab, which belongs to no game', () => {
    const doc = prefabDoc(padPrefab())
    doc.setMode('parkour')
    expect(doc.modeRef()).toBeUndefined()
  })
})

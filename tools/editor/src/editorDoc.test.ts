import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  COLLIDER,
  MATERIAL_OVERRIDE,
  SPAWN,
  MESH,
  RENDERER,
  instantiateLevel,
  validateLevel,
  type ComponentData,
  type Node,
  type Level,
} from '@mp/content'
import { Bumper, Checkpoint, DEFAULT_REGISTRY, ENGINE_COMPONENTS, GAMEPLAY_COMPONENTS, Hazard, createRegistry, defineComponent } from '@mp/components'
import { eulerToQuat, mulQuat, quat, rotateVec3, vec3, type Vec3 } from '@mp/core'

import { componentTypesInRaw, levelDoc, prefabDoc, unknownComponentTypes, type Doc } from './editorDoc'

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
/** A prefab asset id: what a placement references now (ADR 0091). */
const PAD_ID = 'aaaaaaaaaaaaaaaa'
/** Place the `pad` prefab by reference, as the Project panel does. */
const placeRef = (doc: Doc, at: Vec3): number => doc.placePrefab(PAD_ID, padPrefab(), at)

/** A two-node prefab: a root carrying only a transform, and a pad under it carrying the geometry. */
const padPrefab = (): Node => ({ id: 'root', name: 'pad', transform: { position: ZERO }, components: [], children: [solid('pad', ZERO)] })

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
  const doc = levelDoc(level)
  placeRef(doc, vec3(0, 0, 0))
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
    const doc = levelDoc(blank())
    const i = doc.placeModel('m', vec3(0, 0, 0))
    expect(doc.label(i)).toBe('box')
  })
})

describe('placing', () => {
  /**
   * The reverse of what this asserted before ADR 0091. The level holds a reference, so the prefab has one
   * definition and editing it reaches every placement — and a prefab file that goes away leaves the placement
   * empty, which Kodjo chose over a level that carries copies nobody can edit.
   */
  it('references the prefab rather than copying it, so the definition stays in one place', () => {
    const level = blank()
    const doc = levelDoc(level)
    placeRef(doc, vec3(1, 0, 0))
    expect(doc.refOf(0), 'the reference is the asset id').toBe(PAD_ID)
    expect(level.prefabs?.[PAD_ID], 'resolved for this document, not stored in the level').toBeDefined()
  })

  it('shares one table entry when the same thing is placed twice', () => {
    const level = blank()
    const doc = levelDoc(level)
    placeRef(doc, vec3(0, 0, 0))
    placeRef(doc, vec3(4, 0, 0))
    expect(Object.keys(level.prefabs ?? {}), 'one definition for both').toEqual([PAD_ID])
    expect(doc.refCount(PAD_ID)).toBe(2)
  })


  /**
   * The reference is the asset id, so a name stored inside a prefab file cannot mislead anything — which is
   * the bug behind commit 0fc0b9f (`AlternatingDanger` shipped carrying `"id": "FastElevator"`) made
   * unrepresentable rather than worked around.
   */
  it('references a placed prefab by its asset id, whatever name the file carries', () => {
    const doc = levelDoc(blank())
    doc.placePrefab(PAD_ID, { ...padPrefab(), name: 'FastElevator' }, vec3(0, 0, 0))
    expect(doc.refOf(0)).toBe(PAD_ID)
    expect(doc.prefabAt(PAD_ID), 'resolved locally so the inherited nodes are readable').toBeDefined()
  })

  it('copying a placement between levels shares the prefab instead of duplicating it', () => {
    const from = blank()
    const a = levelDoc(from)
    a.placePrefab(PAD_ID, padPrefab(), vec3(0, 0, 0))
    const item = a.copy(0)!
    expect(Object.keys(item.prefabs), 'the definition travels, so a level that never saw it can resolve it').toEqual([PAD_ID])

    const into = blank()
    const b = levelDoc(into)
    const at = b.paste(item, null)
    expect(at).toBeGreaterThanOrEqual(0)
    expect(b.refOf(at), 'the same prefab, not a copy of it').toBe(PAD_ID)
    expect(Object.keys(into.prefabs ?? {})).toEqual([PAD_ID])
  })

  it('a pasted reference nothing can resolve is kept, inert, rather than dropped', () => {
    const a = levelDoc(blank())
    a.placePrefab(PAD_ID, padPrefab(), vec3(0, 0, 0))
    const item = a.copy(0)!
    const bare = { node: item.node, prefabs: {} } // the definition did not travel
    const b = levelDoc(blank())
    const at = b.paste(bare, null)
    expect(b.refOf(at)).toBe(PAD_ID)
    expect(b.childCount(at), 'nothing inherited until the prefab is there').toBe(0)
  })

  it('two placements of one prefab are one reference, so editing it moves both', () => {
    const level = blank()
    const doc = levelDoc(level)
    doc.placePrefab(PAD_ID, padPrefab(), vec3(0, 0, 0))
    doc.placePrefab(PAD_ID, padPrefab(), vec3(4, 0, 0))
    expect(doc.refCount(PAD_ID)).toBe(2)
    expect(Object.keys(level.prefabs ?? {}), 'one definition, not two copies').toEqual([PAD_ID])
  })

  it('places a model as a node with the mesh and an authored box', () => {
    const doc = levelDoc(blank())
    const i = doc.placeModel('modelasset', vec3(0, 0, 0))
    // What it collides as, what it looks like, that it draws (ADR 0039). Visual is not collision (ADR 0014).
    expect(typesOn(doc, i)).toEqual([COLLIDER, MESH, RENDERER])
    expect(paramOn(doc, i, MESH, 'model')).toBe('modelasset')
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
    expect(doc.refCount(PAD_ID)).toBe(2)
  })

  it('never lets a node become its own ancestor', () => {
    const doc = levelDoc(blank())
    doc.placeModel('m', vec3(0, 0, 0))
    doc.placeModel('m', vec3(4, 0, 0))
    doc.reparent(1, 0, 0)
    expect(doc.canReparent(0, 1), 'a parent cannot move under its own child').toBe(false)
    expect(doc.canReparent(0, 0)).toBe(false)
  })

  it('keeps the local transform when re-parenting, so the node lands at that offset', () => {
    const doc = levelDoc(blank())
    doc.placeModel('m', vec3(0, 0, 0))
    doc.placeModel('m', vec3(4, 0, 0))
    const moved = doc.reparent(1, 0, 0)
    expect(doc.transformOf(moved).position).toEqual(vec3(4, 0, 0))
    expect(doc.parentOf(moved)).toBe(0)
  })

  it('leaves no empty children array behind after a move out', () => {
    const level = blank()
    const doc = levelDoc(level)
    doc.placeModel('m', vec3(0, 0, 0))
    doc.placeModel('m', vec3(4, 0, 0))
    doc.reparent(1, 0, 0)
    doc.reparent(1, null, 0)
    expect('children' in (level.nodes[0] ?? {}), 'the husk goes too').toBe(false)
  })

  it('reorders within a sibling list, which decides checkpoint progression', () => {
    const doc = levelDoc(blank())
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
    const doc = levelDoc(blank())
    const i = doc.placeModel('m', vec3(0, 0, 0))
    doc.addComponent(i, Bumper.type)
    expect(paramOn(doc, i, Bumper.type, 'power'), 'the schema owns the default, not the editor').toBe(26)
  })

  it('refuses a second singleton and allows a second collider', () => {
    const doc = levelDoc(blank())
    const i = doc.placeModel('m', vec3(0, 0, 0))
    expect(doc.canAdd(i, RENDERER), 'already has one').toBe(false)
    expect(doc.addComponent(i, RENDERER)).toBeNull()
    expect(doc.canAdd(i, COLLIDER), 'a node holds as many as it likes').toBe(true)
    expect(doc.addComponent(i, COLLIDER)).not.toBeNull()
    expect(typesOn(doc, i).filter((t) => t === COLLIDER)).toHaveLength(2)
  })

  it('patches some parameters and leaves the rest', () => {
    const doc = levelDoc(blank())
    const i = doc.placeModel('m', vec3(0, 0, 0))
    doc.setParams(i, idOf(doc, i, RENDERER), { material: MAT_A })
    expect(paramOn(doc, i, RENDERER, 'material')).toBe(MAT_A)
    expect(paramOn(doc, i, MESH, 'model'), 'a different component, untouched').toBe('m')
  })

  it('removes one', () => {
    const doc = levelDoc(blank())
    const i = doc.placeModel('m', vec3(0, 0, 0))
    doc.removeComponent(i, idOf(doc, i, RENDERER))
    expect(typesOn(doc, i)).toEqual([COLLIDER, MESH])
  })

  // Unity's rule: geometry with nothing to render it shows nothing (ADR 0039).
  it('draws nothing once the Renderer is gone, even with a Mesh still there', () => {
    const doc = levelDoc(blank())
    const i = doc.placeModel('m', vec3(0, 0, 0))
    expect(doc.meshSpecs(i)).toHaveLength(1)
    doc.removeComponent(i, idOf(doc, i, RENDERER))
    expect(doc.meshSpecs(i)).toEqual([])
  })

  it('draws the colliders once the Mesh is gone, since the Renderer still says to draw', () => {
    const doc = levelDoc(blank())
    const i = doc.placeModel('m', vec3(0, 0, 0))
    doc.removeComponent(i, idOf(doc, i, MESH))
    expect(doc.meshSpecs(i)).toHaveLength(1)
    expect(doc.meshSpecs(i)[0]?.model, 'the collider shape, not a model').toBeUndefined()
  })

  it('switches one off without deleting it', () => {
    const doc = levelDoc(blank())
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
    const doc = levelDoc(blank())
    const i = doc.placeModel('m', vec3(0, 0, 0))
    doc.removeComponent(i, idOf(doc, i, MESH))
    const second = doc.addComponent(i, COLLIDER)!
    doc.setParams(i, second, { center: vec3(3, 0, 0) })
    expect(doc.meshSpecs(i).map((m) => m.transform.position)).toEqual([ZERO, vec3(3, 0, 0)])
  })

  it('lets a MaterialOverride above a node beat that node’s own material', () => {
    const doc = levelDoc(blank())
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
    expect(doc.prefabAt(PAD_ID)!.children![0]!.components[1]!.params.material, 'the definition is untouched').toBe('')
    expect(level.nodes[0]!.overrides, 'stored against the placement').toBeDefined()
  })

  it('does not touch a second placement of the same prefab', () => {
    const doc = levelDoc(blank())
    placeRef(doc, vec3(0, 0, 0))
    placeRef(doc, vec3(8, 0, 0))
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

  it('applies overrides to the prefab, so every placement follows and this one is clean', async () => {
    const level = blank()
    const doc = levelDoc(level)
    placeRef(doc, vec3(0, 0, 0))
    placeRef(doc, vec3(8, 0, 0))
    doc.setParams(1, idOf(doc, 1, RENDERER), { material: MAT_A })
    doc.addComponent(1, Checkpoint.type)

    /**
     * Two halves now (ADR 0091): the ops the prefab's own document would take, and the override this level
     * clears. The host sends the first to the prefab's room and only then calls `revert`. Applying them to the
     * definition here stands in for that round trip.
     */
    const plan = doc.overrideOpsFor(1)!
    expect(plan.assetId).toBe(PAD_ID)
    expect(doc.overridesOf(1), 'nothing is cleared by asking').not.toEqual([])

    const { applyBatch: apply } = await import('@mp/content')
    apply({ id: 'p', config: {}, nodes: [doc.prefabAt(PAD_ID)!] }, plan.ops)
    doc.revert(1)

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
    expect(doc.overrideOpsFor(1), 'nothing to push: the node is the definition').toBeNull()
    expect(doc.count(), 'and neither is a no-op that breaks anything').toBe(2)
  })
})

describe('clipboard', () => {
  it('carries the definitions the subtree references, so a paste is self-contained', () => {
    expect(Object.keys(placed().doc.copy(0)!.prefabs)).toEqual([PAD_ID])
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
    expect(Object.keys(level.prefabs ?? {}), 'the reference is shared, so one definition').toEqual([PAD_ID])
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
    expect(doc.refOf(0)).toBe(PAD_ID)
    expect(doc.refOf(doc.placeModel('m', vec3(0, 0, 0)))).toBeNull()
  })

  it('extracts a one-off into a shared entry and points the node at it', () => {
    const doc = levelDoc(blank())
    const i = doc.placeModel('m', vec3(5, 0, 0))
    doc.setName(i, 'lamp')

    // What the host writes to a file: the contents at the origin, nothing reported, nothing changed.
    const definition = doc.definitionOf(i)!
    expect(definition.name).toBe('lamp')
    expect(definition.transform.position, 'at the origin — where it sits is each placement’s business').toEqual(ZERO)
    expect(doc.refOf(i), 'still a one-off until the link is made').toBeNull()

    expect(doc.linkToPrefab(i, PAD_ID, definition)).toBe(true)
    expect(doc.refOf(i)).toBe(PAD_ID)
    expect(doc.transformOf(i).position, 'the placement keeps its transform').toEqual(vec3(5, 0, 0))
    expect(typesOn(doc, i), 'and reads its contents through the reference').toEqual([COLLIDER, MESH, RENDERER])
  })

  it('refuses a node that is already a reference, and one inside a prefab', () => {
    expect(placed().doc.definitionOf(0)).toBeNull()
    expect(placed().doc.linkToPrefab(0, PAD_ID, padPrefab())).toBe(false)
    expect(prefabDoc(padPrefab()).definitionOf(1)).toBeNull()
  })
})

describe('prefab mode', () => {
  it('edits one root and the nodes under it', () => {
    const doc = prefabDoc(padPrefab())
    expect(doc.mode).toBe('prefab')
    expect(labels(doc)).toEqual(['pad', 'pad'])
    expect(doc.kindOf(1), 'inside a prefab everything is the definition').toBe('own')
  })

  it('offers primitives, and appends one under the root as a built-in shape sized by its scale', () => {
    const doc = prefabDoc(padPrefab())
    const i = doc.placeNamed('platform', vec3(0, 1, 0))
    expect(doc.parentOf(i)).toBe(0)
    expect(typesOn(doc, i)).toEqual([COLLIDER, MESH, RENDERER])
    // Unit collider, the size in the scale (ADR 0090).
    expect(paramOn(doc, i, COLLIDER, 'shape')).toEqual({ kind: 'box', halfExtents: vec3(0.5, 0.5, 0.5) })
    expect(paramOn(doc, i, MESH, 'model')).toBe('builtin:rounded-box')
    expect(doc.transformOf(i).scale).toEqual(vec3(3, 0.3, 3))
    expect(doc.builtinOf(i)).toBe('builtin:rounded-box')
  })

  it('a built-in picked on a node locks its colliders to the unit shape, in one batch', () => {
    const doc = prefabDoc(padPrefab())
    const i = doc.placeNamed('box', vec3(0, 0, 0))
    doc.setParams(i, idOf(doc, i, COLLIDER), { shape: { kind: 'box', halfExtents: vec3(4, 2, 1) } })
    doc.setParams(i, idOf(doc, i, MESH), { model: 'builtin:sphere' })
    expect(paramOn(doc, i, COLLIDER, 'shape'), 'the collider followed the shape').toEqual({ kind: 'ball', radius: 0.5 })
    expect(doc.builtinOf(i)).toBe('builtin:sphere')
    doc.setParams(i, idOf(doc, i, MESH), { model: '' })
    expect(doc.builtinOf(i), 'a file or nothing: the collider is a free shape again').toBeNull()
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
    const reopened = levelDoc(parsed)
    expect(reopened.overridesOf(1)).toContain('name')
    expect(reopened.label(1)).toBe('moved')
  })
})

describe('node references (stage C4)', () => {
  const Linked = defineComponent({ type: 'Linked', params: { target: { kind: 'nodeRef' } } })
  const REG = createRegistry([...ENGINE_COMPONENTS, ...GAMEPLAY_COMPONENTS, Linked])

  const linked = (): { level: Level; doc: Doc } => {
    const level = blank()
    const doc = levelDoc(level, REG)
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
    const doc = levelDoc(level, REG)
    placeRef(doc, vec3(0, 0, 0))
    doc.placeModel('m', vec3(5, 0, 0))
    expect(doc.nodeChoices(1), 'the inherited pad, plus the two level nodes').toHaveLength(3)
    // The other direction: an own node is not offered anything living inside a prefab.
    const inheritedId = doc.prefabAt(PAD_ID)!.children![0]!.id
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
    const doc = levelDoc(blank())
    const i = doc.placeModel('m', vec3(0, 0, 0))
    doc.addComponent(i, Bumper.type)
    expect(typesOn(doc, i)).toEqual([COLLIDER, MESH, RENDERER, Bumper.type])

    doc.moveComponent(i, idOf(doc, i, Bumper.type), -1)
    expect(typesOn(doc, i)).toEqual([COLLIDER, MESH, Bumper.type, RENDERER])

    doc.moveComponent(i, idOf(doc, i, Bumper.type), 1)
    expect(typesOn(doc, i)).toEqual([COLLIDER, MESH, RENDERER, Bumper.type])
  })

  it('does nothing at either end', () => {
    const doc = levelDoc(blank())
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
    expect(levelDoc(blank()).modeRef()).toBeUndefined()
  })

  it('is assigned and cleared, and shows up in the saved JSON', () => {
    const doc = levelDoc(blank())
    doc.setMode('parkour')
    expect(doc.modeRef()).toEqual({ name: 'parkour' })
    expect((doc.toJSON() as Level).config.mode).toEqual({ name: 'parkour' })
    doc.setMode(null)
    expect(doc.modeRef()).toBeUndefined()
    expect((doc.toJSON() as Level).config.mode, 'the key is removed, not left as undefined').toBeUndefined()
  })

  it('is reassigned outright, since a name is all it holds', () => {
    const doc = levelDoc(blank())
    doc.setMode('parkour')
    doc.setMode('racing')
    expect(doc.modeRef()).toEqual({ name: 'racing' })
  })

  it('leaves the environment alone, since they are separate blocks', () => {
    const doc = levelDoc(blank())
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

describe('a prefab the game cannot hold (ADR 0076, ADR 0077)', () => {
  /** A game with no `Bumper`: the engine's components and a hazard, like keyboard's. */
  const noBumper = createRegistry([...ENGINE_COMPONENTS, Hazard])
  const trampoline = (): Node => ({
    id: 'root',
    name: 'Trampoline',
    transform: { position: ZERO },
    components: [],
    children: [{ ...solid('pad', ZERO), components: [...solid('pad', ZERO).components, { id: 'b', type: Bumper.type, params: {} }] }],
  })

  it('names the component types the registry lacks, once each, sorted', () => {
    expect(unknownComponentTypes(trampoline(), noBumper)).toEqual([Bumper.type])
    expect(unknownComponentTypes(trampoline(), DEFAULT_REGISTRY)).toEqual([])
  })

  // Before validation, so the editor can adopt what a level needs and *then* validate it (ADR 0077).
  it('lists the component types an unvalidated level file uses, prefab table included', () => {
    const raw = { nodes: [solid('a', ZERO), { id: 'p', transform: {}, components: [], prefab: 'Trampoline' }], prefabs: { Trampoline: trampoline() } }
    expect(componentTypesInRaw(raw)).toEqual(['Bumper', 'Collider', 'Renderer'])
    expect(componentTypesInRaw({ nodes: 'nonsense' })).toEqual([])
    expect(componentTypesInRaw(null)).toEqual([])
  })

  // The game would refuse the level at load; the editor refuses the placement instead, so the file on disk is
  // never one the game cannot open.
  it('refuses to place it, and leaves the level untouched', () => {
    const doc = levelDoc(blank(), noBumper)
    expect(doc.placePrefab(PAD_ID, trampoline(), ZERO)).toBe(-1)
    expect(doc.count()).toBe(0)
    expect(() => validateLevel(doc.asLevel(), noBumper)).not.toThrow()
  })

  it('places it in a game that has the type', () => {
    const doc = levelDoc(blank())
    expect(doc.placePrefab(PAD_ID, trampoline(), ZERO)).toBeGreaterThanOrEqual(0)
  })
})

/**
 * Every mutation is an op batch (ADR 0089): replaying the reported ops on the starting level gives the edited
 * level, and applying the inverses in undo order gives the start back. Key order is not meaning.
 */
describe('the document reports its edits as ops', () => {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : typeof v === 'object' && v !== null ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v
  const same = (a: unknown, b: unknown): void => expect(JSON.stringify(canon(a))).toBe(JSON.stringify(canon(b)))

  const record = (doc: Doc): { ops: import('@mp/content').Op[]; inverses: import('@mp/content').Op[] }[] => {
    const batches: { ops: import('@mp/content').Op[]; inverses: import('@mp/content').Op[] }[] = []
    doc.onOps = (b) => batches.push(b)
    return batches
  }

  it('replays and reverses every kind of edit on a level', async () => {
    const { applyBatch } = await import('@mp/content')
    const { level, doc } = placed()
    const start = structuredClone(level)
    const batches = record(doc)

    // Index 0 is the placement (labelled by its prefab key, also `pad`); index 1 is the pad it inherits.
    const placement = 0
    const pad = 1
    doc.setTransform(placement, { position: vec3(1, 2, 3) })
    doc.setTransform(pad, { position: vec3(0, 5, 0) }) // inherited → an override
    doc.setName(pad, 'renamed pad')
    doc.setParams(pad, idOf(doc, pad, RENDERER), { material: MAT_A })
    doc.setComponentEnabled(pad, idOf(doc, pad, COLLIDER), false)
    const addedOnPad = doc.addComponent(pad, MATERIAL_OVERRIDE)!
    doc.setParams(pad, addedOnPad, { material: MAT_B })
    doc.removeComponent(pad, idOf(doc, pad, RENDERER))
    const emptyAt = doc.placeEmpty(vec3(0, 0, 0), null)
    doc.setName(emptyAt, 'empty one')
    const added = doc.addComponent(emptyAt, SPAWN)!
    doc.setComponentEnabled(emptyAt, added, false)
    doc.removeComponent(emptyAt, added)
    const dup = doc.duplicate(emptyAt)
    doc.reparent(dup, emptyAt, 0)
    doc.move(named(doc, 'empty one'), 0)
    const model = doc.placeModel('model-1', vec3(4, 0, 0))
    doc.remove(model)
    doc.revert(named(doc, 'renamed pad'), 'name')
    doc.setEnvironment({ ambient: { intensity: 0.4 } })
    doc.setMode('parkour')
    doc.setMode(null)
    expect(doc.linkToPrefab(named(doc, 'empty one'), PAD_ID, padPrefab())).toBe(true)

    const replay = structuredClone(start)
    for (const b of batches) applyBatch(replay, b.ops)
    same(replay, level)

    const back = structuredClone(level)
    for (const b of [...batches].reverse()) applyBatch(back, b.inverses)
    same(back, start)
    validateLevel(JSON.parse(JSON.stringify(level)), DEFAULT_REGISTRY)
  })

  it('an edit that changes nothing reports nothing', () => {
    const { doc } = placed()
    const empty = doc.placeEmpty(vec3(1, 1, 1), null)
    doc.setName(empty, 'e')
    const spawn = doc.addComponent(empty, SPAWN)!
    const batches = record(doc)
    doc.setName(empty, 'e')
    doc.setTransform(0, doc.transformOf(0))
    doc.setParams(empty, spawn, {})
    doc.setComponentEnabled(empty, spawn, true)
    doc.move(empty, doc.siblingIndexOf(empty))
    expect(batches).toEqual([])
  })

  it('a prefab opened on top edits the live table entry and stamps its ops with the table key', async () => {
    const { applyBatch } = await import('@mp/content')
    const { level, doc } = placed()
    const key = doc.refOf(0)!
    const top = prefabDoc(doc.prefabAt(key)!, DEFAULT_REGISTRY, { table: key })
    const start = structuredClone(level)
    const batches = record(top)
    top.setTransform(1, { position: vec3(0, 9, 0) })
    top.placeNamed('box', vec3(1, 1, 1))
    expect(batches.every((b) => b.ops.every((o) => o.table === key))).toBe(true)
    // The level's own view changed with it: the placement now inherits the moved pad and the new box.
    expect(doc.transformOf(1).position.y).toBe(9)
    expect(labels(doc)).toContain('box')
    const replay = structuredClone(start)
    for (const b of batches) applyBatch(replay, b.ops)
    same(replay, level)
  })

  it('refAt and indexOfRef round-trip, and two placements of one prefab are two different inherited nodes', () => {
    const { doc } = placed()
    placeRef(doc, vec3(5, 0, 0))
    const pads = labels(doc).map((l, i) => [l, i] as const).filter(([l, i]) => l === 'pad' && doc.kindOf(i) === 'inherited').map(([, i]) => i)
    expect(pads).toHaveLength(2)
    const refs = pads.map((i) => doc.refAt(i)!)
    expect(refs[0]).not.toEqual(refs[1])
    expect('owner' in refs[0]!).toBe(true)
    for (const i of [0, ...pads]) expect(doc.indexOfRef(doc.refAt(i)!)).toBe(i)
    expect(doc.indexOfRef({ id: 'nobody' })).toBeNull()
    doc.remove(0)
    expect(doc.indexOfRef(refs[0]!), 'gone with its placement').toBeNull()
  })
})

/**
 * Writing to a component a placement inherited from its prefab's **root** (ADR 0098).
 *
 * The bug this exists for: a placement has no `owner` — it is one — but its visible component list is the
 * prefab root's layered with its own. So a write aimed at an inherited root component went to the placement,
 * which does not have it. `setParams` threw `no component 'c0' on node '<id>'`; remove and enable had a guard
 * and silently did nothing, which is worse.
 *
 * Every fixture above puts the geometry on a prefab's *child*, which is why none of them found it.
 */
const KILL_ID = 'cccccccccccccccc'

/** A prefab whose **root** carries the geometry — Kodjo's kill plane, and the shape that found this. */
const rootGeometry = (): Node => ({
  id: 'kroot',
  name: 'kill',
  transform: { position: ZERO },
  components: [comp('c0', COLLIDER, { shape: BOX, center: ZERO }), comp('c1', Hazard.type)],
})

const placedRootGeometry = (): { level: Level; doc: Doc } => {
  const level = blank()
  const doc = levelDoc(level)
  doc.placePrefab(KILL_ID, rootGeometry(), vec3(0, 0, 0))
  return { level, doc }
}

describe('a component inherited from the prefab root', () => {
  const BIGGER = { kind: 'box', halfExtents: vec3(40, 1, 40) }

  it('is shown on the placement, which is what made the write ambiguous', () => {
    const { doc } = placedRootGeometry()
    expect(doc.kindOf(0), 'a placement is its own node').toBe('own')
    expect(typesOn(doc, 0)).toEqual([COLLIDER, Hazard.type])
  })

  it('records a parameter change as an override on the placement, keyed by the root', () => {
    const { level, doc } = placedRootGeometry()
    // Exactly Kodjo's gesture: resize the collider's half extents on the placed kill plane.
    doc.setParams(0, 'c0', { shape: BIGGER })
    const over = level.nodes[0]!.overrides
    expect(over, 'an override, not an edit to the placement').toBeDefined()
    expect(Object.keys(over!), "keyed by the prefab root's own id").toEqual(['kroot'])
    expect(over!.kroot!.params?.c0?.shape).toEqual(BIGGER)
    expect(paramOn(doc, 0, COLLIDER, 'shape'), 'and the document reads it back').toEqual(BIGGER)
  })

  it('leaves the prefab definition alone, so other placements keep the old size', () => {
    const level = blank()
    const doc = levelDoc(level)
    doc.placePrefab(KILL_ID, rootGeometry(), vec3(0, 0, 0))
    const second = doc.placePrefab(KILL_ID, rootGeometry(), vec3(50, 0, 0))
    doc.setParams(0, 'c0', { shape: BIGGER })
    expect(paramOn(doc, second, COLLIDER, 'shape'), 'a per-placement override is not a prefab edit').toEqual(BOX)
    expect(level.prefabs?.[KILL_ID]?.components[0]?.params.shape).toEqual(BOX)
  })

  it('records a removal rather than doing nothing', () => {
    const { level, doc } = placedRootGeometry()
    doc.removeComponent(0, 'c1')
    expect(level.nodes[0]!.overrides?.kroot?.removed).toContain('c1')
    expect(typesOn(doc, 0), 'gone from the view').toEqual([COLLIDER])
  })

  it('records a disable rather than doing nothing', () => {
    const { level, doc } = placedRootGeometry()
    doc.setComponentEnabled(0, 'c0', false)
    expect(level.nodes[0]!.overrides?.kroot?.enabled?.c0).toBe(false)
  })

  it('still edits a component the placement owns directly', () => {
    const { level, doc } = placedRootGeometry()
    const own = doc.addComponent(0, MATERIAL_OVERRIDE)!
    doc.setParams(0, own, { material: MAT_A })
    expect(level.nodes[0]!.components.find((c) => c.id === own)?.params.material, 'its own, so no override').toBe(MAT_A)
    expect(level.nodes[0]!.overrides?.kroot?.params?.[own]).toBeUndefined()
  })

  it('refuses to reorder it, because the order is the prefab’s', () => {
    const { level, doc } = placedRootGeometry()
    doc.moveComponent(0, 'c1', -1)
    expect(level.nodes[0]!.overrides, 'no override can express a reordering').toBeUndefined()
    expect(typesOn(doc, 0)).toEqual([COLLIDER, Hazard.type])
  })
})

/**
 * **The preview and the game must agree** (ADR 0106).
 *
 * `poseOf` draws the viewport and `instantiateLevel` builds the world, and they are two readers of one rule.
 * When the mover re-framing lived in the loader alone, a `local` mover was drawn travelling along the world
 * axes while the game moved it along the object's own forward: the editor lied about the level. Kodjo found
 * it by playing the level and then pressing the preview button.
 *
 * So this compares them directly, on the shapes that make them differ: a turned node, a scaled parent, a
 * turned parent, and a parent that is itself spinning.
 */
describe('the viewport preview agrees with the loader', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  const rad = (deg: number): number => (deg * Math.PI) / 180

  const mover = (over: Record<string, unknown>): ComponentData => ({
    id: 'm0',
    type: 'Mover',
    params: { move: vec3(0, 0, 10), speed: 20, smooth: false, space: 'world', ...over },
  })

  const drawnByGame = (nodes: Node[], atMs: number): Vec3 => {
    const level: Level = { id: 'fx', config: {}, nodes: structuredClone(nodes) }
    const loaded = instantiateLevel(createPhysicsWorld({ gravity: vec3(0, 0, 0) }), level, DEFAULT_REGISTRY)
    loaded.update(atMs)
    loaded.render(1)
    return loaded.visuals[0]!.position
  }

  /** The preview's answer for the deepest node, composed through its ancestors the way the tree does. */
  const drawnByEditor = (nodes: Node[], atMs: number): Vec3 => {
    const doc = levelDoc({ id: 'fx', config: {}, nodes: structuredClone(nodes) }, DEFAULT_REGISTRY)
    const last = doc.count() - 1
    // Walk down composing, which is what the editor's instance groups do with each node's local pose.
    const chain: number[] = []
    for (let at = last; at >= 0; at = doc.parentOf(at) ?? -1) chain.unshift(at)
    let pos = vec3(0, 0, 0)
    let rot = quat()
    let scale = vec3(1, 1, 1)
    for (const i of chain) {
      const p = doc.poseOf(i, atMs)
      const turned = rotateVec3(rot, vec3(p.position.x * scale.x, p.position.y * scale.y, p.position.z * scale.z))
      pos = vec3(pos.x + turned.x, pos.y + turned.y, pos.z + turned.z)
      rot = mulQuat(rot, eulerToQuat(p.rotation))
      const s = doc.transformOf(i).scale
      if (s !== undefined) scale = vec3(scale.x * s.x, scale.y * s.y, scale.z * s.z)
    }
    return pos
  }

  const lift = (components: ComponentData[], transform: Node['transform']): Node => ({
    id: 'lift',
    transform,
    components: [{ id: 'c0', type: 'Collider', params: { shape: { kind: 'box', halfExtents: vec3(0.5, 0.5, 0.5) } } }, { id: 'c1', type: 'Renderer', params: { material: '' } }, ...components],
  })

  const cases: { name: string; nodes: Node[] }[] = [
    { name: 'a plain world mover', nodes: [lift([mover({})], { position: vec3(0, 0, 0) })] },
    {
      name: 'a local mover on a turned node',
      nodes: [lift([mover({ space: 'local' })], { position: vec3(0, 0, 0), rotation: vec3(rad(160), rad(-90), 0) })],
    },
    {
      name: 'a world mover under a scaled parent',
      nodes: [{ id: 'holder', transform: { position: vec3(0, 0, 0), scale: vec3(2, 0.5, 3) }, components: [], children: [lift([mover({})], { position: vec3(0, 0, 0) })] }],
    },
    {
      name: 'a world mover under a turned parent',
      nodes: [{ id: 'holder', transform: { position: vec3(0, 0, 0), rotation: vec3(0, rad(90), 0) }, components: [], children: [lift([mover({})], { position: vec3(0, 0, 0) })] }],
    },
    {
      name: 'a local mover under a spinning parent',
      nodes: [
        {
          id: 'holder',
          transform: { position: vec3(0, 0, 0) },
          components: [{ id: 's0', type: 'Spinner', params: { axis: '+Y', speed: 90, offset: 0 } }],
          children: [lift([mover({ space: 'local' })], { position: vec3(0, 0, 0), rotation: vec3(0, rad(45), 0) })],
        },
      ],
    },
  ]

  for (const c of cases) {
    it(`agrees on ${c.name}`, () => {
      for (const t of [0, 125, 250, 375, 500]) {
        const game = drawnByGame(c.nodes, t)
        const editor = drawnByEditor(c.nodes, t)
        expect(editor.x, `${c.name} x at ${t}ms`).toBeCloseTo(game.x, 4)
        expect(editor.y, `${c.name} y at ${t}ms`).toBeCloseTo(game.y, 4)
        expect(editor.z, `${c.name} z at ${t}ms`).toBeCloseTo(game.z, 4)
      }
    })
  }
})

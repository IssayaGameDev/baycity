import { describe, expect, it } from 'vitest'

import { applyBatch, applyOp, invertOp, OpError, refKey, touchedRefs, type Op } from './ops'
import type { ComponentData, Level, Node } from './types'
import { validateLevel } from './validate'

/**
 * Every op, forwards then backwards: `applyOp(invertOp(op))` must give back the exact level. The fixtures cover
 * own nodes with children, a placement with overrides of every kind, and a prefab table tree edited in place.
 */
const v3 = (x: number, y: number, z: number): { x: number; y: number; z: number } => ({ x, y, z })
const comp = (id: string, type: string, params: Record<string, unknown> = {}): ComponentData => ({ id, type, params })
const node = (id: string, extra: Partial<Node> = {}): Node => ({ id, transform: { position: v3(0, 0, 0) }, components: [comp(`${id}-c`, 'Collider', { shape: { kind: 'box', halfExtents: v3(1, 1, 1) } })], ...extra })

const fixture = (): Level => ({
  id: 'lv',
  config: { mode: { name: 'parkour' } },
  prefabs: {
    pad: node('root', { name: 'pad', children: [node('top', { name: 'top' }), node('leg')] }),
  },
  nodes: [
    node('a', { name: 'A', children: [node('a1'), node('a2', { children: [node('a2x')] })] }),
    { id: 'p1', transform: { position: v3(5, 0, 0) }, components: [], prefab: 'pad', overrides: { top: { transform: { position: v3(0, 1, 0) }, params: { 'top-c': { friction: 2 } } } } },
    { id: 'p2', transform: { position: v3(9, 0, 0) }, components: [], prefab: 'pad' },
    node('b'),
  ],
})

/** Key order is not meaning: a name deleted and put back lands last in its object. Compare sorted. */
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : typeof v === 'object' && v !== null ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v)
const json = (l: Level): string => JSON.stringify(canon(l))

/** Forward, back, and the level is what it was. Also: the forward result is a valid level. */
const roundTrip = (op: Op): { after: Level } => {
  const level = fixture()
  const before = json(level)
  const inverse = invertOp(level, op)
  expect(inverse, 'the op must change something').not.toBeNull()
  applyOp(level, op)
  validateLevel(JSON.parse(json(level)))
  const after = JSON.parse(json(level)) as Level
  expect(json(level), 'the op must have changed the level').not.toBe(before)
  applyOp(level, inverse!)
  expect(json(level)).toBe(before)
  return { after }
}

describe('own-node ops round-trip', () => {
  it('setTransform / setName / setParams / setComponentEnabled', () => {
    roundTrip({ kind: 'setTransform', id: 'a1', transform: { position: v3(1, 2, 3), rotation: v3(0, 1, 0) } })
    roundTrip({ kind: 'setName', id: 'a1', name: 'named' })
    roundTrip({ kind: 'setName', id: 'a', name: null })
    const { after } = roundTrip({ kind: 'setParams', id: 'a', componentId: 'a-c', patch: { friction: 3, shape: { kind: 'ball', radius: 1 } }, unset: ['nothing'] })
    expect(after.nodes[0]!.components[0]!.params).toEqual({ friction: 3, shape: { kind: 'ball', radius: 1 } })
    roundTrip({ kind: 'setParams', id: 'a', componentId: 'a-c', patch: {}, unset: ['shape'] })
    roundTrip({ kind: 'setComponentEnabled', id: 'a', componentId: 'a-c', enabled: false })
  })

  it('addComponent / removeComponent / moveComponent', () => {
    roundTrip({ kind: 'addComponent', id: 'a', component: comp('r', 'Renderer', { material: '' }) })
    roundTrip({ kind: 'addComponent', id: 'a', component: comp('r', 'Renderer', { material: '' }), index: 0 })
    roundTrip({ kind: 'removeComponent', id: 'a', componentId: 'a-c' })
    const level = fixture()
    level.nodes[3]!.components.push(comp('x', 'Renderer'), comp('y', 'Mesh'))
    const before = json(level)
    const inv = invertOp(level, { kind: 'moveComponent', id: 'b', componentId: 'y', to: 0 })!
    applyOp(level, { kind: 'moveComponent', id: 'b', componentId: 'y', to: 0 })
    expect(level.nodes[3]!.components.map((c) => c.id)).toEqual(['y', 'b-c', 'x'])
    applyOp(level, inv)
    expect(json(level)).toBe(before)
  })
})

describe('structural ops round-trip', () => {
  it('insertNode at a root, under a parent, and into an empty parent (children tidied on the way back)', () => {
    roundTrip({ kind: 'insertNode', parent: null, index: 1, node: node('n') })
    roundTrip({ kind: 'insertNode', parent: 'a1', index: 0, node: node('n', { children: [node('n1')] }) })
    const { after } = roundTrip({ kind: 'insertNode', parent: 'b', index: 5, node: node('n') })
    expect(after.nodes[3]!.children?.map((c) => c.id)).toEqual(['n'])
  })

  it('removeNode takes the subtree and comes back at the same place', () => {
    const { after } = roundTrip({ kind: 'removeNode', id: 'a2' })
    expect(after.nodes[0]!.children?.map((c) => c.id)).toEqual(['a1'])
    roundTrip({ kind: 'removeNode', id: 'a' })
    // Removing the only child leaves no `children: []` behind.
    const level = fixture()
    applyOp(level, { kind: 'removeNode', id: 'a2x' })
    expect(level.nodes[0]!.children![1]!.children).toBeUndefined()
  })

  it('moveNode reorders, reparents to a node, reparents to the roots', () => {
    const { after } = roundTrip({ kind: 'moveNode', id: 'b', parent: null, index: 0 })
    expect(after.nodes.map((n) => n.id)).toEqual(['b', 'a', 'p1', 'p2'])
    roundTrip({ kind: 'moveNode', id: 'a2x', parent: 'a1', index: 0 })
    const up = roundTrip({ kind: 'moveNode', id: 'a2x', parent: null, index: 2 })
    expect(up.after.nodes.map((n) => n.id)).toEqual(['a', 'p1', 'a2x', 'p2', 'b'])
    expect(up.after.nodes[0]!.children![1]!.children, 'the emptied parent is tidied').toBeUndefined()
  })

  it('replaceNode keeps the id and swaps everything else', () => {
    const { after } = roundTrip({ kind: 'replaceNode', id: 'b', node: { id: 'b', transform: { position: v3(0, 0, 0) }, components: [], prefab: 'pad' } })
    expect(after.nodes[3]!.prefab).toBe('pad')
  })
})

describe('the prefab table', () => {
  it('internPrefab / dropPrefab round-trip; an identical intern is a no-op; a different one is refused', () => {
    roundTrip({ kind: 'internPrefab', key: 'crate', root: node('root', { children: [node('lid')] }) })
    const level = fixture()
    expect(invertOp(level, { kind: 'internPrefab', key: 'pad', root: level.prefabs!.pad! })).toBeNull()
    expect(() => invertOp(level, { kind: 'internPrefab', key: 'pad', root: node('other') })).toThrow(OpError)
    expect(() => invertOp(level, { kind: 'internPrefab', key: 'bad', root: node('r', { children: [node('k', { prefab: 'pad' })] }) })).toThrow(/cannot reference another prefab/)
  })

  it('dropPrefab of a referenced key is a no-op, so undoing a placement is always safe', () => {
    const level = fixture()
    expect(invertOp(level, { kind: 'dropPrefab', key: 'pad' })).toBeNull()
    applyOp(level, { kind: 'dropPrefab', key: 'pad' })
    expect(level.prefabs?.pad).toBeDefined()
    applyOp(level, { kind: 'removeNode', id: 'p1' })
    applyOp(level, { kind: 'removeNode', id: 'p2' })
    const inv = invertOp(level, { kind: 'dropPrefab', key: 'pad' })
    expect(inv?.kind).toBe('internPrefab')
    applyOp(level, { kind: 'dropPrefab', key: 'pad' })
    expect(level.prefabs).toBeUndefined()
  })
})

describe('override ops round-trip and tidy', () => {
  it('transform, name, params, enabled, removed, whole record', () => {
    roundTrip({ kind: 'setOverrideTransform', owner: 'p2', node: 'top', transform: { position: v3(0, 2, 0) } })
    roundTrip({ kind: 'setOverrideTransform', owner: 'p1', node: 'top', transform: null })
    roundTrip({ kind: 'setOverrideName', owner: 'p2', node: 'leg', name: '' })
    roundTrip({ kind: 'setOverrideParams', owner: 'p1', node: 'top', componentId: 'top-c', patch: { friction: 9, bounce: 1 } })
    const cleared = roundTrip({ kind: 'setOverrideParams', owner: 'p1', node: 'top', componentId: 'top-c', patch: {}, unset: ['friction'] })
    expect(cleared.after.nodes[1]!.overrides!.top!.params, 'an emptied params map is gone').toBeUndefined()
    roundTrip({ kind: 'setOverrideEnabled', owner: 'p2', node: 'top', componentId: 'top-c', enabled: false })
    roundTrip({ kind: 'setOverrideRemoved', owner: 'p2', node: 'top', componentId: 'top-c', removed: true })
    roundTrip({ kind: 'setNodeOverride', owner: 'p1', node: 'top', override: null })
    const whole = roundTrip({ kind: 'setNodeOverride', owner: 'p2', node: 'leg', override: { name: 'x', enabled: { 'leg-c': false } } })
    expect(whole.after.nodes[2]!.overrides?.leg).toEqual({ name: 'x', enabled: { 'leg-c': false } })
  })

  it('added components: add, patch in place, toggle, remove', () => {
    const c = comp('extra', 'Renderer', { material: 'm' })
    roundTrip({ kind: 'addOverrideComponent', owner: 'p2', node: 'top', component: c })
    const level = fixture()
    applyOp(level, { kind: 'addOverrideComponent', owner: 'p2', node: 'top', component: c })
    const before = json(level)
    for (const op of [
      { kind: 'setOverrideParams', owner: 'p2', node: 'top', componentId: 'extra', patch: { material: 'n' } },
      { kind: 'setOverrideEnabled', owner: 'p2', node: 'top', componentId: 'extra', enabled: false },
    ] as const) {
      const inv = invertOp(level, op)!
      applyOp(level, op)
      applyOp(level, inv)
      expect(json(level)).toBe(before)
    }
    applyOp(level, { kind: 'setOverrideParams', owner: 'p2', node: 'top', componentId: 'extra', patch: { material: 'n' } })
    expect(level.nodes[2]!.overrides!.top!.added![0]!.params.material, 'patched on the added component, not in params').toBe('n')
    expect(level.nodes[2]!.overrides!.top!.params).toBeUndefined()
    const inv = invertOp(level, { kind: 'removeOverrideComponent', owner: 'p2', node: 'top', componentId: 'extra' })!
    applyOp(level, { kind: 'removeOverrideComponent', owner: 'p2', node: 'top', componentId: 'extra' })
    expect(level.nodes[2]!.overrides, 'the emptied record and map are gone').toBeUndefined()
    applyOp(level, inv)
    expect(level.nodes[2]!.overrides!.top!.added![0]!.params.material).toBe('n')
  })
})

describe('level ops', () => {
  it('setEnvironment / setMode round-trip and validate', () => {
    roundTrip({ kind: 'setEnvironment', environment: { ambient: { intensity: 0.5 } } })
    roundTrip({ kind: 'setMode', mode: null })
    roundTrip({ kind: 'setMode', mode: { name: 'swing' } })
    expect(() => invertOp(fixture(), { kind: 'setMode', mode: { name: '' } })).toThrow(OpError)
    expect(() => invertOp(fixture(), { kind: 'setEnvironment', environment: { sun: { color: 'red' } as never } })).toThrow(OpError)
  })

  it('setNetBounds round-trips, clears, and refuses a non-positive range', () => {
    roundTrip({ kind: 'setNetBounds', netBounds: 250 })

    // Clearing is only a change once there is something to clear, and the inverse restores the number.
    const level = fixture()
    applyOp(level, { kind: 'setNetBounds', netBounds: 250 })
    const undo = invertOp(level, { kind: 'setNetBounds', netBounds: null })
    expect(undo).toEqual({ kind: 'setNetBounds', netBounds: 250 })
    applyOp(level, { kind: 'setNetBounds', netBounds: null })
    expect(level.config.netBounds).toBeUndefined()
    applyOp(level, undo!)
    expect(level.config.netBounds).toBe(250)
    expect(invertOp(level, { kind: 'setNetBounds', netBounds: 250 }), 'setting what is already set').toBeNull()

    for (const bad of [0, -1, Number.NaN]) {
      expect(() => invertOp(fixture(), { kind: 'setNetBounds', netBounds: bad })).toThrow(OpError)
    }
    expect(() => invertOp(fixture(), { kind: 'setNetBounds', table: 'pad', netBounds: 250 })).toThrow(/no bounds/)
  })

  it('setCameraSeeThrough writes only true, round-trips, and refuses a prefab or a non-boolean', () => {
    roundTrip({ kind: 'setCameraSeeThrough', seeThrough: true })

    const level = fixture()
    expect(invertOp(level, { kind: 'setCameraSeeThrough', seeThrough: false }), 'absent already means false').toBeNull()
    applyOp(level, { kind: 'setCameraSeeThrough', seeThrough: true })
    expect(level.config.cameraSeeThrough).toBe(true)
    const undo = invertOp(level, { kind: 'setCameraSeeThrough', seeThrough: false })
    expect(undo).toEqual({ kind: 'setCameraSeeThrough', seeThrough: true })
    applyOp(level, { kind: 'setCameraSeeThrough', seeThrough: false })
    expect('cameraSeeThrough' in level.config, 'false removes the key rather than writing it').toBe(false)

    expect(() => invertOp(fixture(), { kind: 'setCameraSeeThrough', seeThrough: 'yes' as never })).toThrow(OpError)
    expect(() => invertOp(fixture(), { kind: 'setCameraSeeThrough', table: 'pad', seeThrough: true })).toThrow(/no camera/)
    expect(touchedRefs(fixture(), { kind: 'setCameraSeeThrough', seeThrough: true })).toEqual([])
  })
})

/** A child a placement added under a piece, which lives in that piece's record (ADR 0135, ADR 0151). */
describe('a child added under a piece', () => {
  const withFlag = (): Level => {
    const level = fixture()
    applyOp(level, { kind: 'insertOverrideChild', owner: 'p1', node: 'top', index: 0, child: node('flag') })
    return level
  }

  it('is undone back into its record, not under the placement', () => {
    const level = withFlag()
    const before = json(level)
    const undo = invertOp(level, { kind: 'removeNode', id: 'flag' })
    expect(undo).toMatchObject({ kind: 'insertOverrideChild', owner: 'p1', node: 'top', index: 0 })
    applyOp(level, { kind: 'removeNode', id: 'flag' })
    applyOp(level, undo!)
    expect(json(level)).toBe(before)
  })

  it('leaves no empty list behind when the last one goes', () => {
    const level = withFlag()
    applyOp(level, { kind: 'removeNode', id: 'flag' })
    expect(level.nodes[1]!.overrides!.top, 'the record keeps what it had, and nothing else').toEqual({ transform: { position: v3(0, 1, 0) }, params: { 'top-c': { friction: 2 } } })
  })

  it('refuses a moveNode, whose undo could not put it back in the record', () => {
    expect(() => invertOp(withFlag(), { kind: 'moveNode', id: 'flag', parent: 'b', index: 0 })).toThrow(OpError)
  })

  it('is under the placement for a hold', () => {
    const level = withFlag()
    expect(touchedRefs(level, { kind: 'removeNode', id: 'p1' }).map(refKey)).toContain('n:flag')
  })
})

describe('table scope', () => {
  it('edits the prefab definition in place — the object the placements resolve against', () => {
    const level = fixture()
    const def = level.prefabs!.pad!
    const before = json(level)
    const ops: Op[] = [
      { kind: 'setTransform', table: 'pad', id: 'top', transform: { position: v3(0, 3, 0) } },
      { kind: 'insertNode', table: 'pad', parent: 'root', index: 0, node: node('front') },
      { kind: 'setName', table: 'pad', id: 'root', name: 'pad!' },
    ]
    const { inverses } = applyBatch(level, ops)
    expect(level.prefabs!.pad, 'same object').toBe(def)
    expect(def.children!.map((c) => c.id)).toEqual(['front', 'top', 'leg'])
    expect(def.name).toBe('pad!')
    applyBatch(level, inverses)
    expect(json(level)).toBe(before)
  })

  it('refuses what a prefab cannot hold', () => {
    const level = fixture()
    expect(() => invertOp(level, { kind: 'removeNode', table: 'pad', id: 'root' })).toThrow(/root/)
    expect(() => invertOp(level, { kind: 'insertNode', table: 'pad', parent: null, index: 0, node: node('x') })).toThrow(/one root/)
    expect(() => invertOp(level, { kind: 'insertNode', table: 'pad', parent: 'root', index: 0, node: node('x', { prefab: 'pad' }) })).toThrow(OpError)
    expect(() => invertOp(level, { kind: 'setEnvironment', table: 'pad', environment: null })).toThrow(/no environment/)
    expect(() => invertOp(level, { kind: 'setTransform', table: 'nope', id: 'root', transform: { position: v3(0, 0, 0) } })).toThrow(/not in level.prefabs/)
  })
})

describe('refusals', () => {
  const level = fixture()
  it('unknown ids, duplicate ids, cycles, bad shapes, missing components', () => {
    expect(() => invertOp(level, { kind: 'setName', id: 'zzz', name: 'x' })).toThrow(/no node 'zzz'/)
    expect(() => invertOp(level, { kind: 'insertNode', parent: null, index: 0, node: node('a') })).toThrow(/already in level.nodes/)
    expect(() => invertOp(level, { kind: 'insertNode', parent: null, index: 0, node: node('n', { children: [node('a2x')] }) })).toThrow(/already in/)
    expect(() => invertOp(level, { kind: 'moveNode', id: 'a', parent: 'a2x', index: 0 })).toThrow(/own descendant/)
    expect(() => invertOp(level, { kind: 'setTransform', id: 'a', transform: { position: 'no' } as never })).toThrow(OpError)
    expect(() => invertOp(level, { kind: 'setParams', id: 'a', componentId: 'nope', patch: {} })).toThrow(/no component/)
    expect(() => invertOp(level, { kind: 'setOverrideName', owner: 'a', node: 'x', name: 'n' })).toThrow(/not a placement/)
    expect(() => invertOp(level, { kind: 'addComponent', id: 'a', component: comp('a-c', 'X') })).toThrow(/already on/)
    expect(() => invertOp(level, { kind: 'replaceNode', id: 'b', node: node('other') })).toThrow(/keeps the id/)
  })

  it('a refused op changes nothing, in applyOp and in applyBatch', () => {
    const before = json(level)
    expect(() => applyOp(level, { kind: 'removeNode', id: 'zzz' })).toThrow(OpError)
    expect(() => applyBatch(level, [{ kind: 'setName', id: 'a', name: 'changed' }, { kind: 'removeNode', id: 'zzz' }])).toThrow(OpError)
    expect(json(level)).toBe(before)
  })
})

describe('applyBatch', () => {
  it('returns the ops that did something and their inverses in undo order', () => {
    const level = fixture()
    const before = json(level)
    const r = applyBatch(level, [
      { kind: 'setName', id: 'b', name: 'B' },
      { kind: 'setName', id: 'a', name: 'A' }, // already A: dropped
      { kind: 'insertNode', parent: 'b', index: 0, node: node('bb') },
    ])
    expect(r.ops.map((o) => o.kind)).toEqual(['setName', 'insertNode'])
    expect(r.inverses.map((o) => o.kind)).toEqual(['removeNode', 'setName'])
    applyBatch(level, r.inverses)
    expect(json(level)).toBe(before)
  })
})

describe('touchedRefs', () => {
  const level = fixture()
  it('names the node for content, the subtree for structure, and what is seen through a placement', () => {
    expect(touchedRefs(level, { kind: 'setName', id: 'a', name: 'x' })).toEqual([{ id: 'a' }])
    expect(touchedRefs(level, { kind: 'removeNode', id: 'a' }).map(refKey)).toEqual(['n:a', 'n:a1', 'n:a2', 'n:a2x'])
    expect(touchedRefs(level, { kind: 'removeNode', id: 'p1' }).map(refKey)).toEqual(['n:p1', 'i:p1:top', 'i:p1:leg'])
    expect(touchedRefs(level, { kind: 'moveNode', id: 'b', parent: 'a', index: 0 }).map(refKey)).toEqual(['n:b', 'n:a'])
    expect(touchedRefs(level, { kind: 'setOverrideName', owner: 'p1', node: 'top', name: 'x' }).map(refKey)).toEqual(['i:p1:top'])
    expect(touchedRefs(level, { kind: 'setTransform', table: 'pad', id: 'top', transform: { position: v3(0, 0, 0) } }).map(refKey)).toEqual(['t:pad:top'])
    expect(touchedRefs(level, { kind: 'setMode', mode: null })).toEqual([])
  })
})

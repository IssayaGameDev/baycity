import { applyAssetOps, applyBatch, type AssetOp, type Level, type Op } from '@mp/content'
import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { assetSteps, levelSteps, planRedo, planUndo, squashTransforms, type LevelStep, type UndoStep } from './undoSteps'

/**
 * A turn undone as one (ADR 0194): what the agent wrote goes back, and what someone changed since stays theirs —
 * checked against the values when undoing, key by key for a component's fields.
 */

const level = (): Level => ({
  id: 'lv',
  config: {},
  nodes: [
    { id: 'a', transform: { position: vec3(0, 0, 0) }, components: [{ id: 'c', type: 'Spin', params: { speed: 1, axis: 'y' } }] },
    { id: 'b', transform: { position: vec3(5, 0, 0) }, components: [] },
  ],
})

const speedOf = (lv: Level, id = 'a'): unknown => lv.nodes.find((n) => n.id === id)?.components[0]?.params.speed
const axisOf = (lv: Level): unknown => lv.nodes[0]!.components[0]!.params.axis

/** The agent's edits: each batch applied as the document applies one, its steps gathered as the turn's. */
const turn = (lv: Level, ...batches: Op[][]): UndoStep[] => levelSteps(batches.map((ops) => applyBatch(lv, ops)))

/** Undo for real: the plan worked out, its level ops applied, its steps marked. */
const undo = (lv: Level, steps: UndoStep[], assetNow: (id: string) => unknown = () => undefined) => {
  const p = planUndo(steps, lv, assetNow)
  applyBatch(lv, p.level)
  p.done()
  return p
}
const redo = (lv: Level, steps: UndoStep[]) => {
  const p = planRedo(steps, lv, () => undefined)
  applyBatch(lv, p.level)
  p.done()
  return p
}

describe('undoing a turn nobody else touched', () => {
  it('takes back every step, the last first', () => {
    const lv = level()
    const before = structuredClone(lv)
    const steps = turn(
      lv,
      [{ kind: 'setParams', id: 'a', componentId: 'c', patch: { speed: 3 } }],
      [{ kind: 'setTransform', id: 'a', transform: { position: vec3(1, 2, 3) } }],
      [{ kind: 'insertNode', parent: 'a', index: 0, node: { id: 'n', transform: { position: vec3(0, 0, 0) }, components: [] } }],
      [{ kind: 'setName', id: 'n', name: 'New' }],
      [{ kind: 'removeNode', id: 'b' }],
    )
    const p = undo(lv, steps)
    expect(p.kept).toBe(0)
    expect(lv).toEqual(before)
  })
})

describe('what someone changed since stays theirs', () => {
  it('keeps their field and takes back the agent’s other field on the same component', () => {
    const lv = level()
    const steps = turn(lv, [{ kind: 'setParams', id: 'a', componentId: 'c', patch: { speed: 3, axis: 'x' } }])
    applyBatch(lv, [{ kind: 'setParams', id: 'a', componentId: 'c', patch: { speed: 9 } }]) // Bob
    const p = undo(lv, steps)
    expect(speedOf(lv)).toBe(9)
    expect(axisOf(lv)).toBe('y')
    expect(p.kept).toBe(1)
  })

  it('leaves a node the agent made when someone has changed it since, and takes back the agent’s own edits to it', () => {
    const lv = level()
    const steps = turn(
      lv,
      [{ kind: 'insertNode', parent: null, index: 2, node: { id: 'n', transform: { position: vec3(0, 0, 0) }, components: [] } }],
      [{ kind: 'setTransform', id: 'n', transform: { position: vec3(4, 0, 0) } }],
    )
    applyBatch(lv, [{ kind: 'setName', id: 'n', name: 'Bob’s' }]) // Bob
    const p = undo(lv, steps)
    const n = lv.nodes.find((x) => x.id === 'n')
    expect(n?.name).toBe('Bob’s')
    expect(n?.transform.position).toEqual(vec3(0, 0, 0))
    expect(p.kept).toBe(1)
  })

  it('takes a value back once a later edit of it has itself been undone: the value is checked, not who touched it', () => {
    const lv = level()
    const steps = turn(lv, [{ kind: 'setParams', id: 'a', componentId: 'c', patch: { speed: 3 } }])
    const mine = applyBatch(lv, [{ kind: 'setParams', id: 'a', componentId: 'c', patch: { speed: 7 } }])
    applyBatch(lv, mine.inverses) // that later edit, undone first: Ctrl+Z order
    undo(lv, steps)
    expect(speedOf(lv)).toBe(1)
  })

  it('gives up a step on a node someone has removed, without failing the rest', () => {
    const lv = level()
    const steps = turn(lv, [{ kind: 'setTransform', id: 'b', transform: { position: vec3(6, 0, 0) } }], [{ kind: 'setParams', id: 'a', componentId: 'c', patch: { speed: 3 } }])
    applyBatch(lv, [{ kind: 'removeNode', id: 'b' }]) // Bob
    const p = undo(lv, steps)
    expect(speedOf(lv)).toBe(1)
    expect(p.kept).toBe(1)
  })
})

describe('redoing a turn', () => {
  it('puts back what the undo took, and leaves a change made since the undo', () => {
    const lv = level()
    const steps = turn(lv, [{ kind: 'setParams', id: 'a', componentId: 'c', patch: { speed: 3, axis: 'x' } }], [{ kind: 'setTransform', id: 'b', transform: { position: vec3(8, 0, 0) } }])
    undo(lv, steps)
    applyBatch(lv, [{ kind: 'setParams', id: 'a', componentId: 'c', patch: { axis: 'z' } }]) // Bob, after the undo
    const p = redo(lv, steps)
    expect(speedOf(lv)).toBe(3)
    expect(axisOf(lv)).toBe('z')
    expect(lv.nodes[1]!.transform.position).toEqual(vec3(8, 0, 0))
    expect(p.kept).toBe(1)
  })

  it('does not put back a step its undo gave up', () => {
    const lv = level()
    const steps = turn(lv, [{ kind: 'setParams', id: 'a', componentId: 'c', patch: { speed: 3 } }])
    applyBatch(lv, [{ kind: 'setParams', id: 'a', componentId: 'c', patch: { speed: 9 } }]) // Bob
    undo(lv, steps)
    // Bob's value, by chance, back to what the agent's undo would have left.
    applyBatch(lv, [{ kind: 'setParams', id: 'a', componentId: 'c', patch: { speed: 1 } }])
    redo(lv, steps)
    expect(speedOf(lv)).toBe(1)
  })

  it('undoes a redone turn again', () => {
    const lv = level()
    const before = structuredClone(lv)
    const steps = turn(lv, [{ kind: 'setParams', id: 'a', componentId: 'c', patch: { speed: 3 } }], [{ kind: 'removeNode', id: 'b' }])
    undo(lv, steps)
    redo(lv, steps)
    expect(lv.nodes.map((n) => n.id)).toEqual(['a'])
    undo(lv, steps)
    expect(lv).toEqual(before)
  })
})

describe('a turn’s edits to a material', () => {
  const material = () => ({ shader: 'standard', params: { color: { kind: 'color', value: '#000000' }, roughness: { kind: 'number', value: 0.5 } } })
  /** The agent's material edit, applied as the shell applies one: its inverses in undo order. */
  const edit = (json: unknown, ops: AssetOp[]) => {
    const applied = applyAssetOps(json, ops)
    return { json: applied.json, steps: assetSteps('m', ops, applied.inverses.reverse()) }
  }

  it('takes back the agent’s colour, and keeps a field someone changed since', () => {
    const lv = level()
    const ops: AssetOp[] = [
      { kind: 'set', path: ['params', 'color', 'value'], value: '#ff0000' },
      { kind: 'set', path: ['params', 'roughness', 'value'], value: 0.9 },
    ]
    const made = edit(material(), ops)
    // Bob, since: the roughness.
    const now = applyAssetOps(made.json, [{ kind: 'set', path: ['params', 'roughness', 'value'], value: 0.1 }]).json
    const p = planUndo(made.steps, lv, () => now)
    expect(p.assets.get('m')).toEqual([{ kind: 'set', path: ['params', 'color', 'value'], value: '#000000' }])
    expect(p.kept).toBe(1)
  })
})

describe('steps kept for an undo', () => {
  it('squashes a drag to one step per object: its last value, and what it was before the first', () => {
    const lv = level()
    const batches = [1, 2, 3].map((x) =>
      applyBatch(lv, [
        { kind: 'setTransform', id: 'a', transform: { position: vec3(x, 0, 0) } },
        { kind: 'setTransform', id: 'b', transform: { position: vec3(5 + x, 0, 0) } },
      ]),
    )
    const steps: LevelStep[] = squashTransforms(levelSteps(batches))
    expect(steps.map((s) => [s.op, s.inverse])).toEqual([
      [{ kind: 'setTransform', id: 'a', transform: { position: vec3(3, 0, 0) } }, { kind: 'setTransform', id: 'a', transform: { position: vec3(0, 0, 0) } }],
      [{ kind: 'setTransform', id: 'b', transform: { position: vec3(8, 0, 0) } }, { kind: 'setTransform', id: 'b', transform: { position: vec3(5, 0, 0) } }],
    ])
  })

  it('does not squash across anything but transforms', () => {
    const lv = level()
    const batches = [
      applyBatch(lv, [{ kind: 'setTransform', id: 'a', transform: { position: vec3(1, 0, 0) } }]),
      applyBatch(lv, [{ kind: 'setName', id: 'a', name: 'x' }]),
      applyBatch(lv, [{ kind: 'setTransform', id: 'a', transform: { position: vec3(2, 0, 0) } }]),
    ]
    expect(squashTransforms(levelSteps(batches))).toHaveLength(3)
  })

  it('keeps a merged gesture’s old value of a field inside an object it then set whole', () => {
    // A field set, then its whole object: the object's undo puts back the field's value from before both.
    const steps = assetSteps(
      'm',
      [{ kind: 'set', path: ['params', 'color'], value: { kind: 'color', value: '#00ff00' } }],
      [
        { kind: 'set', path: ['params', 'color'], value: { kind: 'color', value: '#ff0000' } },
        { kind: 'set', path: ['params', 'color', 'value'], value: '#000000' },
      ],
    )
    expect(steps).toHaveLength(1)
    const now = { shader: 'standard', params: { color: { kind: 'color', value: '#00ff00' } } }
    const p = planUndo(steps, level(), () => now)
    expect(applyAssetOps(now, p.assets.get('m')!).json).toEqual({ shader: 'standard', params: { color: { kind: 'color', value: '#000000' } } })
  })
})

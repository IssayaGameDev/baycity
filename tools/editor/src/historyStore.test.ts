// @vitest-environment happy-dom
import { applyAssetOps, COLLIDER, RENDERER, type AssetOp, type Level, type Op } from '@mp/content'
import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { levelDoc } from './editorDoc'
import { createHistoryStore, type HistoryHost } from './historyStore'

/**
 * An undo redraws the way a remote batch does (`liveSession.ts`'s repaint): undoing a move puts the object back
 * where the data says, rather than rebuilding the sky, every mesh and the physics world — twice — which on a
 * level of a few hundred objects was the second an undo took.
 */

const level = (): Level => ({
  id: 'lv',
  config: {},
  nodes: [
    {
      id: 'a',
      transform: { position: vec3(0, 0, 0) },
      components: [
        { id: 'c', type: COLLIDER, params: { shape: { kind: 'box', halfExtents: vec3(0.5, 0.5, 0.5) } } },
        { id: 'r', type: RENDERER, params: { model: 'builtin:box', material: '' } },
      ],
    },
  ],
})

const rig = () => {
  const lv = level()
  const calls = { repaints: [] as (readonly Op[])[], rebuilds: 0, selections: [] as (readonly number[])[], assets: [] as { id: string; ops: readonly AssetOp[] }[] }
  /** The materials, as `assetSync` would show them: an asset undo applies its ops here. */
  const materials = new Map<string, unknown>([['m', { shader: 'standard', params: { color: { kind: 'color', value: '#000000' } } }]])
  let doc = levelDoc(lv)
  const host: HistoryHost = {
    doc: () => doc,
    rootDoc: () => doc,
    rootLevel: () => lv,
    selection: () => [0],
    selected: () => 0,
    selectionRefs: () => [{ id: 'a' }],
    selectionRoots: () => [0],
    applySelection: (indices) => void calls.selections.push(indices),
    deleteSelected: () => {},
    live: () => true,
    submit: () => {},
    fileName: () => 'lv',
    readOnlyBy: () => null,
    claimFileLock: async () => null,
    hydratedPrefabs: () => [],
    afterSave: async () => {},
    rebuildViewport: () => void calls.rebuilds++,
    repaint: (ops) => void calls.repaints.push(ops),
    loadNewReferencesThen: () => {},
    applyAsset: (id, ops) => {
      if (!materials.has(id)) return false
      materials.set(id, applyAssetOps(materials.get(id), ops).json)
      calls.assets.push({ id, ops })
      return true
    },
    notify: { ok: () => {}, warn: () => {}, error: () => {} },
    renderStatus: () => {},
    refreshUi: () => {},
  }
  const history = createHistoryStore(host)
  doc = history.withOps(doc)
  /** A material edit made the way the shell makes one: the ops applied, the inverses from applying them. */
  const colour = (value: string, ongoing = false, id = 'm'): void => {
    const ops: AssetOp[] = [{ kind: 'set', path: ['params', 'color', 'value'], value }]
    const applied = applyAssetOps(materials.get(id), ops)
    materials.set(id, applied.json)
    history.recordAsset({ assetId: id, ops, inverses: applied.inverses.reverse(), label: 'm colour' }, ongoing)
  }
  const colourOf = (id = 'm'): unknown => (materials.get(id) as { params: { color: { value: string } } }).params.color.value
  return { lv, doc: () => doc, history, calls, materials, colour, colourOf }
}

describe('undoing a move', () => {
  it('puts the data back and hands the repaint only the transform, rebuilding nothing', () => {
    const { lv, doc, history, calls } = rig()
    doc().setTransform(0, { position: vec3(4, 0, 0) })
    history.recordEdit('move')
    history.undo()
    expect(lv.nodes[0]!.transform.position).toEqual(vec3(0, 0, 0))
    expect(calls.repaints).toHaveLength(1)
    expect(calls.repaints[0]!.map((o) => o.kind)).toEqual(['setTransform'])
    expect(calls.rebuilds, 'no rebuild of every mesh and the physics world').toBe(0)
    expect(calls.selections.at(-1), 'and what was selected is selected again').toEqual([0])
  })

  it('redraws a redo the same way', () => {
    const { lv, doc, history, calls } = rig()
    doc().setTransform(0, { position: vec3(4, 0, 0) })
    history.recordEdit('move')
    history.undo()
    history.redo()
    expect(lv.nodes[0]!.transform.position).toEqual(vec3(4, 0, 0))
    expect(calls.repaints.map((ops) => ops.map((o) => o.kind))).toEqual([['setTransform'], ['setTransform']])
    expect(calls.rebuilds).toBe(0)
  })
})

describe('one history for the level and its materials (ADR 0159)', () => {
  it('undoes them in the order they were made, whichever kind came last', () => {
    const { lv, doc, history, colour, colourOf } = rig()
    doc().setTransform(0, { position: vec3(4, 0, 0) })
    history.recordEdit('move')
    colour('#ff0000')
    doc().setTransform(0, { position: vec3(8, 0, 0) })
    history.recordEdit('move')
    expect(history.labels().undo).toBe('move')
    history.undo()
    expect(lv.nodes[0]!.transform.position).toEqual(vec3(4, 0, 0))
    expect(colourOf(), 'the material waits its turn').toBe('#ff0000')
    expect(history.labels().undo).toBe('m colour')
    history.undo()
    expect(colourOf()).toBe('#000000')
    expect(lv.nodes[0]!.transform.position, 'the level waits its turn').toEqual(vec3(4, 0, 0))
    history.undo()
    expect(lv.nodes[0]!.transform.position).toEqual(vec3(0, 0, 0))
    history.redo()
    history.redo()
    expect(colourOf(), 'and redo puts it back').toBe('#ff0000')
  })

  it('makes a colour drag one entry, back to the colour before it', () => {
    const { history, colour, colourOf } = rig()
    colour('#110000', true)
    colour('#220000', true)
    colour('#330000', true)
    colour('#330000', false) // the picker closes on the colour the drag ended on: no ops, the entry ends
    expect(history.depth().undo).toBe(1)
    colour('#440000', true)
    expect(history.depth().undo, 'the next drag is its own entry').toBe(2)
    history.undo()
    expect(colourOf()).toBe('#330000')
    history.undo()
    expect(colourOf()).toBe('#000000')
  })

  it('ends a drag at any other entry', () => {
    const { doc, history, colour } = rig()
    colour('#110000', true)
    doc().setTransform(0, { position: vec3(4, 0, 0) })
    history.recordEdit('move')
    colour('#220000', true)
    expect(history.depth().undo).toBe(3)
  })

  it('drops an entry whose asset is gone, and leaves asset entries to refused level batches', () => {
    const { history, colour, materials, calls } = rig()
    colour('#110000')
    history.dropWhere(() => true)
    expect(history.depth().undo, 'a refused level batch is not a material edit').toBe(1)
    materials.delete('m')
    history.undo()
    expect(calls.assets).toHaveLength(0)
    expect(history.depth(), 'gone, not waiting to redo').toEqual({ undo: 0, redo: 0 })
  })
})

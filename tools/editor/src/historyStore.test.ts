// @vitest-environment happy-dom
import { COLLIDER, RENDERER, type Level, type Op } from '@mp/content'
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
  const calls = { repaints: [] as (readonly Op[])[], rebuilds: 0, selections: [] as (readonly number[])[] }
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
    setStatus: () => {},
    renderStatus: () => {},
    refreshUi: () => {},
  }
  const history = createHistoryStore(host)
  doc = history.withOps(doc)
  return { lv, doc: () => doc, history, calls }
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

import { describe, expect, it } from 'vitest'

import type { Op } from '@mp/content'

import { createOpHistory, foldBatches } from './opHistory'

const t = (id: string, x: number): Op => ({ kind: 'setTransform', id, transform: { position: { x, y: 0, z: 0 } } })
const name = (id: string, n: string): Op => ({ kind: 'setName', id, name: n })

describe('op history', () => {
  it('undo hands back entries newest first and redo walks forward again; a push clears redo', () => {
    const h = createOpHistory()
    const a = { ops: [t('a', 1)], inverses: [t('a', 0)], label: 'move', selection: [] }
    const b = { ops: [name('a', 'x')], inverses: [name('a', 'y')], label: 'rename', selection: [] }
    h.push(a)
    h.push(b)
    expect(h.undoLabel()).toBe('rename')
    expect(h.undo()).toBe(b)
    expect(h.redoLabel()).toBe('rename')
    expect(h.undo()).toBe(a)
    expect(h.undo()).toBeNull()
    expect(h.redo()).toBe(a)
    h.push(b)
    expect(h.canRedo()).toBe(false)
    expect(h.depth()).toEqual({ undo: 2, redo: 0 })
  })

  it('keeps at most the limit', () => {
    const h = createOpHistory(2)
    for (let i = 0; i < 5; i++) h.push({ ops: [t('a', i)], inverses: [t('a', i - 1)], label: String(i), selection: [] })
    expect(h.depth().undo).toBe(2)
    expect(h.undoLabel()).toBe('4')
  })
})

describe('foldBatches', () => {
  it('a drag of many transforms on one node is one op with the first inverse and the last value', () => {
    const batches = [1, 2, 3].map((x) => ({ ops: [t('a', x)], inverses: [t('a', x - 1)] }))
    const e = foldBatches(batches, 'move', [{ id: 'a' }])!
    expect(e.ops).toEqual([t('a', 3)])
    expect(e.inverses).toEqual([t('a', 0)])
    expect(e.label).toBe('move')
  })

  it('other ops keep their order and inverses come out in undo order', () => {
    const e = foldBatches(
      [
        { ops: [name('a', 'x')], inverses: [name('a', 'a')] },
        { ops: [t('b', 5)], inverses: [t('b', 0)] },
        { ops: [name('b', 'y')], inverses: [name('b', 'b')] },
      ],
      'edit',
      [],
    )!
    expect(e.ops.map((o) => o.kind)).toEqual(['setName', 'setTransform', 'setName'])
    expect(e.inverses).toEqual([name('b', 'b'), t('b', 0), name('a', 'a')])
  })

  it('nothing to fold is null', () => {
    expect(foldBatches([], 'x', [])).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'

import { createHistory } from './history'

interface Doc {
  n: number
  tags?: string[]
}

const history = (limit?: number) =>
  createHistory<Doc>({ clone: (v) => structuredClone(v), ...(limit !== undefined ? { limit } : {}) })

describe('createHistory', () => {
  it('starts with nothing to undo or redo', () => {
    const h = history()
    expect(h.canUndo()).toBe(false)
    expect(h.canRedo()).toBe(false)
    expect(h.undo({ n: 1 })).toBeNull()
    expect(h.redo({ n: 1 })).toBeNull()
  })

  it('steps back over one edit', () => {
    const h = history()
    h.push({ n: 1 }, 'move')
    expect(h.undo({ n: 2 })).toEqual({ data: { n: 1 }, label: 'move' })
  })

  it('steps forward again', () => {
    const h = history()
    h.push({ n: 1 }, 'move')
    h.undo({ n: 2 })
    expect(h.redo({ n: 1 })).toEqual({ data: { n: 2 }, label: 'move' })
  })

  it('walks a run of edits back and forward in order', () => {
    const h = history()
    h.push({ n: 0 }, 'a')
    h.push({ n: 1 }, 'b')
    h.push({ n: 2 }, 'c')
    // Live state is 3 after three edits.
    expect(h.undo({ n: 3 })!.data.n).toBe(2)
    expect(h.undo({ n: 2 })!.data.n).toBe(1)
    expect(h.undo({ n: 1 })!.data.n).toBe(0)
    expect(h.undo({ n: 0 }), 'and no further').toBeNull()

    expect(h.redo({ n: 0 })!.data.n).toBe(1)
    expect(h.redo({ n: 1 })!.data.n).toBe(2)
    expect(h.redo({ n: 2 })!.data.n).toBe(3)
    expect(h.redo({ n: 3 })).toBeNull()
  })

  // Redoing past a new edit has no meaning: the branch it belonged to is gone.
  it('drops the redo branch when a new edit is recorded', () => {
    const h = history()
    h.push({ n: 1 }, 'a')
    h.undo({ n: 2 })
    expect(h.canRedo()).toBe(true)

    h.push({ n: 1 }, 'b')
    expect(h.canRedo()).toBe(false)
    expect(h.redo({ n: 9 })).toBeNull()
  })

  /**
   * The footgun this design has to close. The editor mutates its document *in place*, so if the stack held the
   * caller's object rather than a clone, every later edit would rewrite the snapshot and undo would restore
   * the present.
   */
  it('clones on the way in, so a later mutation cannot rewrite history', () => {
    const h = history()
    const live: Doc = { n: 1, tags: ['first'] }
    h.push(live, 'edit')

    live.n = 99
    live.tags!.push('second')

    const restored = h.undo(live)!
    expect(restored.data.n).toBe(1)
    expect(restored.data.tags, 'deeply, not just the top level').toEqual(['first'])
  })

  // A restored state is popped off the stack, so the caller owns it outright — the guarantee that matters is
  // that walking back and forth without touching anything is stable.
  it('round-trips a state unchanged through undo, redo and undo again', () => {
    const h = history()
    h.push({ n: 1, tags: ['a'] }, 'edit')
    const back = h.undo({ n: 2, tags: ['a', 'b'] })!
    expect(back.data).toEqual({ n: 1, tags: ['a'] })
    const forward = h.redo(back.data)!
    expect(forward.data).toEqual({ n: 2, tags: ['a', 'b'] })
    expect(h.undo(forward.data)!.data, 'and back again').toEqual({ n: 1, tags: ['a'] })
  })

  it('clones the live state it captures for redo', () => {
    const h = history()
    h.push({ n: 1 }, 'edit')
    const live: Doc = { n: 2 }
    h.undo(live)
    live.n = 99
    expect(h.redo({ n: 1 })!.data.n).toBe(2)
  })

  it('names the edit each direction would step over', () => {
    const h = history()
    expect(h.undoLabel()).toBeNull()
    h.push({ n: 1 }, 'move platform')
    expect(h.undoLabel()).toBe('move platform')
    expect(h.redoLabel()).toBeNull()

    h.undo({ n: 2 })
    expect(h.undoLabel()).toBeNull()
    expect(h.redoLabel(), 'the same edit, named the same way in both directions').toBe('move platform')
  })

  it('drops the oldest step past the limit rather than growing without bound', () => {
    const h = history(3)
    for (let n = 0; n < 6; n++) h.push({ n }, `edit ${n}`)
    expect(h.depth()).toEqual({ undo: 3, redo: 0 })

    // The three kept are the newest three, so the oldest reachable state is 3, not 0.
    expect(h.undo({ n: 6 })!.data.n).toBe(5)
    expect(h.undo({ n: 5 })!.data.n).toBe(4)
    expect(h.undo({ n: 4 })!.data.n).toBe(3)
    expect(h.undo({ n: 3 })).toBeNull()
  })

  it('treats a limit of zero as one, rather than as an unusable stack', () => {
    const h = createHistory<Doc>({ clone: structuredClone, limit: 0 })
    h.push({ n: 1 }, 'a')
    expect(h.canUndo()).toBe(true)
  })

  it('forgets everything on clear, since another file is not this one', () => {
    const h = history()
    h.push({ n: 1 }, 'a')
    h.undo({ n: 2 })
    h.clear()
    expect(h.depth()).toEqual({ undo: 0, redo: 0 })
    expect(h.canUndo()).toBe(false)
    expect(h.canRedo()).toBe(false)
  })

  it('reports its depth, which is what enables or greys a menu item', () => {
    const h = history()
    h.push({ n: 1 }, 'a')
    h.push({ n: 2 }, 'b')
    expect(h.depth()).toEqual({ undo: 2, redo: 0 })
    h.undo({ n: 3 })
    expect(h.depth()).toEqual({ undo: 1, redo: 1 })
  })
})

import { describe, expect, it } from 'vitest'

import { describeCommit, markDirty, take, takeAll, takeDue, type SessionTable } from './sessions'

const A = { name: 'Ada', email: 'ada@x' }
const B = { name: 'Bob', email: 'bob@x' }

describe('sessions', () => {
  it('collects a user’s dirty paths and hands them over once', () => {
    const t: SessionTable = new Map()
    markDirty(t, A, ['content/levels/a.json'], 0)
    markDirty(t, A, ['content/levels/a.json', 'content/assets/x.png'], 5)
    expect(take(t, B)).toBeNull()
    const s = take(t, A)
    expect(s?.since).toBe(0)
    expect([...(s?.dirty ?? [])]).toEqual(['content/levels/a.json', 'content/assets/x.png'])
    expect(take(t, A)).toBeNull()
  })

  it('takeDue takes only sessions older than the safety interval', () => {
    const t: SessionTable = new Map()
    markDirty(t, A, ['a'], 0)
    markDirty(t, B, ['b'], 500)
    expect(takeDue(t, 1000, 1000).map((s) => s.user)).toEqual([A])
    expect(t.has(A.email)).toBe(false)
    expect(t.get(B.email)?.user).toEqual(B)
  })

  it('takeAll empties the table', () => {
    const t: SessionTable = new Map()
    markDirty(t, A, ['a'], 0)
    markDirty(t, B, ['b'], 0)
    expect(takeAll(t)).toHaveLength(2)
    expect(t.size).toBe(0)
  })
})

describe('describeCommit', () => {
  it('names one thing, counts the rest, folds sidecars', () => {
    expect(describeCommit(['content/levels/keyboard.json'])).toBe('Edit level keyboard')
    expect(describeCommit(['content/assets/textures/warn.png', 'content/assets/textures/warn.png.meta'])).toBe('Edit texture warn.png')
    expect(describeCommit(['content/assets/prefabs/Trampoline.prefab.json', 'content/assets/materials/goal.mat.json'])).toBe(
      'Edit material goal and 1 more',
    )
    expect(describeCommit(['content/games/keyboard.json'])).toBe('Edit the keyboard component list')
    expect(describeCommit(['content/assets/animations/rise.anim.json', 'content/assets/models/crate.glb'])).toBe('Edit clip rise and 1 more')
    expect(describeCommit([])).toBe('Edit content')
  })
})

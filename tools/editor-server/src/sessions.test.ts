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
  it('names a thing the way a person calls it, sidecars folded', () => {
    expect(describeCommit(['content/keyboard/levels/Roblox.level.json'])).toBe('Edit Roblox level')
    expect(describeCommit(['content/assets/textures/warn.png', 'content/assets/textures/warn.png.meta'])).toBe('Edit warn texture')
    expect(describeCommit(['content/keyboard/game.json'])).toBe('Edit keyboard settings')
    expect(describeCommit(['content/keyboard/assets/prefabs/pad.prefab.json'])).toBe('Edit pad prefab')
    expect(describeCommit(['content/assets/animations/rise.anim.json'])).toBe('Edit rise clip')
    expect(describeCommit([])).toBe('Edit content')
  })

  it('puts levels first, then settings, then assets, and names up to three', () => {
    expect(describeCommit(['content/assets/materials/red.mat.json', 'content/keyboard/levels/Roblox.level.json'])).toBe('Edit Roblox level and red material')
    expect(describeCommit(['content/assets/materials/red.mat.json', 'content/keyboard/game.json', 'content/keyboard/levels/Roblox.level.json'])).toBe(
      'Edit Roblox level, keyboard settings and red material',
    )
    expect(
      describeCommit(['content/assets/materials/red.mat.json', 'content/assets/models/crate.glb', 'content/keyboard/game.json', 'content/keyboard/levels/Roblox.level.json']),
    ).toBe('Edit Roblox level, keyboard settings, crate model and 1 more')
  })
})

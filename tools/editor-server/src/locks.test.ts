import { describe, expect, it } from 'vitest'

import { acquire, blocker, heartbeat, heldBy, holder, release, sweep, type LockTable } from './locks'

const A = { name: 'Ada', email: 'ada@x' }
const B = { name: 'Bob', email: 'bob@x' }
const rules = { staleMs: 1000 }
const L = 'content/levels/keyboard.json'

describe('locks', () => {
  it('a live lock refuses everyone else and refreshes for its owner', () => {
    const t: LockTable = {}
    expect(acquire(t, L, A, 0, rules).ok).toBe(true)
    expect(acquire(t, L, B, 500, rules)).toEqual({ ok: false, owner: A })
    const again = acquire(t, L, A, 900, rules)
    expect(again.ok && again.lock.since).toBe(0)
    expect(t[L]?.seen).toBe(900)
  })

  it('a stale lock is anyone’s', () => {
    const t: LockTable = {}
    acquire(t, L, A, 0, rules)
    expect(holder(t, L, 999, rules)).toEqual(A)
    expect(holder(t, L, 1000, rules)).toBeNull()
    const r = acquire(t, L, B, 1000, rules)
    expect(r.ok && r.lock.owner).toEqual(B)
    expect(r.ok && r.lock.since).toBe(1000)
  })

  it('blocker: unlocked, stale or mine is null; someone else live is them', () => {
    const t: LockTable = {}
    expect(blocker(t, L, B, 0, rules)).toBeNull()
    acquire(t, L, A, 0, rules)
    expect(blocker(t, L, B, 10, rules)).toEqual(A)
    expect(blocker(t, L, A, 10, rules)).toBeNull()
    expect(blocker(t, L, B, 5000, rules)).toBeNull()
  })

  it('release drops only your own lock', () => {
    const t: LockTable = {}
    acquire(t, L, A, 0, rules)
    expect(release(t, L, B)).toBe(false)
    expect(t[L]).toBeDefined()
    expect(release(t, L, A)).toBe(true)
    expect(t[L]).toBeUndefined()
  })

  it('heartbeat refreshes yours and reports the ones you lost', () => {
    const t: LockTable = {}
    acquire(t, L, A, 0, rules)
    acquire(t, 'other', B, 0, rules)
    expect(heartbeat(t, [L, 'other', 'never'], A, 700)).toEqual(['other', 'never'])
    expect(t[L]?.seen).toBe(700)
    expect(heldBy(t, A)).toEqual([L])
  })

  it('sweep drops stale locks and returns them', () => {
    const t: LockTable = {}
    acquire(t, L, A, 0, rules)
    acquire(t, 'fresh', B, 900, rules)
    const dropped = sweep(t, 1000, rules)
    expect(dropped.map((l) => l.owner)).toEqual([A])
    expect(Object.keys(t)).toEqual(['fresh'])
  })
})

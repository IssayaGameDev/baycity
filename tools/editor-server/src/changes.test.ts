import { describe, expect, it, vi } from 'vitest'

import { createChangeFeed } from './changes'

describe('change feed', () => {
  it('numbers batches and folds everything after a position into one', () => {
    const f = createChangeFeed()
    expect(f.since(0)).toEqual({ seq: 0, paths: [] })
    f.record(['a'])
    f.record(['b', 'a'])
    f.record([])
    expect(f.seq()).toBe(2)
    expect(f.since(0)).toEqual({ seq: 2, paths: ['a', 'b'] })
    expect(f.since(1)).toEqual({ seq: 2, paths: ['b', 'a'] })
    expect(f.since(2)).toEqual({ seq: 2, paths: [] })
    expect(f.since(9), 'ahead of the feed: the server restarted').toBeNull()
  })

  it('forgets beyond its bound and says so', () => {
    const f = createChangeFeed(2)
    f.record(['a'])
    f.record(['b'])
    f.record(['c'])
    expect(f.since(0)).toBeNull()
    expect(f.since(1)).toEqual({ seq: 3, paths: ['b', 'c'] })
  })

  it('wait resolves on the next record, or empty on timeout', async () => {
    vi.useFakeTimers()
    const f = createChangeFeed()
    const p = f.wait(0, 1000)
    f.record(['x'])
    expect(await p).toEqual({ seq: 1, paths: ['x'] })
    const q = f.wait(1, 1000)
    vi.advanceTimersByTime(1000)
    expect(await q).toEqual({ seq: 1, paths: [] })
    expect(await f.wait(5, 1000)).toBeNull()
    vi.useRealTimers()
  })
})

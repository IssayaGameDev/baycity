import { describe, expect, it } from 'vitest'

import { latestWriter } from './assetsApi'

/**
 * A material's saves (ADR 0157): one in flight per material, the newest waiting behind it — so a drag's saves
 * cannot land out of order, and as many as the network allows collapse into one.
 */

/** A write that finishes only when told to, recording the value it wrote. */
const rig = () => {
  let value = 0
  const written: number[] = []
  const pending: (() => void)[] = []
  const run = (): Promise<void> => {
    const v = value
    return new Promise<void>((resolve) => {
      pending.push(() => {
        written.push(v)
        resolve()
      })
    })
  }
  const settle = async (): Promise<void> => {
    await Promise.resolve()
    await Promise.resolve()
  }
  return { set: (v: number) => void (value = v), run, written, finishNext: () => pending.shift()?.(), pending: () => pending.length, settle }
}

describe('latestWriter', () => {
  it('writes once at a time, then once more with the newest value however often it was asked', async () => {
    const r = rig()
    const w = latestWriter()
    r.set(1)
    const first = w.write('m', r.run)
    for (const v of [2, 3, 4, 5]) {
      r.set(v)
      void w.write('m', r.run)
    }
    expect(r.pending(), 'one in flight').toBe(1)
    r.finishNext()
    await r.settle()
    expect(r.pending(), 'then one more').toBe(1)
    r.finishNext()
    await first
    expect(r.written).toEqual([1, 5])
  })

  it('resolves a later ask only once its value, or a newer one, is written', async () => {
    const r = rig()
    const w = latestWriter()
    r.set(1)
    void w.write('m', r.run)
    r.set(2)
    let done = false
    void w.write('m', r.run).then(() => void (done = true))
    r.finishNext()
    await r.settle()
    expect(done, 'value 1 is not value 2').toBe(false)
    r.finishNext()
    await r.settle()
    expect(done).toBe(true)
  })

  it('keeps keys apart, and starts afresh after a failure', async () => {
    const w = latestWriter()
    const order: string[] = []
    await Promise.all([w.write('a', async () => void order.push('a')), w.write('b', async () => void order.push('b'))])
    expect(order.sort()).toEqual(['a', 'b'])
    await expect(w.write('a', () => Promise.reject(new Error('offline')))).rejects.toThrow('offline')
    await w.write('a', async () => void order.push('a again'))
    expect(order).toContain('a again')
  })
})

import { describe, expect, it } from 'vitest'

import { LiveError } from './live'
import { createLiveAssets, type AssetEvent } from './liveAssets'

/**
 * Data-file assets as live documents (ADR 0159): an edit applies in arrival order, reaches every editor, is
 * written behind, and never waits on a lock.
 */

const M = 'mmmmmmmmmmmmmmmm'
const ADA = { name: 'Ada', email: 'ada@x' }
const BOB = { name: 'Bob', email: 'bob@x' }
const red = () => ({ shader: 'standard', params: { color: { kind: 'color', value: '#ff0000' } } })

const world = () => {
  const disk = new Map<string, unknown>([[M, red()]])
  const writes: unknown[] = []
  const changed: { users: string[]; path: string }[] = []
  const sent: { event: string; data: AssetEvent }[] = []
  const timers: { fn: () => void; at: number; live: boolean }[] = []
  let clock = 1000
  const assets = createLiveAssets({
    read: (id) => (disk.has(id) ? { kind: 'material', json: structuredClone(disk.get(id)) } : null),
    write: (id, json) => {
      if (!disk.has(id)) return null
      disk.set(id, structuredClone(json))
      writes.push(structuredClone(json))
      return `content/assets/materials/${id}.mat.json`
    },
    changed: (users, path) => changed.push({ users: users.map((u) => u.name), path }),
    connection: (connId) => (connId === 'a' ? { user: ADA } : connId === 'b' ? { user: BOB } : null),
    broadcast: (event, data) => sent.push({ event, data: data as AssetEvent }),
    now: () => clock,
    schedule: (fn, ms) => {
      const t = { fn, at: clock + ms, live: true }
      timers.push(t)
      return () => void (t.live = false)
    },
  })
  const advance = (ms: number): void => {
    clock += ms
    for (const t of timers.filter((x) => x.live && x.at <= clock)) {
      t.live = false
      t.fn()
    }
  }
  return { assets, disk, writes, changed, sent, advance }
}

const setColour = (value: string) => [{ kind: 'set' as const, path: ['params', 'color', 'value'], value }]

describe('live assets', () => {
  it('applies in arrival order, numbers each batch and sends it to every editor, the sender included', () => {
    const w = world()
    expect(w.assets.apply(M, 'a', ADA, { batchId: 'a1', ops: setColour('#00ff00') })).toEqual({ ok: true, seq: 1 })
    expect(w.assets.apply(M, 'b', BOB, { batchId: 'b1', ops: setColour('#0000ff') })).toEqual({ ok: true, seq: 2 })
    expect(w.sent.map((s) => [s.event, s.data.seq, s.data.from, s.data.batchId])).toEqual([
      ['asset', 1, 'a', 'a1'],
      ['asset', 2, 'b', 'b1'],
    ])
    expect(w.sent[0]!.data.epoch, 'numbered within this process').toBe(1000)
    expect((w.assets.current(M)!.json as ReturnType<typeof red>).params.color.value, 'the last to land stays').toBe('#0000ff')
  })

  it('writes behind, after the idle time, naming everyone who edited', () => {
    const w = world()
    w.assets.apply(M, 'a', ADA, { batchId: '1', ops: setColour('#010101') })
    w.assets.apply(M, 'b', BOB, { batchId: '2', ops: setColour('#020202') })
    expect(w.writes).toHaveLength(0)
    w.advance(600)
    expect(w.writes).toHaveLength(1)
    expect(w.changed).toEqual([{ users: ['Ada', 'Bob'], path: `content/assets/materials/${M}.mat.json` }])
    w.assets.flushAll()
    expect(w.writes, 'nothing new: nothing written').toHaveLength(1)
  })

  it('refuses a batch that breaks the file, an unknown or foreign connection, and an asset that is not there', () => {
    const w = world()
    const status = (fn: () => void): number => {
      try {
        fn()
      } catch (e) {
        return (e as LiveError).status
      }
      return 0
    }
    expect(status(() => w.assets.apply(M, 'a', ADA, { batchId: 'x', ops: [{ kind: 'unset', path: ['shader'] }] }))).toBe(400)
    expect(status(() => w.assets.apply(M, 'a', ADA, { batchId: 'x', ops: [{ kind: 'set', path: ['shader', 'x'], value: 1 }] }))).toBe(400)
    expect(status(() => w.assets.apply(M, 'zz', ADA, { batchId: 'x', ops: setColour('#fff') }))).toBe(400)
    expect(status(() => w.assets.apply(M, 'a', BOB, { batchId: 'x', ops: setColour('#fff') }))).toBe(400)
    expect(status(() => w.assets.apply('nnnnnnnnnnnnnnnn', 'a', ADA, { batchId: 'x', ops: setColour('#fff') }))).toBe(404)
    expect(w.assets.current(M)!.seq, 'nothing refused was counted').toBe(0)
    expect(w.sent).toEqual([])
  })

  it('forgets a deleted asset, unwritten edits and all', () => {
    const w = world()
    w.assets.apply(M, 'a', ADA, { batchId: '1', ops: setColour('#010101') })
    w.assets.forget(M)
    w.advance(10_000)
    expect(w.writes).toHaveLength(0)
    expect(w.assets.current(M)).toBeNull()
  })
})

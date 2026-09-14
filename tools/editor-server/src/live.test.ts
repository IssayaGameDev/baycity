import { describe, expect, it } from 'vitest'

import type { Level, Op } from '../../../packages/content/src/index'
import { createLive, LiveError, type LiveClient } from './live'

const v3 = (x: number, y: number, z: number): { x: number; y: number; z: number } => ({ x, y, z })
const fixture = (): Level => ({
  id: 'lv',
  config: { mode: { name: 'parkour' } },
  nodes: [
    { id: 'a', transform: { position: v3(0, 0, 0) }, components: [], children: [{ id: 'a1', transform: { position: v3(0, 0, 0) }, components: [] }] },
    { id: 'b', transform: { position: v3(1, 0, 0) }, components: [] },
  ],
})

const ADA = { name: 'Ada', email: 'ada@x' }
const BOB = { name: 'Bob', email: 'bob@x' }

interface Fake {
  client: LiveClient
  events: { event: string; data: unknown; id?: number }[]
}
const fake = (connId: string, user = ADA): Fake => {
  const events: Fake['events'] = []
  return { client: { connId, user, send: (event, data, id) => events.push(id === undefined ? { event, data } : { event, data, id }) }, events }
}

/** A world with a fake disk and fake timers the test advances by hand. */
const world = (extra: { idleMs?: number; maxMs?: number; staleMs?: number } = {}) => {
  const disk = new Map<string, unknown>([['lv', fixture()]])
  const writes: { name: string; level: Level }[] = []
  const changed: { users: string[]; path: string }[] = []
  const closed: string[][] = []
  const timers: { fn: () => void; at: number; live: boolean }[] = []
  let clock = 0
  const live = createLive({
    readLevel: (name) => disk.get(name) ?? null,
    writeLevel: (name, level) => writes.push({ name, level: structuredClone(level) }),
    changed: (users, path) => changed.push({ users: users.map((u) => u.name), path }),
    onDocClosed: (users) => closed.push(users.map((u) => u.name)),
    now: () => clock,
    schedule: (fn, ms) => {
      const t = { fn, at: clock + ms, live: true }
      timers.push(t)
      return () => {
        t.live = false
      }
    },
    ...extra,
  })
  const advance = (ms: number): void => {
    clock += ms
    for (const t of timers.filter((t) => t.live && t.at <= clock)) {
      t.live = false
      t.fn()
    }
  }
  return { live, disk, writes, changed, closed, advance }
}

const setName = (id: string, name: string): Op => ({ kind: 'setName', id, name })

describe('join and leave', () => {
  it('loads from disk once, greets with hello + snapshot, tells the others who is here', () => {
    const { live } = world()
    const a = fake('c1')
    live.join('lv', a.client)
    expect(a.events.map((e) => e.event)).toEqual(['hello', 'snapshot'])
    expect((a.events[1]!.data as { seq: number; peers: unknown[] }).seq).toBe(0)
    const b = fake('c2', BOB)
    live.join('lv', b.client)
    expect(a.events.at(-1)?.event).toBe('peers')
    expect(((b.events[1]!.data as { peers: { name: string }[] }).peers ?? []).map((p) => p.name)).toEqual(['Ada', 'Bob'])
  })

  it('refuses a level that is not there or does not load', () => {
    const { live, disk } = world()
    expect(() => live.join('nope', fake('c').client)).toThrow(LiveError)
    disk.set('bad', { nodes: 'x' })
    try {
      live.join('bad', fake('c').client)
      expect.unreachable()
    } catch (e) {
      expect((e as LiveError).status).toBe(400)
    }
  })

  it('the last leaver writes the file, closes the doc and hands over the contributors', () => {
    const { live, writes, closed, changed } = world()
    const a = fake('c1')
    live.join('lv', a.client)
    live.apply('lv', 'c1', ADA, { batchId: 'b1', ops: [setName('b', 'B')] })
    expect(writes).toHaveLength(0)
    live.leave('lv', 'c1')
    expect(writes).toHaveLength(1)
    expect(writes[0]!.level.nodes[1]!.name).toBe('B')
    expect(writes[0]!.level.id, 'the id follows the file name').toBe('lv')
    expect(changed).toEqual([{ users: ['Ada'], path: 'content/levels/lv.json' }])
    expect(closed).toEqual([['Ada']])
    expect(live.isOpen('lv')).toBe(false)
  })
})

describe('apply', () => {
  it('applies, numbers, and echoes to everyone including the sender', () => {
    const { live } = world()
    const a = fake('c1')
    const b = fake('c2', BOB)
    live.join('lv', a.client)
    live.join('lv', b.client)
    const r = live.apply('lv', 'c1', ADA, { batchId: 'b1', ops: [setName('b', 'B')] })
    expect(r).toEqual({ ok: true, seq: 1 })
    const echoA = a.events.at(-1)!
    const echoB = b.events.at(-1)!
    expect(echoA.event).toBe('ops')
    expect(echoA.id).toBe(1)
    expect((echoA.data as { from: string; batchId: string }).from).toBe('c1')
    expect(echoB.data).toEqual(echoA.data)
    expect(live.levelOf('lv')!.nodes[1]!.name).toBe('B')
  })

  it('refuses a bad batch whole (400) and an unknown or foreign connection', () => {
    const { live } = world()
    live.join('lv', fake('c1').client)
    try {
      live.apply('lv', 'c1', ADA, { batchId: 'b', ops: [setName('b', 'B'), { kind: 'removeNode', id: 'zzz' }] })
      expect.unreachable()
    } catch (e) {
      expect((e as LiveError).status).toBe(400)
    }
    expect(live.levelOf('lv')!.nodes[1]!.name).toBeUndefined()
    expect(() => live.apply('lv', 'c9', ADA, { batchId: 'b', ops: [] })).toThrow(/unknown connection/)
    expect(() => live.apply('lv', 'c1', BOB, { batchId: 'b', ops: [] })).toThrow(/not yours/)
  })

  it('a no-op batch is echoed but does not dirty the file', () => {
    const { live, writes, advance } = world()
    live.join('lv', fake('c1').client)
    live.apply('lv', 'c1', ADA, { batchId: 'b', ops: [{ kind: 'setTransform', id: 'b', transform: { position: v3(1, 0, 0) } }] })
    advance(10_000)
    expect(writes).toHaveLength(0)
  })
})

describe('flush', () => {
  it('writes after the idle time, at most maxMs after the first edit, then names every contributor once', () => {
    const { live, writes, changed, advance } = world({ idleMs: 500, maxMs: 5000 })
    live.join('lv', fake('c1').client)
    live.join('lv', fake('c2', BOB).client)
    live.apply('lv', 'c1', ADA, { batchId: '1', ops: [setName('b', 'B')] })
    advance(400)
    live.apply('lv', 'c2', BOB, { batchId: '2', ops: [setName('a', 'A')] })
    advance(400)
    expect(writes, 'still within idle').toHaveLength(0)
    advance(200)
    expect(writes).toHaveLength(1)
    expect(changed[0]!.users.sort()).toEqual(['Ada', 'Bob'])
    // Kept busy: the max timer writes anyway.
    for (let i = 0; i < 12; i++) {
      live.apply('lv', 'c1', ADA, { batchId: `k${i}`, ops: [setName('b', `B${i}`)] })
      advance(450)
    }
    expect(writes.length).toBeGreaterThanOrEqual(2)
    expect(changed.at(-1)!.users).toEqual(['Ada'])
  })

  it('flush and flushAll write what is unwritten and nothing when clean', () => {
    const { live, writes } = world()
    live.join('lv', fake('c1').client)
    live.flush('lv')
    expect(writes).toHaveLength(0)
    live.apply('lv', 'c1', ADA, { batchId: '1', ops: [setName('b', 'B')] })
    live.flushAll()
    expect(writes).toHaveLength(1)
    live.flush('lv')
    expect(writes).toHaveLength(1)
  })
})

describe('holds', () => {
  it('another connection cannot edit a held node or anything under it; the holder can; leaving releases', () => {
    const { live } = world()
    const a = fake('c1')
    const b = fake('c2', BOB)
    live.join('lv', a.client)
    live.join('lv', b.client)
    expect(live.hold('lv', 'c1', ADA, [{ id: 'a' }])).toEqual({ ok: true })
    expect(b.events.at(-1)?.event).toBe('holds')
    expect(live.hold('lv', 'c2', BOB, [{ id: 'a' }])).toEqual({ ok: false, holder: 'Ada', refused: [{ id: 'a' }] })
    expect(() => live.apply('lv', 'c2', BOB, { batchId: 'x', ops: [setName('a', 'X')] })).toThrow(/held by Ada/)
    expect(() => live.apply('lv', 'c2', BOB, { batchId: 'x', ops: [setName('a1', 'X')] }), 'the subtree too').toThrow(/held by Ada/)
    expect(() => live.apply('lv', 'c2', BOB, { batchId: 'x', ops: [{ kind: 'moveNode', id: 'b', parent: 'a', index: 0 }] }), 'moving into it too').toThrow(/held by Ada/)
    expect(live.apply('lv', 'c1', ADA, { batchId: 'y', ops: [setName('a', 'mine')] }).ok).toBe(true)
    expect(live.apply('lv', 'c2', BOB, { batchId: 'z', ops: [setName('b', 'free')] }).ok).toBe(true)
    live.leave('lv', 'c1')
    expect(live.apply('lv', 'c2', BOB, { batchId: 'w', ops: [setName('a', 'now mine')] }).ok).toBe(true)
  })

  it('a hold is the whole set: what is left out is released, what another has is refused and left out', () => {
    const { live } = world()
    const a = fake('c1')
    const b = fake('c2', BOB)
    live.join('lv', a.client)
    live.join('lv', b.client)
    expect(live.hold('lv', 'c1', ADA, [{ id: 'a' }, { id: 'b' }])).toEqual({ ok: true })
    expect(live.status()[0]!.holds).toBe(2)
    expect(live.hold('lv', 'c1', ADA, [{ id: 'b' }]), 'a released by omission').toEqual({ ok: true })
    expect(live.status()[0]!.holds).toBe(1)
    expect(live.hold('lv', 'c2', BOB, [{ id: 'a' }, { id: 'b' }])).toEqual({ ok: false, holder: 'Ada', refused: [{ id: 'b' }] })
    expect(live.status()[0]!.holds, 'Bob still got a').toBe(2)
    expect(live.hold('lv', 'c1', ADA, []), 'an empty set is a release').toEqual({ ok: true })
    expect(live.status()[0]!.holds).toBe(1)
    const before = b.events.length
    live.hold('lv', 'c2', BOB, [{ id: 'a' }])
    expect(b.events.length, 'nothing changed: nothing broadcast').toBe(before)
  })

  it('a connection silent past staleMs is swept out and its holds go with it; any message keeps it', () => {
    const { live, advance } = world({ staleMs: 1000 })
    const a = fake('c1')
    const b = fake('c2', BOB)
    live.join('lv', a.client)
    live.join('lv', b.client)
    live.hold('lv', 'c1', ADA, [{ id: 'a' }])
    advance(600)
    live.ping('lv', 'c2', BOB)
    advance(600)
    live.sweep()
    expect(live.status()[0]!.peers.map((p) => p.connId), 'c1 gone, c2 pinged').toEqual(['c2'])
    expect(live.status()[0]!.holds).toBe(0)
    expect(b.events.at(-1)?.event).toBe('peers')
  })

  it('removing a node drops the holds on it, and two tabs of one person are two holders', () => {
    const { live } = world()
    const tab1 = fake('t1')
    const tab2 = fake('t2')
    live.join('lv', tab1.client)
    live.join('lv', tab2.client)
    live.hold('lv', 't1', ADA, [{ id: 'a1' }])
    expect(live.hold('lv', 't2', ADA, [{ id: 'a1' }])).toEqual({ ok: false, holder: 'Ada', refused: [{ id: 'a1' }] })
    live.apply('lv', 't1', ADA, { batchId: 'r', ops: [{ kind: 'removeNode', id: 'a' }] })
    expect(live.status()[0]!.holds).toBe(0)
    expect(tab2.events.at(-1)?.event).toBe('holds')
  })
})

describe('presence', () => {
  it('relays to the others only, unnumbered', () => {
    const { live } = world()
    const a = fake('c1')
    const b = fake('c2', BOB)
    live.join('lv', a.client)
    live.join('lv', b.client)
    const before = a.events.length
    live.presence('lv', 'c1', ADA, { kind: 'select', refs: [{ id: 'a' }] })
    expect(a.events.length).toBe(before)
    expect(b.events.at(-1)).toEqual({ event: 'presence', data: { from: 'c1', name: 'Ada', data: { kind: 'select', refs: [{ id: 'a' }] } } })
  })
})

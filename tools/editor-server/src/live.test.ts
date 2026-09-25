import { describe, expect, it } from 'vitest'

import type { Level, Node, Op } from '../../../packages/content/src/index'
import { createLive, docKey, LiveError, type LiveClient, type LiveOptions } from './live'

/**
 * The document under test, named as everything names a level now: `<game>/<name>` (ADR 0108). The game is
 * the folder it lives in, so the document key carries it; the level's own `id` stays the bare `lv`, because
 * an `id` is a file name.
 */
const LV = 'parkour/lv'

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
const PAD = 'aaaaaaaaaaaaaaaa'
/** A prefab store over a map of files, as the server's is over the shared library (paths from content/, ADR 0161). */
const store = (files: Record<string, Node>): LiveOptions['prefabs'] => ({
  root: (id) => files[id],
  pathOf: (id) => (files[id] === undefined ? undefined : `assets/prefabs/${id}.prefab.json`),
  write: (id, root) => {
    if (files[id] === undefined) return null
    files[id] = root
    return `assets/prefabs/${id}.prefab.json`
  },
})
/** A prefab file, as the store would hand it over. */
const padFile = (): Node => ({ id: 'root', name: 'pad', transform: { position: v3(0, 0, 0) }, components: [], children: [{ id: 'p0', transform: { position: v3(0, 0, 0) }, components: [] }] })

const world = (extra: { idleMs?: number; maxMs?: number; staleMs?: number; prefabs?: LiveOptions['prefabs'] } = {}) => {
  const disk = new Map<string, unknown>([[LV, fixture()]])
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
    live.join(LV, a.client)
    expect(a.events.map((e) => e.event)).toEqual(['hello', 'snapshot'])
    expect((a.events[1]!.data as { seq: number; peers: unknown[] }).seq).toBe(0)
    const b = fake('c2', BOB)
    live.join(LV, b.client)
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
    live.join(LV, a.client)
    live.apply(LV, 'c1', ADA, { batchId: 'b1', ops: [setName('b', 'B')] })
    expect(writes).toHaveLength(0)
    live.leave(LV, 'c1')
    expect(writes).toHaveLength(1)
    expect(writes[0]!.level.nodes[1]!.name).toBe('B')
    expect(writes[0]!.level.id, 'the id is the bare file name, not the qualified one').toBe('lv')
    expect(changed).toEqual([{ users: ['Ada'], path: 'content/parkour/levels/lv.level.json' }])
    expect(closed).toEqual([['Ada']])
    expect(live.isOpen(LV)).toBe(false)
  })
})

describe('apply', () => {
  it('applies, numbers, and echoes to everyone including the sender', () => {
    const { live } = world()
    const a = fake('c1')
    const b = fake('c2', BOB)
    live.join(LV, a.client)
    live.join(LV, b.client)
    const r = live.apply(LV, 'c1', ADA, { batchId: 'b1', ops: [setName('b', 'B')] })
    expect(r).toEqual({ ok: true, seq: 1 })
    const echoA = a.events.at(-1)!
    const echoB = b.events.at(-1)!
    expect(echoA.event).toBe('ops')
    expect(echoA.id).toBe(1)
    expect((echoA.data as { from: string; batchId: string }).from).toBe('c1')
    expect(echoB.data).toEqual(echoA.data)
    expect(live.levelOf(LV)!.nodes[1]!.name).toBe('B')
  })

  it('refuses a bad batch whole (400) and an unknown or foreign connection', () => {
    const { live } = world()
    live.join(LV, fake('c1').client)
    try {
      live.apply(LV, 'c1', ADA, { batchId: 'b', ops: [setName('b', 'B'), { kind: 'removeNode', id: 'zzz' }] })
      expect.unreachable()
    } catch (e) {
      expect((e as LiveError).status).toBe(400)
    }
    expect(live.levelOf(LV)!.nodes[1]!.name).toBeUndefined()
    expect(() => live.apply(LV, 'c9', ADA, { batchId: 'b', ops: [] })).toThrow(/unknown connection/)
    expect(() => live.apply(LV, 'c1', BOB, { batchId: 'b', ops: [] })).toThrow(/not yours/)
  })

  it('a no-op batch is echoed but does not dirty the file', () => {
    const { live, writes, advance } = world()
    live.join(LV, fake('c1').client)
    live.apply(LV, 'c1', ADA, { batchId: 'b', ops: [{ kind: 'setTransform', id: 'b', transform: { position: v3(1, 0, 0) } }] })
    advance(10_000)
    expect(writes).toHaveLength(0)
  })
})

describe('flush', () => {
  it('writes after the idle time, at most maxMs after the first edit, then names every contributor once', () => {
    const { live, writes, changed, advance } = world({ idleMs: 500, maxMs: 5000 })
    live.join(LV, fake('c1').client)
    live.join(LV, fake('c2', BOB).client)
    live.apply(LV, 'c1', ADA, { batchId: '1', ops: [setName('b', 'B')] })
    advance(400)
    live.apply(LV, 'c2', BOB, { batchId: '2', ops: [setName('a', 'A')] })
    advance(400)
    expect(writes, 'still within idle').toHaveLength(0)
    advance(200)
    expect(writes).toHaveLength(1)
    expect(changed[0]!.users.sort()).toEqual(['Ada', 'Bob'])
    // Kept busy: the max timer writes anyway.
    for (let i = 0; i < 12; i++) {
      live.apply(LV, 'c1', ADA, { batchId: `k${i}`, ops: [setName('b', `B${i}`)] })
      advance(450)
    }
    expect(writes.length).toBeGreaterThanOrEqual(2)
    expect(changed.at(-1)!.users).toEqual(['Ada'])
  })

  it('flush and flushAll write what is unwritten and nothing when clean', () => {
    const { live, writes } = world()
    live.join(LV, fake('c1').client)
    live.flush(LV)
    expect(writes).toHaveLength(0)
    live.apply(LV, 'c1', ADA, { batchId: '1', ops: [setName('b', 'B')] })
    live.flushAll()
    expect(writes).toHaveLength(1)
    live.flush(LV)
    expect(writes).toHaveLength(1)
  })
})

describe('holds', () => {
  /** ADR 0158: holds are what people have selected, shown to the others and never refused. */
  it('several connections hold one node, and anyone edits it: the last batch to land is what stays', () => {
    const { live } = world()
    const a = fake('c1')
    const b = fake('c2', BOB)
    live.join(LV, a.client)
    live.join(LV, b.client)
    expect(live.hold(LV, 'c1', ADA, [{ id: 'a' }])).toEqual({ ok: true })
    expect(live.hold(LV, 'c2', BOB, [{ id: 'a' }])).toEqual({ ok: true })
    const holds = (b.events.at(-1)!.data as { holds: { connId: string; name: string }[] }).holds
    expect(holds.map((h) => h.name).sort(), 'both are shown').toEqual(['Ada', 'Bob'])
    expect(live.apply(LV, 'c2', BOB, { batchId: 'x', ops: [setName('a', 'Bob’s')] }).ok).toBe(true)
    expect(live.apply(LV, 'c2', BOB, { batchId: 'y', ops: [setName('a1', 'under it')] }).ok, 'its subtree too').toBe(true)
    expect(live.apply(LV, 'c1', ADA, { batchId: 'z', ops: [setName('a', 'Ada’s')] }).ok).toBe(true)
    expect(live.levelOf(LV)!.nodes[0]!.name).toBe('Ada’s')
  })

  it('a hold is the whole set: what is left out is released, whoever else holds the rest', () => {
    const { live } = world()
    const a = fake('c1')
    const b = fake('c2', BOB)
    live.join(LV, a.client)
    live.join(LV, b.client)
    expect(live.hold(LV, 'c1', ADA, [{ id: 'a' }, { id: 'b' }])).toEqual({ ok: true })
    expect(live.status()[0]!.holds).toBe(2)
    expect(live.hold(LV, 'c1', ADA, [{ id: 'b' }]), 'a released by omission').toEqual({ ok: true })
    expect(live.status()[0]!.holds).toBe(1)
    expect(live.hold(LV, 'c2', BOB, [{ id: 'a' }, { id: 'b' }])).toEqual({ ok: true })
    expect(live.status()[0]!.holds, 'Ada’s b, and Bob’s a and b').toBe(3)
    expect(live.hold(LV, 'c1', ADA, []), 'an empty set is a release').toEqual({ ok: true })
    expect(live.status()[0]!.holds).toBe(2)
    const before = b.events.length
    live.hold(LV, 'c2', BOB, [{ id: 'a' }, { id: 'b' }])
    expect(b.events.length, 'nothing changed: nothing broadcast').toBe(before)
  })

  it('a connection silent past staleMs is swept out and its holds go with it; any message keeps it', () => {
    const { live, advance } = world({ staleMs: 1000 })
    const a = fake('c1')
    const b = fake('c2', BOB)
    live.join(LV, a.client)
    live.join(LV, b.client)
    live.hold(LV, 'c1', ADA, [{ id: 'a' }])
    advance(600)
    live.ping(LV, 'c2', BOB)
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
    live.join(LV, tab1.client)
    live.join(LV, tab2.client)
    live.hold(LV, 't1', ADA, [{ id: 'a1' }])
    expect(live.hold(LV, 't2', ADA, [{ id: 'a1' }])).toEqual({ ok: true })
    expect(live.status()[0]!.holds, 'one each').toBe(2)
    live.apply(LV, 't1', ADA, { batchId: 'r', ops: [{ kind: 'removeNode', id: 'a' }] })
    expect(live.status()[0]!.holds).toBe(0)
    expect(tab2.events.at(-1)?.event).toBe('holds')
  })
})

describe('presence', () => {
  it('relays to the others only, unnumbered', () => {
    const { live } = world()
    const a = fake('c1')
    const b = fake('c2', BOB)
    live.join(LV, a.client)
    live.join(LV, b.client)
    const before = a.events.length
    live.presence(LV, 'c1', ADA, { kind: 'select', refs: [{ id: 'a' }] })
    expect(a.events.length).toBe(before)
    expect(b.events.at(-1)).toEqual({ event: 'presence', data: { from: 'c1', name: 'Ada', data: { kind: 'select', refs: [{ id: 'a' }] } } })
  })
})

describe('open assets (ADR 0159)', () => {
  const M = 'mmmmmmmmmmmmmmmm'
  const openEvents = (f: Fake): unknown[] => f.events.filter((e) => e.event === 'open-assets').map((e) => e.data)

  it('tells everyone, in every level, the whole set; a joiner after its snapshot; and drops it on leaving', () => {
    const { live, disk } = world()
    disk.set('parkour/lv2', fixture())
    const a = fake('c1')
    const b = fake('c2', BOB)
    live.join(LV, a.client)
    live.join('parkour/lv2', b.client)
    live.setOpenAssets(LV, 'c1', ADA, [M])
    expect(openEvents(b), 'a material is drawn in every level').toEqual([{ open: [{ assetId: M, connId: 'c1', name: 'Ada' }] }])
    expect(openEvents(a), 'the sender too: the echo is the ack').toHaveLength(1)
    live.setOpenAssets(LV, 'c1', ADA, [M])
    expect(openEvents(b), 'nothing changed, nothing sent').toHaveLength(1)

    const c = fake('c3', BOB)
    live.join(LV, c.client)
    expect(c.events.map((e) => e.event).slice(0, 3)).toEqual(['hello', 'snapshot', 'open-assets'])

    live.leave(LV, 'c1')
    expect(openEvents(b).at(-1)).toEqual({ open: [] })
  })

  it('refuses a connection that is not in the document, or not yours', () => {
    const { live } = world()
    live.join(LV, fake('c1').client)
    expect(() => live.setOpenAssets(LV, 'nope', ADA, [M])).toThrow(LiveError)
    expect(() => live.setOpenAssets(LV, 'c1', BOB, [M])).toThrow(LiveError)
  })
})


describe('prefab references (ADR 0091)', () => {
  /** A level naming a prefab it does not carry: the definition comes from the store, and the file keeps neither twice. */
  const withPlacement = (): Level => ({
    id: 'lv',
    config: {},
    nodes: [{ id: 'n0', transform: { position: v3(5, 0, 0) }, components: [], prefab: PAD }],
  })

  it('resolves a reference on open, so the inherited nodes are here, and writes the reference alone', () => {
    const file = padFile()
    const w = world({ prefabs: store({ [PAD]: file }) })
    w.disk.set(LV, withPlacement())
    const a = fake('c1')
    w.live.join(LV, a.client)

    const snapshot = a.events.find((e) => e.event === 'snapshot')!.data as { level: Level }
    expect(snapshot.level.prefabs![PAD], 'the definition itself, not a copy').toBe(file)

    // An op on an inherited node needs the definition present to be checked at all.
    expect(w.live.apply(LV, 'c1', ADA, { batchId: 'b', ops: [{ kind: 'setOverrideTransform', owner: 'n0', node: 'p0', transform: { position: v3(0, 2, 0) } }] }).ok).toBe(true)

    w.live.flush(LV)
    const written = w.writes.at(-1)!.level
    expect(written.prefabs, 'the definition is not written into the level').toBeUndefined()
    expect(written.nodes[0]!.prefab, 'the reference is').toBe(PAD)
    expect(written.nodes[0]!.overrides!['p0']!.transform!.position).toEqual(v3(0, 2, 0))
  })

  it('keeps a table the level carries itself, and strips only what it resolved', () => {
    const w = world({ prefabs: store({ [PAD]: padFile(), Trampoline: padFile() }) })
    const own = padFile()
    own.name = 'mine'
    w.disk.set(LV, { id: 'lv', config: {}, prefabs: { Trampoline: own }, nodes: [{ id: 'n0', transform: { position: v3(0, 0, 0) }, components: [], prefab: 'Trampoline' }, { id: 'n1', transform: { position: v3(1, 0, 0) }, components: [], prefab: PAD }] })
    const a = fake('c1')
    w.live.join(LV, a.client)
    w.live.apply(LV, 'c1', ADA, { batchId: 'b', ops: [{ kind: 'setName', id: 'n0', name: 'x' }] })
    w.live.flush(LV)
    const written = w.writes.at(-1)!.level
    expect(Object.keys(written.prefabs ?? {}), "the level's own table survives").toEqual(['Trampoline'])
    expect(written.prefabs!['Trampoline']!.name).toBe('mine')
  })

  /**
   * Apply to prefab from a level whose table is **inline** (ADR 0123).
   *
   * `hydratePrefabs` skips an id the level already carries, so nothing asked for that prefab's document and
   * it stayed shut — and `apply` on a prefab needs an open one. The gesture answered 404 "is not open" while
   * the placement itself worked perfectly, because the inline copy resolved it.
   */
  it('takes an apply for a prefab whose definition the level carried inline', () => {
    const w = world({ prefabs: store({ [PAD]: padFile() }) })
    const own = padFile()
    own.name = 'mine'
    w.disk.set(LV, { id: 'lv', config: {}, prefabs: { [PAD]: own }, nodes: [{ id: 'n0', transform: { position: v3(0, 0, 0) }, components: [], prefab: PAD }] })
    const a = fake('c1')
    w.live.join(LV, a.client)

    // The level resolved from its own table, so nothing was filled — and the document must still be open.
    expect(w.live.status().map((d) => d.name)).toContain(PAD)
    const r = w.live.apply(docKey('prefab', PAD), 'c1', ADA, { batchId: 'b', ops: [{ kind: 'setName', id: 'p0', name: 'applied' }] })
    expect(r.ok, 'the connection comes from a level that depends on it').toBe(true)
  })

  it('keeps the inline definition the level carried, even though the document is now open', () => {
    const w = world({ prefabs: store({ [PAD]: padFile() }) })
    const own = padFile()
    own.name = 'mine'
    w.disk.set(LV, { id: 'lv', config: {}, prefabs: { [PAD]: own }, nodes: [{ id: 'n0', transform: { position: v3(0, 0, 0) }, components: [], prefab: PAD }] })
    const a = fake('c1')
    w.live.join(LV, a.client)
    w.live.apply(LV, 'c1', ADA, { batchId: 'b', ops: [{ kind: 'setName', id: 'n0', name: 'x' }] })
    w.live.flush(LV)
    const written = w.writes.at(-1)!.level
    expect(Object.keys(written.prefabs ?? {}), 'opening the document does not adopt or strip it').toEqual([PAD])
    expect(written.prefabs![PAD]!.name).toBe('mine')
  })

  it('a reference with no file leaves the placement with nothing inherited, and the level still opens', () => {
    const w = world({ prefabs: store({}) })
    w.disk.set(LV, withPlacement())
    const a = fake('c1')
    expect(() => w.live.join(LV, a.client)).not.toThrow()
    const snapshot = a.events.find((e) => e.event === 'snapshot')!.data as { level: Level }
    expect(snapshot.level.prefabs).toBeUndefined()
    expect(w.live.apply(LV, 'c1', ADA, { batchId: 'b', ops: [{ kind: 'setName', id: 'n0', name: 'still editable' }] }).ok).toBe(true)
  })

  it('resolves a prefab placed during the session, without reopening the document', () => {
    const w = world({ prefabs: store({ [PAD]: padFile() }) })
    const a = fake('c1')
    w.live.join(LV, a.client)
    w.live.apply(LV, 'c1', ADA, { batchId: 'b', ops: [{ kind: 'insertNode', parent: null, index: 2, node: { id: 'fresh', transform: { position: v3(0, 0, 0) }, components: [], prefab: PAD } }] })
    // The proof: an override op on an inherited node only validates when the definition resolved.
    expect(w.live.apply(LV, 'c1', ADA, { batchId: 'c', ops: [{ kind: 'setOverrideName', owner: 'fresh', node: 'p0', name: 'mine' }] }).ok).toBe(true)
    w.live.flush(LV)
    expect(w.writes.at(-1)!.level.prefabs, 'still not written into the level').toBeUndefined()
  })
})

describe('a prefab is a live document (ADR 0091)', () => {
  const prefabKey = docKey('prefab', PAD)
  /** A level referencing the prefab, so the two documents are related the way real content is. */
  const referencing = (): Level => ({ id: 'lv', config: {}, nodes: [{ id: 'n0', transform: { position: v3(5, 0, 0) }, components: [], prefab: PAD }] })

  it('opens from the store, is edited by ops and writes back to its own file', () => {
    const files = { [PAD]: padFile() }
    const w = world({ prefabs: store(files) })
    const a = fake('c1')
    w.live.join(prefabKey, a.client)
    const snapshot = a.events.find((e) => e.event === 'snapshot')!.data as { level: Level }
    expect(snapshot.level.nodes.map((n) => n.id), 'a one-root wrapper').toEqual(['root'])

    expect(w.live.apply(prefabKey, 'c1', ADA, { batchId: 'b', ops: [setName('p0', 'renamed')] }).ok).toBe(true)
    w.live.flush(prefabKey)
    expect(files[PAD]!.children![0]!.name, 'written to the prefab file').toBe('renamed')
    expect(w.changed.at(-1)).toEqual({ users: ['Ada'], path: `content/assets/prefabs/${PAD}.prefab.json` })
    expect(w.writes, 'no level was written').toEqual([])
  })

  /** The whole point: one object, so a prefab edit is in every open level's resolution at once. */
  it('shares its root with every level that references it', () => {
    const w = world({ prefabs: store({ [PAD]: padFile() }) })
    w.disk.set(LV, referencing())
    const level = fake('c1')
    w.live.join(LV, level.client)
    const prefab = fake('c2', BOB)
    w.live.join(prefabKey, prefab.client)

    w.live.apply(prefabKey, 'c2', BOB, { batchId: 'b', ops: [setName('p0', 'moved')] })
    const open = w.live.levelOf(LV)!
    expect(open.prefabs![PAD]!.children![0]!.name, "the level's resolution followed with no level op").toBe('moved')
    expect(w.live.status().find((s) => s.name === LV)!.seq, 'and the level took no op of its own').toBe(0)
  })

  it('a level opens the prefab documents it references, and keeps them open', () => {
    const w = world({ prefabs: store({ [PAD]: padFile() }) })
    w.disk.set(LV, referencing())
    const level = fake('c1')
    w.live.join(LV, level.client)
    expect(w.live.isOpen(prefabKey), 'opened to resolve the reference').toBe(true)

    // Nobody is *in* the prefab document, but the level reads from it, so it must not close.
    w.live.leave(prefabKey, 'nobody')
    expect(w.live.isOpen(prefabKey)).toBe(true)

    w.live.leave(LV, 'c1')
    expect(w.live.isOpen(LV)).toBe(false)
    expect(w.live.isOpen(prefabKey), 'nothing depends on it now').toBe(false)
  })

  it('refuses a prefab that would contain a placement, and one that is not there', () => {
    const w = world({ prefabs: store({ [PAD]: padFile() }) })
    const a = fake('c1')
    w.live.join(prefabKey, a.client)
    expect(() => w.live.apply(prefabKey, 'c1', ADA, { batchId: 'b', ops: [{ kind: 'insertNode', parent: 'root', index: 1, node: { id: 'nested', transform: { position: v3(0, 0, 0) }, components: [], prefab: 'other' } }] })).toThrow()
    expect(() => w.live.join(docKey('prefab', 'nope'), fake('c9').client)).toThrow(/no prefab asset/)
  })

  it('holds inside a prefab document work like any other', () => {
    const w = world({ prefabs: store({ [PAD]: padFile() }) })
    const a = fake('c1')
    const b = fake('c2', BOB)
    w.live.join(prefabKey, a.client)
    w.live.join(prefabKey, b.client)
    expect(w.live.hold(prefabKey, 'c1', ADA, [{ id: 'p0' }])).toEqual({ ok: true })
    expect(w.live.hold(prefabKey, 'c2', BOB, [{ id: 'p0' }])).toEqual({ ok: true })
    expect(w.live.apply(prefabKey, 'c2', BOB, { batchId: 'x', ops: [setName('p0', 'mine')] }).ok).toBe(true)
  })
})

describe('a refused prefab batch', () => {
  it('rolls back through the object every level holds, not into a copy of it', () => {
    const files = { [PAD]: padFile() }
    const w = world({ prefabs: store(files) })
    w.disk.set(LV, { id: 'lv', config: {}, nodes: [{ id: 'n0', transform: { position: v3(0, 0, 0) }, components: [], prefab: PAD }] })
    const level = fake('c1')
    w.live.join(LV, level.client)
    const key = docKey('prefab', PAD)
    const editor = fake('c2', BOB)
    w.live.join(key, editor.client)

    const shared = w.live.levelOf(LV)!.prefabs![PAD]!
    expect(() => w.live.apply(key, 'c2', BOB, { batchId: 'b', ops: [{ kind: 'insertNode', parent: 'root', index: 1, node: { id: 'nested', transform: { position: v3(0, 0, 0) }, components: [], prefab: 'other' } }] })).toThrow()

    expect(w.live.levelOf(LV)!.prefabs![PAD], 'the level still holds the live object').toBe(shared)
    expect(shared.children!.map((c) => c.id), 'and it is back as it was').toEqual(['p0'])

    // Still editable afterwards, and the level sees it.
    expect(w.live.apply(key, 'c2', BOB, { batchId: 'c', ops: [setName('p0', 'fine')] }).ok).toBe(true)
    expect(shared.children![0]!.name).toBe('fine')
  })
})

describe('which field each connection is in (ADR 0160)', () => {
  const spot = { targets: ['level:parkour/lv|a'], card: 'transform', field: 'position' }
  const fieldEvents = (f: Fake): unknown[] => f.events.filter((e) => e.event === 'fields').map((e) => e.data)

  it('tells everyone, a joiner after its snapshot, and nobody once it leaves the field or the document', () => {
    const { live, disk } = world()
    disk.set('parkour/lv2', fixture())
    const a = fake('c1')
    const b = fake('c2', BOB)
    live.join(LV, a.client)
    live.join('parkour/lv2', b.client)
    live.setField(LV, 'c1', ADA, spot)
    expect(fieldEvents(b)).toEqual([{ fields: [{ connId: 'c1', name: 'Ada', ...spot }] }])
    live.setField(LV, 'c1', ADA, spot)
    expect(fieldEvents(b), 'nothing changed, nothing sent').toHaveLength(1)

    const c = fake('c3', BOB)
    live.join(LV, c.client)
    expect(c.events.map((e) => e.event).slice(0, 3)).toEqual(['hello', 'snapshot', 'fields'])

    live.setField(LV, 'c1', ADA, null)
    expect(fieldEvents(b).at(-1)).toEqual({ fields: [] })
    live.setField(LV, 'c1', ADA, spot)
    live.leave(LV, 'c1')
    expect(fieldEvents(b).at(-1), 'gone with the connection').toEqual({ fields: [] })
  })
})

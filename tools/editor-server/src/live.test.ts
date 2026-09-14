import { describe, expect, it } from 'vitest'

import type { Level, Node, Op } from '../../../packages/content/src/index'
import { createLive, docKey, LiveError, type LiveClient, type LiveOptions } from './live'

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
/** A prefab store over a map of files, as the server's is over the assets folder. */
const store = (files: Record<string, Node>): LiveOptions['prefabs'] => ({
  root: (id) => files[id],
  pathOf: (id) => (files[id] === undefined ? undefined : `prefabs/${id}.prefab.json`),
  write: (id, root) => {
    if (files[id] === undefined) return null
    files[id] = root
    return `prefabs/${id}.prefab.json`
  },
})
/** A prefab file, as the store would hand it over. */
const padFile = (): Node => ({ id: 'root', name: 'pad', transform: { position: v3(0, 0, 0) }, components: [], children: [{ id: 'p0', transform: { position: v3(0, 0, 0) }, components: [] }] })

const world = (extra: { idleMs?: number; maxMs?: number; staleMs?: number; prefabs?: LiveOptions['prefabs'] } = {}) => {
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
    w.disk.set('lv', withPlacement())
    const a = fake('c1')
    w.live.join('lv', a.client)

    const snapshot = a.events.find((e) => e.event === 'snapshot')!.data as { level: Level }
    expect(snapshot.level.prefabs![PAD], 'the definition itself, not a copy').toBe(file)

    // An op on an inherited node needs the definition present to be checked at all.
    expect(w.live.apply('lv', 'c1', ADA, { batchId: 'b', ops: [{ kind: 'setOverrideTransform', owner: 'n0', node: 'p0', transform: { position: v3(0, 2, 0) } }] }).ok).toBe(true)

    w.live.flush('lv')
    const written = w.writes.at(-1)!.level
    expect(written.prefabs, 'the definition is not written into the level').toBeUndefined()
    expect(written.nodes[0]!.prefab, 'the reference is').toBe(PAD)
    expect(written.nodes[0]!.overrides!['p0']!.transform!.position).toEqual(v3(0, 2, 0))
  })

  it('keeps a table the level carries itself, and strips only what it resolved', () => {
    const w = world({ prefabs: store({ [PAD]: padFile(), Trampoline: padFile() }) })
    const own = padFile()
    own.name = 'mine'
    w.disk.set('lv', { id: 'lv', config: {}, prefabs: { Trampoline: own }, nodes: [{ id: 'n0', transform: { position: v3(0, 0, 0) }, components: [], prefab: 'Trampoline' }, { id: 'n1', transform: { position: v3(1, 0, 0) }, components: [], prefab: PAD }] })
    const a = fake('c1')
    w.live.join('lv', a.client)
    w.live.apply('lv', 'c1', ADA, { batchId: 'b', ops: [{ kind: 'setName', id: 'n0', name: 'x' }] })
    w.live.flush('lv')
    const written = w.writes.at(-1)!.level
    expect(Object.keys(written.prefabs ?? {}), "the level's own table survives").toEqual(['Trampoline'])
    expect(written.prefabs!['Trampoline']!.name).toBe('mine')
  })

  it('a reference with no file leaves the placement with nothing inherited, and the level still opens', () => {
    const w = world({ prefabs: store({}) })
    w.disk.set('lv', withPlacement())
    const a = fake('c1')
    expect(() => w.live.join('lv', a.client)).not.toThrow()
    const snapshot = a.events.find((e) => e.event === 'snapshot')!.data as { level: Level }
    expect(snapshot.level.prefabs).toBeUndefined()
    expect(w.live.apply('lv', 'c1', ADA, { batchId: 'b', ops: [{ kind: 'setName', id: 'n0', name: 'still editable' }] }).ok).toBe(true)
  })

  it('resolves a prefab placed during the session, without reopening the document', () => {
    const w = world({ prefabs: store({ [PAD]: padFile() }) })
    const a = fake('c1')
    w.live.join('lv', a.client)
    w.live.apply('lv', 'c1', ADA, { batchId: 'b', ops: [{ kind: 'insertNode', parent: null, index: 2, node: { id: 'fresh', transform: { position: v3(0, 0, 0) }, components: [], prefab: PAD } }] })
    // The proof: an override op on an inherited node only validates when the definition resolved.
    expect(w.live.apply('lv', 'c1', ADA, { batchId: 'c', ops: [{ kind: 'setOverrideName', owner: 'fresh', node: 'p0', name: 'mine' }] }).ok).toBe(true)
    w.live.flush('lv')
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
    w.disk.set('lv', referencing())
    const level = fake('c1')
    w.live.join('lv', level.client)
    const prefab = fake('c2', BOB)
    w.live.join(prefabKey, prefab.client)

    w.live.apply(prefabKey, 'c2', BOB, { batchId: 'b', ops: [setName('p0', 'moved')] })
    const open = w.live.levelOf('lv')!
    expect(open.prefabs![PAD]!.children![0]!.name, "the level's resolution followed with no level op").toBe('moved')
    expect(w.live.status().find((s) => s.name === 'lv')!.seq, 'and the level took no op of its own').toBe(0)
  })

  it('a level opens the prefab documents it references, and keeps them open', () => {
    const w = world({ prefabs: store({ [PAD]: padFile() }) })
    w.disk.set('lv', referencing())
    const level = fake('c1')
    w.live.join('lv', level.client)
    expect(w.live.isOpen(prefabKey), 'opened to resolve the reference').toBe(true)

    // Nobody is *in* the prefab document, but the level reads from it, so it must not close.
    w.live.leave(prefabKey, 'nobody')
    expect(w.live.isOpen(prefabKey)).toBe(true)

    w.live.leave('lv', 'c1')
    expect(w.live.isOpen('lv')).toBe(false)
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
    expect(w.live.hold(prefabKey, 'c2', BOB, [{ id: 'p0' }])).toEqual({ ok: false, holder: 'Ada', refused: [{ id: 'p0' }] })
    expect(() => w.live.apply(prefabKey, 'c2', BOB, { batchId: 'x', ops: [setName('p0', 'mine')] })).toThrow(/held by Ada/)
  })
})

describe('a refused prefab batch', () => {
  it('rolls back through the object every level holds, not into a copy of it', () => {
    const files = { [PAD]: padFile() }
    const w = world({ prefabs: store(files) })
    w.disk.set('lv', { id: 'lv', config: {}, nodes: [{ id: 'n0', transform: { position: v3(0, 0, 0) }, components: [], prefab: PAD }] })
    const level = fake('c1')
    w.live.join('lv', level.client)
    const key = docKey('prefab', PAD)
    const editor = fake('c2', BOB)
    w.live.join(key, editor.client)

    const shared = w.live.levelOf('lv')!.prefabs![PAD]!
    expect(() => w.live.apply(key, 'c2', BOB, { batchId: 'b', ops: [{ kind: 'insertNode', parent: 'root', index: 1, node: { id: 'nested', transform: { position: v3(0, 0, 0) }, components: [], prefab: 'other' } }] })).toThrow()

    expect(w.live.levelOf('lv')!.prefabs![PAD], 'the level still holds the live object').toBe(shared)
    expect(shared.children!.map((c) => c.id), 'and it is back as it was').toEqual(['p0'])

    // Still editable afterwards, and the level sees it.
    expect(w.live.apply(key, 'c2', BOB, { batchId: 'c', ops: [setName('p0', 'fine')] }).ok).toBe(true)
    expect(shared.children![0]!.name).toBe('fine')
  })
})

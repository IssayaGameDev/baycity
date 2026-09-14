import { describe, expect, it } from 'vitest'

import type { Level, Op } from '@mp/content'

import { createCollab, parsePresence, type Hold, type LiveTransport, type LocalBatch, type Peer, type ServerEvent } from './collab'

/**
 * The collaboration core against a fake server: a hand-driven event stream and a POST log. The level lives
 * in the test, as it lives in the editor's root document; the hooks record what the host would repaint.
 */
const v3 = (x: number, y: number, z: number): { x: number; y: number; z: number } => ({ x, y, z })
const fixture = (): Level => ({
  id: 'lv',
  config: { mode: { name: 'parkour' } },
  prefabs: {},
  nodes: [
    { id: 'a', transform: { position: v3(0, 0, 0) }, components: [] },
    { id: 'b', transform: { position: v3(1, 0, 0) }, components: [] },
  ],
})
const move = (id: string, x: number): Op => ({ kind: 'setTransform', id, transform: { position: v3(x, 0, 0) } })
const posOf = (level: Level, id: string): number => level.nodes.find((n) => n.id === id)!.transform.position.x

interface Posted {
  action: string
  body: Record<string, unknown>
  answer: (ok: boolean, status?: number, body?: unknown) => void
}

const harness = (): {
  transport: LiveTransport
  emit: (e: ServerEvent) => void
  posts: Posted[]
  beacons: string[]
  connections: number
  closed: number
  drop: (why: string) => void
} => {
  const h = {
    posts: [] as Posted[],
    beacons: [] as string[],
    connections: 0,
    closed: 0,
    emit: (_e: ServerEvent): void => undefined,
    drop: (_why: string): void => undefined,
    transport: undefined as unknown as LiveTransport,
  }
  h.transport = {
    connect: (_name, onEvent, onDrop) => {
      h.connections++
      h.emit = onEvent
      h.drop = onDrop
      return {
        close: () => {
          h.closed++
        },
      }
    },
    post: (_name, action, body) =>
      new Promise((resolve) => {
        h.posts.push({ action, body: body as Record<string, unknown>, answer: (ok, status = ok ? 200 : 400, b = ok ? { ok: true } : { error: 'refused' }) => resolve({ ok, status, body: b }) })
      }),
    beacon: (_name, action) => {
      h.beacons.push(action)
    },
  }
  return h
}

const setUp = async (): Promise<{
  h: ReturnType<typeof harness>
  collab: ReturnType<typeof createCollab>
  level: () => Level
  applied: Op[][]
  rejected: { batch: LocalBatch; reason: string }[]
  peers: Peer[][]
  holds: Hold[][]
  errors: string[]
  snapshots: () => number
}> => {
  const h = harness()
  let level: Level | null = null
  const out = { applied: [] as Op[][], rejected: [] as { batch: LocalBatch; reason: string }[], peers: [] as Peer[][], holds: [] as Hold[][], errors: [] as string[], snapshots: 0 }
  const collab = createCollab(h.transport, {
    level: () => level,
    onSnapshot: (l) => {
      level = l
      out.snapshots++
    },
    onApplied: (ops) => out.applied.push(ops),
    onRejected: (batch, reason) => out.rejected.push({ batch, reason }),
    onPeers: (p) => out.peers.push(p),
    onHolds: (x) => out.holds.push(x),
    onPresence: () => undefined,
    onError: (m) => out.errors.push(m),
  })
  const joined = collab.join('lv')
  h.emit({ event: 'hello', data: { connId: 'me', name: 'Ada' } })
  h.emit({ event: 'snapshot', data: { level: fixture(), seq: 3, holds: [], peers: [{ connId: 'me', name: 'Ada' }, { connId: 'other', name: 'Bob' }] } })
  await joined
  return { h, collab, level: () => level!, ...out, snapshots: () => out.snapshots }
}

/** Let queued promise callbacks (a POST's answer) run. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('collab', () => {
  it('joins on the first snapshot and knows itself and the room', async () => {
    const s = await setUp()
    expect(s.snapshots()).toBe(1)
    expect(s.collab.connId()).toBe('me')
    expect(s.collab.name()).toBe('lv')
    expect(s.collab.peers().map((p) => p.name)).toEqual(['Ada', 'Bob'])
    expect(s.h.connections).toBe(1)
  })

  it('a refused stream rejects the join', async () => {
    const h = harness()
    const collab = createCollab(h.transport, { level: () => null, onSnapshot: () => undefined, onApplied: () => undefined, onRejected: () => undefined, onPeers: () => undefined, onHolds: () => undefined, onPresence: () => undefined, onError: () => undefined })
    const joined = collab.join('nope')
    h.drop('not there')
    await expect(joined).rejects.toThrow('not there')
  })

  it('a local batch is posted and acked by its echo; nothing is re-applied', async () => {
    const s = await setUp()
    const level = s.level()
    level.nodes[0]!.transform.position.x = 5 // the document already applied it
    s.collab.submit({ ops: [move('a', 5)], inverses: [move('a', 0)] })
    expect(s.collab.pending()).toBe(1)
    const post = s.h.posts[0]!
    expect(post.action).toBe('ops')
    expect(post.body.connId).toBe('me')
    post.answer(true)
    s.h.emit({ event: 'ops', data: { seq: 4, from: 'me', batchId: post.body.batchId as string, ops: [move('a', 5)] } })
    expect(s.collab.pending()).toBe(0)
    expect(s.applied).toEqual([])
    expect(posOf(level, 'a')).toBe(5)
  })

  it('a remote batch lands under unacked local edits: rollback, apply, re-apply, one repaint', async () => {
    const s = await setUp()
    const level = s.level()
    level.nodes[0]!.transform.position.x = 5
    s.collab.submit({ ops: [move('a', 5)], inverses: [move('a', 0)] })
    s.h.emit({ event: 'ops', data: { seq: 4, from: 'other', batchId: 'x', ops: [move('b', 7)] } })
    expect(posOf(level, 'a'), 'mine is still on').toBe(5)
    expect(posOf(level, 'b'), 'theirs is in').toBe(7)
    expect(s.applied).toHaveLength(1)
    expect(s.applied[0]!.map((o) => (o as { id: string }).id)).toEqual(['b', 'a'])
    expect(s.collab.pending()).toBe(1)
  })

  it('a rejected batch is rolled back and reported; later local edits stay', async () => {
    const s = await setUp()
    const level = s.level()
    level.nodes[0]!.transform.position.x = 5
    s.collab.submit({ ops: [move('a', 5)], inverses: [move('a', 0)] })
    level.nodes[1]!.transform.position.x = 9
    s.collab.submit({ ops: [move('b', 9)], inverses: [move('b', 1)] })
    s.h.posts[0]!.answer(false, 423, { error: 'held by Bob' })
    await tick()
    expect(posOf(level, 'a'), 'the refused move is gone').toBe(0)
    expect(posOf(level, 'b'), 'the later one stays').toBe(9)
    expect(s.rejected.map((r) => r.reason)).toEqual(['held by Bob'])
    expect(s.collab.pending()).toBe(1)
    expect(s.applied).toHaveLength(1)
  })

  it('a gap in the sequence reopens the stream for a fresh snapshot, and unacked edits ride on it', async () => {
    const s = await setUp()
    const level = s.level()
    level.nodes[0]!.transform.position.x = 5
    s.collab.submit({ ops: [move('a', 5)], inverses: [move('a', 0)] })
    s.h.emit({ event: 'ops', data: { seq: 9, from: 'other', batchId: 'x', ops: [move('b', 7)] } })
    expect(s.h.connections).toBe(2)
    expect(s.h.closed).toBe(1)
    s.h.emit({ event: 'hello', data: { connId: 'me2', name: 'Ada' } })
    s.h.emit({ event: 'snapshot', data: { level: fixture(), seq: 9, holds: [], peers: [] } })
    expect(s.snapshots()).toBe(2)
    expect(posOf(s.level(), 'a'), 'my unacked edit is back on the new copy').toBe(5)
    expect(s.h.posts.filter((p) => p.action === 'ops')).toHaveLength(2)
    expect(s.h.posts[1]!.body.connId).toBe('me2')
  })

  it('leave closes the stream and tells the server; pagehide uses a beacon', async () => {
    const s = await setUp()
    s.collab.beaconLeave()
    expect(s.h.beacons).toEqual(['leave'])
    s.collab.leave()
    expect(s.h.closed).toBe(1)
    expect(s.h.posts.map((p) => p.action)).toEqual(['leave'])
    expect(s.collab.name()).toBeNull()
    s.collab.submit({ ops: [move('a', 5)], inverses: [move('a', 0)] })
    expect(s.h.posts, 'nothing is sent once left').toHaveLength(1)
  })

  it('holds answer with the holder when refused', async () => {
    const s = await setUp()
    const p = s.collab.hold([{ id: 'a' }])
    s.h.posts[0]!.answer(false, 423, { ok: false, holder: 'Bob' })
    expect(await p).toEqual({ ok: false, holder: 'Bob' })
    const q = s.collab.hold([{ id: 'b' }])
    s.h.posts[1]!.answer(true, 200, { ok: true })
    expect(await q).toEqual({ ok: true })
  })
})

describe('parsePresence', () => {
  const pose = { ref: { id: 'a' }, position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
  it('accepts a pose stream and keeps only the fields it knows', () => {
    expect(parsePresence({ kind: 'pose', poses: [pose], junk: 1 })).toEqual({ kind: 'pose', poses: [pose] })
    expect(parsePresence({ kind: 'pose', poses: [], end: true })).toEqual({ kind: 'pose', poses: [], end: true })
    expect(parsePresence({ kind: 'pose', poses: [{ ...pose, ref: { owner: 'p1', node: 'top' } }] })!.poses[0]!.ref).toEqual({ owner: 'p1', node: 'top' })
  })
  it('refuses anything else', () => {
    expect(parsePresence(null)).toBeNull()
    expect(parsePresence({ kind: 'select', refs: [] })).toBeNull()
    expect(parsePresence({ kind: 'pose', poses: [{ ...pose, position: { x: 'no' } }] })).toBeNull()
    expect(parsePresence({ kind: 'pose', poses: [{ ...pose, ref: { nope: 1 } }] })).toBeNull()
  })
})

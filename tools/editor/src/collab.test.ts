import { describe, expect, it } from 'vitest'

import type { Level, Op } from '@mp/content'

import {
  createCollab,
  parseCameraPresence,
  parseFollowPresence,
  parsePresence,
  peerChanges,
  type Connection,
  type Hold,
  type LiveTransport,
  type LocalBatch,
  type Peer,
  type ServerEvent,
} from './collab'

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
  retry: () => void
} => {
  const h = {
    posts: [] as Posted[],
    beacons: [] as string[],
    connections: 0,
    closed: 0,
    emit: (_e: ServerEvent): void => undefined,
    drop: (_why: string): void => undefined,
    retry: (): void => undefined,
    transport: undefined as unknown as LiveTransport,
  }
  h.transport = {
    connect: (_kind, _name, onEvent, onDrop, onRetry) => {
      h.connections++
      h.emit = onEvent
      h.drop = onDrop
      h.retry = onRetry ?? ((): void => undefined)
      return {
        close: () => {
          h.closed++
        },
      }
    },
    post: (_kind, _name, action, body) =>
      new Promise((resolve) => {
        h.posts.push({ action, body: body as Record<string, unknown>, answer: (ok, status = ok ? 200 : 400, b = ok ? { ok: true } : { error: 'refused' }) => resolve({ ok, status, body: b }) })
      }),
    beacon: (_kind, _name, action) => {
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
    onHidden: () => undefined,
    onPresence: () => undefined,
    onPrefabOps: () => undefined,
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
    const collab = createCollab(h.transport, { level: () => null, onSnapshot: () => undefined, onApplied: () => undefined, onRejected: () => undefined, onPeers: () => undefined, onHolds: () => undefined, onHidden: () => undefined,
    onPresence: () => undefined, onPrefabOps: () => undefined, onError: () => undefined })
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
    const ops = s.h.posts.filter((p) => p.action === 'ops')
    expect(ops).toHaveLength(2)
    expect(ops[1]!.body.connId).toBe('me2')
    expect(s.h.posts.some((p) => p.action === 'leave' && p.body.connId === 'me'), 'the dead connection is left').toBe(true)
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

  it('holds go out one at a time, in order', async () => {
    const s = await setUp()
    const p = s.collab.setHolds([{ id: 'a' }])
    const q = s.collab.setHolds([])
    await tick()
    expect(s.h.posts.map((x) => x.action), 'the second waits for the first').toEqual(['hold'])
    s.h.posts[0]!.answer(true, 200, { ok: true })
    await p
    await tick()
    expect(s.h.posts.map((x) => x.action)).toEqual(['hold', 'hold'])
    expect(s.h.posts[1]!.body.refs).toEqual([])
    s.h.posts[1]!.answer(true, 200, { ok: true })
    await q
  })

  it('a new hello on the same session says goodbye for the old connection', async () => {
    const s = await setUp()
    s.h.emit({ event: 'hello', data: { connId: 'me2', name: 'Ada' } })
    expect(s.h.posts.map((x) => [x.action, x.body.connId])).toEqual([['leave', 'me']])
    expect(s.collab.connId()).toBe('me2')
    s.collab.ping()
    expect(s.h.posts.at(-1)!.body).toEqual({ connId: 'me2' })
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

describe('following, over the wire (ADR 0155)', () => {
  const camera = { kind: 'camera', position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, ortho: null }
  it('reads a camera, perspective or isometric, and keeps only what it knows', () => {
    expect(parseCameraPresence({ ...camera, junk: 1 })).toEqual(camera)
    expect(parseCameraPresence({ ...camera, ortho: 12 })!.ortho).toBe(12)
  })
  it('refuses a camera it cannot use', () => {
    expect(parseCameraPresence({ ...camera, ortho: 0 }), 'no height to show').toBeNull()
    expect(parseCameraPresence({ ...camera, ortho: undefined }), 'says neither').toBeNull()
    expect(parseCameraPresence({ ...camera, target: { x: 1 } })).toBeNull()
    expect(parseCameraPresence({ ...camera, kind: 'pose' })).toBeNull()
  })
  it('reads a follow and an unfollow', () => {
    expect(parseFollowPresence({ kind: 'follow', leader: 'ana' })).toEqual({ kind: 'follow', leader: 'ana' })
    expect(parseFollowPresence({ kind: 'follow', leader: null })).toEqual({ kind: 'follow', leader: null })
    expect(parseFollowPresence({ kind: 'follow', leader: 3 })).toBeNull()
    expect(parseFollowPresence({ kind: 'follow' })).toBeNull()
  })
})

describe('who came and who went (ADR 0155)', () => {
  const ada = { connId: 'a', name: 'Ada' }
  const bob = { connId: 'b', name: 'Bob' }
  const me = { connId: 'me', name: 'Kodjo' }
  it('names arrivals and departures', () => {
    expect(peerChanges([me, ada], [me, bob], new Set(['me']))).toEqual({ joined: [bob], left: [ada] })
  })
  it('never counts this tab, under any connection it has had', () => {
    const old = { connId: 'me-old', name: 'Kodjo' }
    expect(peerChanges([old, ada], [me, ada], new Set(['me-old', 'me']))).toEqual({ joined: [], left: [] })
  })
})

describe('the connection dot (ADR 0155)', () => {
  it('is connecting until the snapshot, live after it, connecting on a drop the browser retries, and gone on leaving', async () => {
    const h = harness()
    const seen: (Connection | null)[] = []
    const collab = createCollab(h.transport, {
      level: () => null,
      onSnapshot: () => undefined,
      onApplied: () => undefined,
      onRejected: () => undefined,
      onPeers: () => undefined,
      onHolds: () => undefined,
      onHidden: () => undefined,
      onPresence: () => undefined,
      onPrefabOps: () => undefined,
      onError: () => undefined,
      onConnection: (c) => seen.push(c),
    })
    const joined = collab.join('lv')
    expect(collab.connection()).toBe('connecting')
    h.emit({ event: 'hello', data: { connId: 'me', name: 'Ada' } })
    h.emit({ event: 'snapshot', data: { level: fixture(), seq: 0, holds: [], peers: [] } })
    await joined
    expect(collab.connection()).toBe('live')
    h.retry()
    expect(collab.connection()).toBe('connecting')
    h.emit({ event: 'snapshot', data: { level: fixture(), seq: 0, holds: [], peers: [] } })
    void collab.leave()
    expect(seen).toEqual(['connecting', 'live', 'connecting', 'live', null])
  })
  it('is lost when the stream closes for good', async () => {
    const s = await setUp()
    s.h.drop('the live session could not be opened')
    expect(s.collab.connection()).toBe('lost')
  })
})

describe('who has which asset open (ADR 0159)', () => {
  it('hands on the whole set, starts empty on each new connection, and says what I have open in order', async () => {
    const h = harness()
    const seen: string[][] = []
    const collab = createCollab(h.transport, {
      level: () => null,
      onSnapshot: () => undefined,
      onApplied: () => undefined,
      onRejected: () => undefined,
      onPeers: () => undefined,
      onHolds: () => undefined,
      onHidden: () => undefined,
      onPresence: () => undefined,
      onPrefabOps: () => undefined,
      onError: () => undefined,
      onOpenAssets: (open) => seen.push(open.map((o) => `${o.name}:${o.assetId}`)),
    })
    const joined = collab.join('lv')
    h.emit({ event: 'hello', data: { connId: 'me', name: 'Ada' } })
    h.emit({ event: 'snapshot', data: { level: fixture(), seq: 0, holds: [], peers: [] } })
    h.emit({ event: 'open-assets', data: { open: [{ assetId: 'm1', connId: 'other', name: 'Bob' }] } })
    await joined
    expect(seen).toEqual([[], ['Bob:m1']])

    const p = collab.setOpenAssets(['m1'])
    const q = collab.setOpenAssets([])
    await tick()
    expect(h.posts.map((x) => x.action), 'the second waits for the first').toEqual(['assets'])
    expect(h.posts[0]!.body).toEqual({ connId: 'me', assetIds: ['m1'] })
    h.posts[0]!.answer(true)
    await p
    await tick()
    expect(h.posts[1]!.body.assetIds).toEqual([])
    h.posts[1]!.answer(true)
    await q

    void collab.leave()
    expect(seen.at(-1), 'nobody, once out of the room').toEqual([])
  })
})

import { applyBatch, type Level, type NodeRef, type Op } from '@mp/content'

/**
 * The editor's side of live level editing (ADR 0089).
 *
 * The server holds the level. This joins it, keeps a copy in step, and sends every local edit as the op
 * batch the document reported. Local edits apply at once (the document already did) and are **unacked** until
 * the server echoes them back numbered; a remote batch arriving while unacked edits exist is applied under
 * them — roll the unacked back, apply the remote, put the unacked on again — so every copy ends in the
 * server's order. A rejection rolls the batch back and tells the host.
 *
 * The transport is a small interface (server-sent events in, POST out) so the core is tested with a fake one.
 */
export type ServerEvent =
  | { event: 'hello'; data: { connId: string; name: string } }
  | { event: 'snapshot'; data: { level: Level; seq: number; holds: Hold[]; peers: Peer[] } }
  | { event: 'ops'; data: { seq: number; from: string; batchId: string; ops: Op[] } }
  | { event: 'holds'; data: { holds: Hold[] } }
  | { event: 'peers'; data: { peers: Peer[] } }
  | { event: 'presence'; data: { from: string; name: string; data: unknown } }
  | { event: 'error'; data: { message: string } }

export interface Hold {
  ref: NodeRef
  connId: string
  name: string
}
export interface Peer {
  connId: string
  name: string
}

export interface Stream {
  close: () => void
}

export interface LiveTransport {
  /** Open the event stream for `name`. `onDrop` fires when the stream closes for good (the server said 4xx). */
  connect: (name: string, onEvent: (e: ServerEvent) => void, onDrop: (why: string) => void) => Stream
  post: (name: string, action: string, body: unknown) => Promise<{ ok: boolean; status: number; body: unknown }>
  /** A fire-and-forget POST that outlives the page (a closing tab). */
  beacon: (name: string, action: string, body: unknown) => void
}

export interface LocalBatch {
  ops: Op[]
  inverses: Op[]
}

export interface CollabHooks {
  /** The live level to apply remote ops to. Replaced by `onSnapshot`. */
  level: () => Level | null
  /** A fresh copy of the level arrived (join, reconnect). The host builds its document over it. */
  onSnapshot: (level: Level, seq: number) => void
  /** Ops were applied to the level from outside the document: the remote batch, and any local ones re-applied. */
  onApplied: (ops: Op[]) => void
  /** A local batch the server refused, already rolled back. */
  onRejected: (batch: LocalBatch, reason: string) => void
  onPeers: (peers: Peer[]) => void
  onHolds: (holds: Hold[]) => void
  onPresence: (from: string, name: string, data: unknown) => void
  onError: (message: string) => void
}

export interface Collab {
  /** Join a level. Resolves after the first snapshot; rejects when the server refuses. */
  join: (name: string) => Promise<void>
  leave: () => void
  /** Send a batch the document already applied. */
  submit: (batch: LocalBatch) => void
  flush: () => Promise<void>
  /**
   * My holds are exactly `refs`. Sent one after another, never two in flight, so the server sees them in the
   * order they were asked — a hold overtaking its release left a node held that nobody had selected.
   */
  setHolds: (refs: NodeRef[]) => Promise<{ ok: true } | { ok: false; holder: string; refused: NodeRef[] }>
  /** Still here. The server drops a connection it has not heard from in a while, holds included. */
  ping: () => void
  presence: (data: unknown) => void
  /** Release everything and say goodbye without waiting — for `pagehide`. */
  beaconLeave: () => void
  connId: () => string | null
  name: () => string | null
  peers: () => Peer[]
  holds: () => Hold[]
  /** Unacked local batches, for tests and the status line. */
  pending: () => number
}

/**
 * What a client streams mid-drag (ADR 0089 phase 4): the local pose of each node it is dragging, ~10 Hz. Peers
 * pose their groups from it and write nothing; the op at drag end is what lands. `end` says the drag is over
 * and every group goes back to its data pose (a drag that returned to its start sends no op).
 */
export interface PosePresence {
  kind: 'pose'
  poses: { ref: NodeRef; position: Vec3; rotation: Vec3; scale: Vec3 }[]
  end?: boolean
}
export interface Vec3 {
  x: number
  y: number
  z: number
}

const isVec3 = (v: unknown): v is Vec3 => typeof v === 'object' && v !== null && ['x', 'y', 'z'].every((k) => typeof (v as Record<string, unknown>)[k] === 'number')
const isRef = (r: unknown): r is NodeRef => {
  if (typeof r !== 'object' || r === null) return false
  const o = r as Record<string, unknown>
  return typeof o.id === 'string' ? o.table === undefined || typeof o.table === 'string' : typeof o.owner === 'string' && typeof o.node === 'string'
}

/** A presence payload off the wire, or `null` when it is not one this editor knows. Peers' data, not trusted. */
export const parsePresence = (data: unknown): PosePresence | null => {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.kind !== 'pose' || !Array.isArray(d.poses)) return null
  const poses: PosePresence['poses'] = []
  for (const p of d.poses as unknown[]) {
    if (typeof p !== 'object' || p === null) return null
    const q = p as Record<string, unknown>
    if (!isRef(q.ref) || !isVec3(q.position) || !isVec3(q.rotation) || !isVec3(q.scale)) return null
    poses.push({ ref: q.ref, position: q.position, rotation: q.rotation, scale: q.scale })
  }
  return { kind: 'pose', poses, ...(d.end === true ? { end: true } : {}) }
}

let nextBatch = 0
const newBatchId = (): string => `${Date.now().toString(36)}-${(nextBatch++).toString(36)}`

export const createCollab = (transport: LiveTransport, hooks: CollabHooks): Collab => {
  let stream: Stream | null = null
  let name: string | null = null
  let connId: string | null = null
  let seq = 0
  let peers: Peer[] = []
  let holds: Hold[] = []
  let unacked: { batchId: string; ops: Op[]; inverses: Op[] }[] = []
  let joined: { resolve: () => void; reject: (e: Error) => void } | null = null
  /** Hold messages queue behind one another: order is the point of them. */
  let holdChain: Promise<unknown> = Promise.resolve()

  const rollbackUnacked = (level: Level): void => {
    for (let i = unacked.length - 1; i >= 0; i--) applyBatch(level, unacked[i]!.inverses)
  }
  /** Put the unacked edits back on top of the level as it now is; one that no longer applies is dropped. */
  const reapplyUnacked = (level: Level): Op[] => {
    const applied: Op[] = []
    const kept: typeof unacked = []
    for (const u of unacked) {
      try {
        const r = applyBatch(level, u.ops)
        u.inverses = r.inverses
        kept.push(u)
        applied.push(...r.ops)
      } catch (e) {
        hooks.onRejected({ ops: u.ops, inverses: u.inverses }, `no longer applies: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    unacked = kept
    return applied
  }

  const resnapshot = (): void => {
    // The stream is the only way to a fresh copy: reopen it. The server greets every connection with one.
    if (name === null) return
    stream?.close()
    stream = transport.connect(name, onEvent, onDrop)
  }

  const onEvent = (e: ServerEvent): void => {
    switch (e.event) {
      case 'hello': {
        // A new connection on an old session (the stream reconnected): the old one is dead but the server
        // may not know yet, and it holds whatever was selected. Say goodbye for it.
        const old = connId
        connId = e.data.connId
        if (old !== null && old !== connId && name !== null) void transport.post(name, 'leave', { connId: old }).catch(() => undefined)
        return
      }
      case 'snapshot': {
        seq = e.data.seq
        peers = e.data.peers
        holds = e.data.holds
        hooks.onSnapshot(e.data.level, seq)
        hooks.onPeers(peers)
        hooks.onHolds(holds)
        // Local edits the server has not confirmed are put back on the fresh copy and sent again.
        const level = hooks.level()
        if (level !== null && unacked.length > 0) {
          const again = [...unacked]
          unacked = []
          for (const u of again) {
            try {
              const r = applyBatch(level, u.ops)
              submitBatch({ ops: r.ops, inverses: r.inverses }, u.batchId)
            } catch (err) {
              hooks.onRejected({ ops: u.ops, inverses: u.inverses }, `no longer applies: ${err instanceof Error ? err.message : String(err)}`)
            }
          }
          if (again.length > 0) hooks.onApplied(again.flatMap((u) => u.ops))
        }
        joined?.resolve()
        joined = null
        return
      }
      case 'ops': {
        if (e.data.seq !== seq + 1) {
          resnapshot()
          return
        }
        seq = e.data.seq
        if (e.data.from === connId) {
          unacked = unacked.filter((u) => u.batchId !== e.data.batchId)
          return
        }
        const level = hooks.level()
        if (level === null) return
        try {
          rollbackUnacked(level)
          applyBatch(level, e.data.ops)
        } catch {
          resnapshot()
          return
        }
        const reapplied = reapplyUnacked(level)
        hooks.onApplied([...e.data.ops, ...reapplied])
        return
      }
      case 'holds':
        holds = e.data.holds
        hooks.onHolds(holds)
        return
      case 'peers':
        peers = e.data.peers
        hooks.onPeers(peers)
        return
      case 'presence':
        hooks.onPresence(e.data.from, e.data.name, e.data.data)
        return
      case 'error':
        hooks.onError(e.data.message)
        return
    }
  }

  const onDrop = (why: string): void => {
    if (joined !== null) {
      joined.reject(new Error(why))
      joined = null
    }
    hooks.onError(why)
  }

  const submitBatch = (batch: LocalBatch, batchId: string): void => {
    if (name === null || connId === null) return
    const entry = { batchId, ops: batch.ops, inverses: batch.inverses }
    unacked.push(entry)
    const level = name
    void transport.post(level, 'ops', { connId, batchId, ops: batch.ops }).then(
      (r) => {
        if (r.ok) return
        // Refused: take this batch off, along with everything after it, then put the later ones back.
        const lvl = hooks.level()
        const at = unacked.indexOf(entry)
        if (lvl !== null && at >= 0) {
          for (let i = unacked.length - 1; i >= at; i--) applyBatch(lvl, unacked[i]!.inverses)
          unacked.splice(at, 1)
          const later = unacked.splice(at)
          unacked.push(...later)
          const back: Op[] = []
          for (const u of later) {
            try {
              back.push(...applyBatch(lvl, u.ops).ops)
            } catch {
              unacked = unacked.filter((x) => x !== u)
            }
          }
          hooks.onApplied([...entry.inverses, ...back])
        } else unacked = unacked.filter((x) => x !== entry)
        const reason = typeof (r.body as { error?: unknown } | null)?.error === 'string' ? (r.body as { error: string }).error : `refused (${r.status})`
        hooks.onRejected(batch, reason)
      },
      (e: unknown) => hooks.onError(`could not send an edit: ${e instanceof Error ? e.message : String(e)}`),
    )
  }

  return {
    join: (level) =>
      new Promise<void>((resolve, reject) => {
        stream?.close()
        name = level
        connId = null
        seq = 0
        unacked = []
        joined = { resolve, reject }
        stream = transport.connect(level, onEvent, onDrop)
      }),
    leave: () => {
      stream?.close()
      stream = null
      if (name !== null && connId !== null) void transport.post(name, 'leave', { connId }).catch(() => undefined)
      name = null
      connId = null
      unacked = []
      peers = []
      holds = []
    },
    submit: (batch) => submitBatch(batch, newBatchId()),
    flush: async () => {
      if (name === null || connId === null) return
      await transport.post(name, 'flush', { connId })
    },
    setHolds: (refs) => {
      const send = async (): Promise<{ ok: true } | { ok: false; holder: string; refused: NodeRef[] }> => {
        if (name === null || connId === null) return { ok: true }
        const r = await transport.post(name, 'hold', { connId, refs })
        const body = r.body as { ok?: boolean; holder?: string; refused?: NodeRef[] } | null
        return body?.ok === false ? { ok: false, holder: body.holder ?? 'someone', refused: body.refused ?? refs } : { ok: true }
      }
      const next = holdChain.then(send, send)
      holdChain = next.catch(() => undefined)
      return next
    },
    ping: () => {
      if (name === null || connId === null) return
      void transport.post(name, 'ping', { connId }).catch(() => undefined)
    },
    presence: (data) => {
      if (name === null || connId === null) return
      void transport.post(name, 'presence', { connId, data }).catch(() => undefined)
    },
    beaconLeave: () => {
      if (name !== null && connId !== null) transport.beacon(name, 'leave', { connId })
    },
    connId: () => connId,
    name: () => name,
    peers: () => peers,
    holds: () => holds,
    pending: () => unacked.length,
  }
}

/** The real transport: `EventSource` in, `fetch` out, `sendBeacon` for the way out. */
export const httpTransport = (): LiveTransport => ({
  connect: (name, onEvent, onDrop) => {
    const source = new EventSource(`/api/live/${encodeURIComponent(name)}/events`)
    for (const event of ['hello', 'snapshot', 'ops', 'holds', 'peers', 'presence', 'error'] as const) {
      source.addEventListener(event, (m) => onEvent({ event, data: JSON.parse((m as MessageEvent<string>).data) } as ServerEvent))
    }
    // EventSource retries on its own after a network drop. A 4xx is a closed stream that never opened: the
    // level is not there or the login lapsed. `readyState` tells the two apart.
    source.addEventListener('error', () => {
      if (source.readyState === EventSource.CLOSED) onDrop('the live session could not be opened')
    })
    return { close: () => source.close() }
  },
  post: async (name, action, body) => {
    const r = await fetch(`/api/live/${encodeURIComponent(name)}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) }
  },
  beacon: (name, action, body) => {
    navigator.sendBeacon(`/api/live/${encodeURIComponent(name)}/${action}`, new Blob([JSON.stringify(body)], { type: 'application/json' }))
  },
})

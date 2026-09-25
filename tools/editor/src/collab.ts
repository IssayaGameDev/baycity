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
  | { event: 'snapshot'; data: { level: Level; seq: number; holds: Hold[]; peers: Peer[]; hidden?: string[] } }
  | { event: 'ops'; data: { seq: number; from: string; batchId: string; ops: Op[] } }
  | { event: 'holds'; data: { holds: Hold[] } }
  | { event: 'peers'; data: { peers: Peer[] } }
  | { event: 'presence'; data: { from: string; name: string; data: unknown } }
  /** Nodes hidden in the viewport, by `refKey` (ADR 0132). A view of the level, so it carries no sequence. */
  | { event: 'hidden'; data: { hidden: string[] } }
  /** A prefab this level references was edited, in its own document (ADR 0091). Repaint, do not re-send. */
  | { event: 'prefab'; data: { assetId: string; ops: Op[] } }
  /** A data-file asset was edited (ADR 0159) — on every room's stream, since everyone draws it. Checked by `assetSync.ts`. */
  | { event: 'asset'; data: unknown }
  /** Who has which asset open in their Inspector, everyone in every document (ADR 0159): the whole set. */
  | { event: 'open-assets'; data: { open: OpenAsset[] } }
  /** Who is in which Inspector field, everyone in every document (ADR 0160): the whole set. */
  | { event: 'fields'; data: { fields: FieldFocus[] } }
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
/** A connection with an asset open in its Inspector (ADR 0159). */
export interface OpenAsset {
  assetId: string
  connId: string
  name: string
}
/**
 * Where a connection is in an Inspector (ADR 0160): the line (`card`, `field`, as `fieldPresence.ts` names it) of
 * what it writes to — `targets`, `<kind>:<doc>|<refKey>` per node, `<kind>:<doc>|@game` / `@env`, `asset:<id>`.
 */
export interface FieldSpot {
  targets: string[]
  card: string
  field: string
}
export interface FieldFocus extends FieldSpot {
  connId: string
  name: string
}

export interface Stream {
  close: () => void
}

/** Which document: a level by name, or a prefab by asset id (ADR 0091). */
export type DocKind = 'level' | 'prefab'

/**
 * How the open room's stream is (ADR 0155), the dot on your own icon: greeted with a snapshot (`live`), opening
 * or reopening after a network drop (`connecting`), or closed for good (`lost`).
 */
export type Connection = 'connecting' | 'live' | 'lost'

export interface LiveTransport {
  /**
   * Open the event stream for a document. `onDrop` fires when it closes for good (the server said 4xx);
   * `onRetry` when it dropped and the browser is opening it again on its own.
   */
  connect: (kind: DocKind, name: string, onEvent: (e: ServerEvent) => void, onDrop: (why: string) => void, onRetry?: () => void) => Stream
  post: (kind: DocKind, name: string, action: string, body: unknown) => Promise<{ ok: boolean; status: number; body: unknown }>
  /** A fire-and-forget POST that outlives the page (a closing tab). */
  beacon: (kind: DocKind, name: string, action: string, body: unknown) => void
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
  /**
   * The whole hidden set, by `refKey` (ADR 0132) — never a delta, so a dropped event cannot leave two
   * editors disagreeing about what is on screen.
   */
  onHidden: (keys: string[]) => void
  /**
   * A prefab the open level uses changed. The ops are against that prefab's own document, whose one root is
   * the definition this level resolved, so applying them there is what makes the placements follow.
   */
  onPrefabOps: (assetId: string, ops: Op[]) => void
  onError: (message: string) => void
  /** A data-file asset was edited, by anyone, this tab included (ADR 0159). */
  onAsset?: (data: unknown) => void
  /** Who has which asset open, the whole set: from the server, and `[]` on a new connection or leaving. */
  onOpenAssets?: (open: OpenAsset[]) => void
  /** Who is in which Inspector field, the whole set, the same way (ADR 0160). */
  onFields?: (fields: FieldFocus[]) => void
  /** The stream's state changed; `null` once no room is open. */
  onConnection?: (state: Connection | null) => void
}

export interface Collab {
  /** Join a document. Resolves after the first snapshot; rejects when the server refuses. */
  join: (name: string, kind?: DocKind) => Promise<void>
  /** Which kind of document is open, or `null`. */
  kind: () => DocKind | null
  /** Leave the open document. Resolves once the server has been told, which is when it stops being open. */
  leave: () => Promise<void>
  /** Send a batch the document already applied. */
  submit: (batch: LocalBatch) => void
  flush: () => Promise<void>
  /**
   * My holds are exactly `refs` — what I have selected, shown to the others and never refused (ADR 0158). Sent
   * one after another, never two in flight, so the server sees them in the order they were asked — a hold
   * overtaking its release left a node shown as selected that nobody had selected.
   */
  setHolds: (refs: NodeRef[]) => Promise<void>
  /** The assets I have open are exactly these (ADR 0159), shown to everyone. In order, as holds are. */
  setOpenAssets: (assetIds: string[]) => Promise<void>
  /** The Inspector field I am in, or none (ADR 0160), shown to everyone. In order, as holds are. */
  setField: (spot: FieldSpot | null) => Promise<void>
  /** Still here. The server drops a connection it has not heard from in a while, holds included. */
  ping: () => void
  /**
   * Send ops to a **prefab document this level uses**, without leaving the level (ADR 0091) — what "Apply to
   * prefab" does. Resolves `null` on success, or why the server refused.
   */
  submitToPrefab: (assetId: string, ops: Op[]) => Promise<string | null>
  presence: (data: unknown) => void
  /**
   * Hide or show nodes for everyone in the room (ADR 0132). Fire and forget: the server's `hidden` event is
   * the ack, exactly as an op batch's echo is, so nothing here has to guess the result.
   */
  setHidden: (keys: string[], hidden: boolean) => void
  /** Release everything and say goodbye without waiting — for `pagehide`. */
  beaconLeave: () => void
  connId: () => string | null
  name: () => string | null
  peers: () => Peer[]
  holds: () => Hold[]
  /** How the open room's stream is, or `null` with no room open. */
  connection: () => Connection | null
  /** Unacked local batches, for tests. */
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

/**
 * Where a client's camera is, sent only while somebody follows it (ADR 0155): ~5 Hz, and only when it moved.
 * `target` is what it orbits; `ortho` the half-height an isometric camera shows, `null` in perspective.
 */
export interface CameraPresence {
  kind: 'camera'
  position: Vec3
  target: Vec3
  ortho: number | null
}

/**
 * Start following `leader`'s camera, or stop (`null`). Relayed to everyone like any presence; the leader is
 * the one who acts on it, by streaming its camera while it has followers.
 */
export interface FollowPresence {
  kind: 'follow'
  leader: string | null
}

/**
 * Who came and who went between two peer lists (ADR 0155), leaving out every connection that was ever this
 * tab's: a reconnect is a new connection, and the old one may still be listed for a moment under your name.
 */
export const peerChanges = (before: readonly Peer[], after: readonly Peer[], mine: ReadonlySet<string>): { joined: Peer[]; left: Peer[] } => {
  const was = new Set(before.map((p) => p.connId))
  const now = new Set(after.map((p) => p.connId))
  return {
    joined: after.filter((p) => !was.has(p.connId) && !mine.has(p.connId)),
    left: before.filter((p) => !now.has(p.connId) && !mine.has(p.connId)),
  }
}

/** A camera presence off the wire, or `null`. Peers' data, not trusted. */
export const parseCameraPresence = (data: unknown): CameraPresence | null => {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.kind !== 'camera' || !isVec3(d.position) || !isVec3(d.target)) return null
  const ortho = d.ortho === null ? null : typeof d.ortho === 'number' && d.ortho > 0 ? d.ortho : undefined
  if (ortho === undefined) return null
  return { kind: 'camera', position: d.position, target: d.target, ortho }
}

/** A follow presence off the wire, or `null`. */
export const parseFollowPresence = (data: unknown): FollowPresence | null => {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.kind !== 'follow' || (d.leader !== null && typeof d.leader !== 'string')) return null
  return { kind: 'follow', leader: d.leader }
}

/**
 * Messages that must land in the order they were asked — "my holds are these", then "these": sent one behind
 * another, never two in flight, so a later one cannot overtake an earlier. A failed one does not stop the next.
 */
const inOrder = (): ((send: () => Promise<void>) => Promise<void>) => {
  let chain: Promise<unknown> = Promise.resolve()
  return (send) => {
    const next = chain.then(send, send)
    chain = next.catch(() => undefined)
    return next
  }
}

let nextBatch = 0
const newBatchId = (): string => `${Date.now().toString(36)}-${(nextBatch++).toString(36)}`

export const createCollab = (transport: LiveTransport, hooks: CollabHooks): Collab => {
  let stream: Stream | null = null
  let name: string | null = null
  let kind: DocKind = 'level'
  let connId: string | null = null
  let seq = 0
  let peers: Peer[] = []
  let holds: Hold[] = []
  let unacked: { batchId: string; ops: Op[]; inverses: Op[] }[] = []
  let joined: { resolve: () => void; reject: (e: Error) => void } | null = null
  /** Each of these queues behind its own kind: order is the point of them. */
  const holdsInOrder = inOrder()
  const openInOrder = inOrder()
  const fieldsInOrder = inOrder()
  let connection: Connection | null = null
  const setConnection = (next: Connection | null): void => {
    if (next === connection) return
    connection = next
    hooks.onConnection?.(next)
  }
  /** The stream dropped and the browser is reopening it: a reconnect's snapshot says when it is back. */
  const onRetry = (): void => {
    if (name !== null) setConnection('connecting')
  }

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
    setConnection('connecting')
    stream = transport.connect(kind, name, onEvent, onDrop, onRetry)
  }

  const onEvent = (e: ServerEvent): void => {
    switch (e.event) {
      case 'hello': {
        // A new connection on an old session (the stream reconnected): the old one is dead but the server
        // may not know yet, and it holds whatever was selected. Say goodbye for it.
        const old = connId
        connId = e.data.connId
        if (old !== null && old !== connId && name !== null) void transport.post(kind, name, 'leave', { connId: old }).catch(() => undefined)
        return
      }
      case 'snapshot': {
        seq = e.data.seq
        peers = e.data.peers
        holds = e.data.holds
        setConnection('live')
        hooks.onSnapshot(e.data.level, seq)
        hooks.onPeers(peers)
        hooks.onHolds(holds)
        // A new connection: the server sends who has what open, and who is in which field, next, if anyone is.
        hooks.onOpenAssets?.([])
        hooks.onFields?.([])
        // Part of the snapshot, so the first paint already leaves out what is hidden.
        hooks.onHidden(e.data.hidden ?? [])
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
      case 'hidden':
        hooks.onHidden(e.data.hidden)
        return
      case 'prefab':
        hooks.onPrefabOps(e.data.assetId, e.data.ops)
        return
      case 'asset':
        hooks.onAsset?.(e.data)
        return
      case 'open-assets':
        hooks.onOpenAssets?.(e.data.open)
        return
      case 'fields':
        hooks.onFields?.(e.data.fields)
        return
      case 'error':
        hooks.onError(e.data.message)
        return
    }
  }

  const onDrop = (why: string): void => {
    setConnection('lost')
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
    void transport.post(kind, level, 'ops', { connId, batchId, ops: batch.ops }).then(
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
    join: (level, of = 'level') =>
      new Promise<void>((resolve, reject) => {
        stream?.close()
        name = level
        kind = of
        connId = null
        seq = 0
        unacked = []
        joined = { resolve, reject }
        setConnection('connecting')
        stream = transport.connect(of, level, onEvent, onDrop, onRetry)
      }),
    leave: () => {
      stream?.close()
      stream = null
      setConnection(null)
      /**
       * The promise is returned as well as fired: every existing caller is leaving on the way to something
       * else and does not care, but renaming or deleting the open level has to know the server has closed the
       * document — while it is open the server refuses both, and rightly (ADR 0110).
       */
      const posted = name !== null && connId !== null ? transport.post(kind, name, 'leave', { connId }).then(() => undefined, () => undefined) : Promise.resolve()
      name = null
      connId = null
      unacked = []
      peers = []
      holds = []
      hooks.onOpenAssets?.([])
      hooks.onFields?.([])
      return posted
    },
    submit: (batch) => submitBatch(batch, newBatchId()),
    flush: async () => {
      if (name === null || connId === null) return
      await transport.post(kind, name, 'flush', { connId })
    },
    setHolds: (refs) =>
      holdsInOrder(async () => {
        if (name === null || connId === null) return
        await transport.post(kind, name, 'hold', { connId, refs })
      }),
    setOpenAssets: (assetIds) =>
      openInOrder(async () => {
        if (name === null || connId === null) return
        await transport.post(kind, name, 'assets', { connId, assetIds })
      }),
    setField: (spot) =>
      fieldsInOrder(async () => {
        if (name === null || connId === null) return
        await transport.post(kind, name, 'field', { connId, spot })
      }),
    ping: () => {
      if (name === null || connId === null) return
      void transport.post(kind, name, 'ping', { connId }).catch(() => undefined)
    },
    setHidden: (keys, hidden) => {
      if (name === null || connId === null || keys.length === 0) return
      void transport.post(kind, name, 'hidden', { connId, keys, hidden }).catch(() => undefined)
    },
    submitToPrefab: async (assetId, ops) => {
      if (connId === null) return 'not in a live room'
      const r = await transport.post('prefab', assetId, 'ops', { connId, batchId: newBatchId(), ops })
      if (r.ok) return null
      const body = r.body as { error?: unknown } | null
      return typeof body?.error === 'string' ? body.error : `refused (${r.status})`
    },
    presence: (data) => {
      if (name === null || connId === null) return
      void transport.post(kind, name, 'presence', { connId, data }).catch(() => undefined)
    },
    beaconLeave: () => {
      if (name !== null && connId !== null) transport.beacon(kind, name, 'leave', { connId })
    },
    connId: () => connId,
    name: () => name,
    kind: () => (name === null ? null : kind),
    peers: () => peers,
    holds: () => holds,
    connection: () => connection,
    pending: () => unacked.length,
  }
}

/** The real transport: `EventSource` in, `fetch` out, `sendBeacon` for the way out. */
export const httpTransport = (): LiveTransport => ({
  connect: (kind, name, onEvent, onDrop, onRetry) => {
    const source = new EventSource(`/api/live/${kind}/${encodeURIComponent(name)}/events`)
    for (const event of ['hello', 'snapshot', 'ops', 'holds', 'peers', 'presence', 'hidden', 'prefab', 'asset', 'open-assets', 'fields', 'error'] as const) {
      source.addEventListener(event, (m) => onEvent({ event, data: JSON.parse((m as MessageEvent<string>).data) } as ServerEvent))
    }
    // EventSource retries on its own after a network drop. A 4xx is a closed stream that never opened: the
    // level is not there or the login lapsed. `readyState` tells the two apart.
    source.addEventListener('error', () => {
      if (source.readyState === EventSource.CLOSED) onDrop('the live session could not be opened')
      else onRetry?.()
    })
    return { close: () => source.close() }
  },
  post: async (kind, name, action, body) => {
    const r = await fetch(`/api/live/${kind}/${encodeURIComponent(name)}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) }
  },
  beacon: (kind, name, action, body) => {
    navigator.sendBeacon(`/api/live/${kind}/${encodeURIComponent(name)}/${action}`, new Blob([JSON.stringify(body)], { type: 'application/json' }))
  },
})

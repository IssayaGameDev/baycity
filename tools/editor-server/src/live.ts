// By file, not the package index: the index pulls in the loader (and `@mp/core`), which the Vite config that
// bundles this file for the dev editor cannot load.
import { applyBatch, OpError, refKey, touchedRefs, type NodeRef, type Op } from '../../../packages/content/src/ops'
import type { Level, Node } from '../../../packages/content/src/types'
import { hydratePrefabs, stripHydrated } from '../../../packages/content/src/prefabs'
import { validateLevel, validateNodeTree } from '../../../packages/content/src/validate'
import type { User } from './config'

/**
 * Live level documents (ADR 0089): the server holds each open level, applies every edit as it arrives, and
 * tells every open editor what changed.
 *
 * - A level is loaded from disk on the first `join`, validated, and kept in memory while anyone has it open.
 * - An edit is an op batch (`ops.ts`). It applies here with the same `applyBatch` the editor used, so every
 *   copy stays identical; a batch that fails is refused whole and the sender rolls back.
 * - Every applied batch is numbered (`seq`) and broadcast to **every** client, the sender included — the echo
 *   is the sender's acknowledgement. Nothing is queued per client: a client that cannot keep up is a client
 *   whose stream will resnapshot on reconnect.
 * - The file on disk is written on a debounce: `idleMs` after the last edit, `maxMs` at most since the first
 *   unwritten one, and always when the last editor leaves, on `flushAll` (deploy, shutdown) and before any
 *   read of the file from outside. After the write, `changed` names every user who edited since the last
 *   write, so each of their sessions goes dirty (`sessions.ts`) and the mirror learns the path — disk first,
 *   feed second, as the mirror requires.
 * - Holds: a node a client holds (it has it selected) is refused to every other connection. `hold` is the
 *   whole set a connection wants — "my holds are exactly these" — so a late or reordered message cannot leave a
 *   ghost; released on the client leaving and when the node is removed. Identity is the **connection**, so two
 *   tabs of one person are two holders.
 * - Liveness: a connection is `seen` on every message; `sweep` leaves one silent for `staleMs` (a tab whose
 *   stream died without the server hearing it), which releases its holds. The editor pings while idle.
 *
 * **Two kinds of document.** A level, addressed `level:<name>`, and a prefab, addressed `prefab:<assetId>`
 * (ADR 0091). A prefab document is a `Level` wrapper holding one root node — the shape a prefab document has
 * always had in the editor — so every op, hold, log and debounced write applies to it unchanged. What differs
 * is where it comes from, where it is written, and that a prefab may not contain a placement.
 *
 * **One object per prefab.** Resolving a level's references takes the root from that prefab's *open* document,
 * opening it if nobody had, so a prefab edit is visible to every open level's resolution the instant it
 * applies. A prefab document stays open while any level references it. The editors themselves join the prefab
 * documents their level references, which is how an edit reaches their screens — there is no second delivery
 * path to keep in step.
 *
 * Pure over an injected file system and clock, so it is tested with fake clients.
 */

/**
 * A document's key: the kind and its name, so a level and a prefab cannot collide. A key with no kind in it is
 * a level, which is what every caller meant before prefabs became documents and what a level name still is.
 */
export const docKey = (kind: 'level' | 'prefab', name: string): string => `${kind}:${name}`
/** The canonical key for whatever a caller passed: `sweep` or `flushAll` aside, everything goes through it. */
const canonKey = (key: string): string => {
  const { kind, name } = splitKey(key)
  return docKey(kind, name)
}
const splitKey = (key: string): { kind: 'level' | 'prefab'; name: string } => {
  const at = key.indexOf(':')
  if (at < 0) return { kind: 'level', name: key }
  const kind = key.slice(0, at)
  if (kind !== 'level' && kind !== 'prefab') return { kind: 'level', name: key }
  return { kind, name: key.slice(at + 1) }
}
export interface LiveClient {
  connId: string
  user: User
  send: (event: string, data: unknown, id?: number) => void
}

export interface Hold {
  ref: NodeRef
  connId: string
  name: string
}

export interface Peer {
  connId: string
  name: string
}

export interface LiveOptions {
  /** The file as JSON, or `null` when there is none. */
  readLevel: (name: string) => unknown | null
  writeLevel: (name: string, level: Level) => void
  /** After a write: who edited since the last one, and the repo-relative path. */
  changed: (users: User[], path: string) => void
  /** The last editor left and the file is written: their sessions may commit. */
  onDocClosed?: (users: User[]) => void
  now?: () => number
  idleMs?: number
  maxMs?: number
  logKeep?: number
  /** Timers, injectable for tests. */
  schedule?: (fn: () => void, ms: number) => () => void
  /** A connection silent this long is gone (`sweep`). Default two minutes, the lock rule. */
  staleMs?: number
  /**
   * Prefab definitions on disk, by asset id (ADR 0091). A level references a prefab rather than carrying a
   * copy, so the definitions are resolved when the document opens and removed again before it is written;
   * without them a placement would resolve to nothing here — no inherited nodes, so no holds on them and
   * nothing to repaint. The same store is what a prefab document is loaded from and written back to.
   */
  prefabs?:
    | {
        root: (assetId: string) => Node | undefined
        pathOf: (assetId: string) => string | undefined
        write: (assetId: string, root: Node) => string | null
      }
    | undefined
}

export class LiveError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface ApplyResult {
  ok: true
  seq: number
}

interface LiveDoc {
  /** `level:<name>` or `prefab:<assetId>`. */
  key: string
  kind: 'level' | 'prefab'
  name: string
  /** A level, or the one-root wrapper a prefab document is. */
  level: Level
  seq: number
  log: { seq: number; from: string; ops: Op[] }[]
  clients: Map<string, LiveClient>
  /** When each connection last said anything, for `sweep`. */
  seen: Map<string, number>
  holds: Map<string, Hold>
  /** Who edited since the last write, by email. */
  dirtyBy: Map<string, User>
  /** Everyone who ever edited while the doc was open, for the commit when it closes. */
  contributors: Map<string, User>
  cancelIdle: (() => void) | null
  cancelMax: (() => void) | null
  /** Prefab ids resolution added to `level.prefabs`, so the write strips those and keeps any others. */
  hydrated: string[]
  /** Document keys that resolve a prefab from this one: it stays open while any of them do. */
  dependents: Set<string>
}

export interface Live {
  /** Open (loading from disk if needed) and send `hello` + `snapshot`. Throws `LiveError` 404 / 400. */
  join: (name: string, client: LiveClient) => void
  leave: (name: string, connId: string) => void
  /** Apply a batch from a connection. Throws `LiveError` 400 (bad op, unknown connection), 423 (held by another). */
  apply: (name: string, connId: string, user: User, batch: { batchId: string; ops: Op[] }) => ApplyResult
  /** This connection's holds become exactly `refs`. Refused refs (another's) are named and left out. */
  hold: (name: string, connId: string, user: User, refs: NodeRef[]) => { ok: true } | { ok: false; holder: string; refused: NodeRef[] }
  /** The connection is alive. Any message counts; the editor sends this while idle. */
  ping: (name: string, connId: string, user: User) => void
  /** Leave every connection silent for `staleMs`. Called on a timer by the host. */
  sweep: () => void
  release: (name: string, connId: string, user: User, refs: NodeRef[]) => void
  /** Relay presence (a pose mid-drag, a selection) to the others. No seq, nothing kept. */
  presence: (name: string, connId: string, user: User, data: unknown) => void
  /** Write the file now if there is anything unwritten. */
  flush: (name: string) => void
  flushAll: () => void
  isOpen: (name: string) => boolean
  /** The current level of an open document, or `null`. */
  levelOf: (name: string) => Level | null
  status: () => { name: string; seq: number; peers: Peer[]; holds: number }[]
}

export const levelPath = (name: string): string => `content/levels/${name}.json`
/** Repo-relative path of an asset, from its path inside the assets folder. */
export const assetPath = (rel: string): string => `content/assets/${rel}`

export const createLive = (opts: LiveOptions): Live => {
  const now = opts.now ?? (() => Date.now())
  const idleMs = opts.idleMs ?? 500
  const maxMs = opts.maxMs ?? 5000
  const logKeep = opts.logKeep ?? 500
  const staleMs = opts.staleMs ?? 120_000
  const schedule = opts.schedule ?? ((fn, ms) => {
    const t = setTimeout(fn, ms)
    return () => clearTimeout(t)
  })
  const docs = new Map<string, LiveDoc>()

  const peersOf = (d: LiveDoc): Peer[] => [...d.clients.values()].map((c) => ({ connId: c.connId, name: c.user.name }))
  const holdsOf = (d: LiveDoc): Hold[] => [...d.holds.values()]
  const broadcast = (d: LiveDoc, event: string, data: unknown, id?: number): void => {
    for (const c of d.clients.values()) c.send(event, data, id)
  }

  const blank = (key: string, kind: 'level' | 'prefab', name: string, level: Level): LiveDoc => ({
    key,
    kind,
    name,
    level,
    seq: 0,
    log: [],
    clients: new Map(),
    seen: new Map(),
    holds: new Map(),
    dirtyBy: new Map(),
    contributors: new Map(),
    cancelIdle: null,
    cancelMax: null,
    hydrated: [],
    dependents: new Set(),
  })

  /**
   * Put `from`'s contents into `into`, keeping the object. Every level that resolved a prefab holds that root
   * object, so a rollback has to write through it rather than swap it (the same reason `replaceNode` empties
   * and refills a table root in `ops.ts`).
   */
  const refill = (into: Node, from: Node): void => {
    for (const k of Object.keys(into)) delete (into as unknown as Record<string, unknown>)[k]
    Object.assign(into, structuredClone(from))
  }

  /** A prefab may not contain a placement — the rule `validateLevel` applies to a table entry (ADR 0023). */
  const checkPrefab = (root: unknown, at: string): Node => {
    validateNodeTree(root, at, { ids: new Set(), insidePrefab: true })
    return root as Node
  }

  const open = (given: string): LiveDoc => {
    const key = canonKey(given)
    const have = docs.get(key)
    if (have !== undefined) return have
    const { kind, name } = splitKey(key)

    if (kind === 'prefab') {
      const root = opts.prefabs?.root(name)
      if (root === undefined) throw new LiveError(404, `no prefab asset ${name}`)
      try {
        checkPrefab(root, 'prefab')
      } catch (e) {
        throw new LiveError(400, `prefab ${name} does not load: ${e instanceof Error ? e.message : String(e)}`)
      }
      // A one-root wrapper, which is the shape a prefab document has always had in the editor, so every op
      // applies to it unchanged. The root object is the store's, and a level resolving this id gets the very
      // same object — that sharing is what makes an edit here visible to every open level at once.
      const d = blank(key, 'prefab', name, { id: name, config: {}, nodes: [root] })
      docs.set(key, d)
      return d
    }

    const raw = opts.readLevel(name)
    if (raw === null) throw new LiveError(404, `no level called ${name}`)
    let level: Level
    try {
      level = validateLevel(raw)
    } catch (e) {
      throw new LiveError(400, `${name} does not load: ${e instanceof Error ? e.message : String(e)}`)
    }
    const d = blank(key, 'level', name, level)
    docs.set(key, d)
    hydrate(d)
    return d
  }

  /**
   * Resolve this level's prefab references, taking each definition from that prefab's **open document** and
   * opening one where there is none. So there is exactly one object per prefab in this process, and a level's
   * resolution is right the instant a prefab edit applies. Idempotent: a batch that places a prefab nobody had
   * referenced calls it again.
   */
  const hydrate = (d: LiveDoc): void => {
    if (opts.prefabs === undefined || d.kind !== 'level') return
    const source = {
      root: (assetId: string): Node | undefined => {
        if (opts.prefabs?.root(assetId) === undefined) return undefined
        const prefab = open(docKey('prefab', assetId))
        prefab.dependents.add(d.key)
        return prefab.level.nodes[0]
      },
    }
    for (const id of hydratePrefabs(d.level, source).filled) d.hydrated.push(id)
  }

  const must = (given: string): LiveDoc => {
    const d = docs.get(canonKey(given))
    if (d === undefined) throw new LiveError(404, `${given} is not open`)
    return d
  }

  /** The connection a POST speaks for must exist and belong to the same person as the request. */
  const clientOf = (d: LiveDoc, connId: string, user: User): LiveClient => {
    const c = d.clients.get(connId)
    if (c === undefined) throw new LiveError(400, 'unknown connection; reload the editor')
    if (c.user.email !== user.email) throw new LiveError(400, 'that connection is not yours')
    d.seen.set(connId, now())
    return c
  }

  const flush = (d: LiveDoc): void => {
    d.cancelIdle?.()
    d.cancelMax?.()
    d.cancelIdle = null
    d.cancelMax = null
    if (d.dirtyBy.size === 0) return
    let path: string
    try {
      if (d.kind === 'prefab') {
        const root = checkPrefab(d.level.nodes[0], 'prefab')
        // The root's own name is the file's and is not stamped from the id: a name stored inside a prefab is
        // routinely stale, which is how `AlternatingDanger` came to be carrying `FastElevator`.
        const written = opts.prefabs?.write(d.name, root) ?? null
        if (written === null) throw new Error('the prefab asset is gone')
        path = assetPath(written)
      } else {
        d.level.id = d.name
        validateLevel(d.level)
        // References go to disk, never the definitions they resolve to — and only the ones resolved here, so a
        // level still carrying its own table keeps it.
        opts.writeLevel(d.name, stripHydrated(d.level, d.hydrated))
        path = levelPath(d.name)
      }
    } catch (e) {
      // Every op was checked, so this is a bug; say so to everyone and keep the file as it was.
      broadcast(d, 'error', { message: `not written: ${e instanceof Error ? e.message : String(e)}` })
      return
    }
    const users = [...d.dirtyBy.values()]
    d.dirtyBy.clear()
    opts.changed(users, path)
  }

  /**
   * Write and forget a document nobody is in. A **prefab** stays open while any level resolves from it: its
   * root is the one object those levels read, and dropping it would leave them resolving a stale copy. When a
   * level closes it stops depending, and a prefab nobody depends on and nobody is in closes too.
   */
  const close = (d: LiveDoc): void => {
    if (d.clients.size > 0) return
    if (d.kind === 'prefab' && d.dependents.size > 0) return
    flush(d)
    docs.delete(d.key)
    if (d.contributors.size > 0) opts.onDocClosed?.([...d.contributors.values()])
    // The prefabs this level was holding open may now have nobody.
    for (const other of [...docs.values()]) {
      if (other.dependents.delete(d.key)) close(other)
    }
  }

  const armFlush = (d: LiveDoc): void => {
    d.cancelIdle?.()
    d.cancelIdle = schedule(() => flush(d), idleMs)
    d.cancelMax ??= schedule(() => flush(d), maxMs)
  }

  const releaseHolds = (d: LiveDoc, connId: string, keys?: Set<string>): boolean => {
    let changed = false
    for (const [key, h] of d.holds) {
      if (h.connId !== connId) continue
      if (keys !== undefined && !keys.has(key)) continue
      d.holds.delete(key)
      changed = true
    }
    return changed
  }

  const api: Live = {
    join: (name, client) => {
      const d = open(name)
      d.clients.set(client.connId, client)
      d.seen.set(client.connId, now())
      client.send('hello', { connId: client.connId, name })
      client.send('snapshot', { level: d.level, seq: d.seq, holds: holdsOf(d), peers: peersOf(d) }, d.seq)
      for (const c of d.clients.values()) if (c !== client) c.send('peers', { peers: peersOf(d) })
    },

    leave: (name, connId) => {
      const d = docs.get(canonKey(name))
      if (d === undefined) return
      const client = d.clients.get(connId)
      if (client === undefined) return
      d.clients.delete(connId)
      d.seen.delete(connId)
      const dropped = releaseHolds(d, connId)
      if (d.clients.size === 0) {
        close(d)
        return
      }
      if (dropped) broadcast(d, 'holds', { holds: holdsOf(d) })
      broadcast(d, 'peers', { peers: peersOf(d) })
    },

    apply: (name, connId, user, batch) => {
      const d = must(name)
      clientOf(d, connId, user)
      // A hold covers the node and everything under it: an op on a node, or on any of its ancestors' subtree
      // through a held ancestor, is refused when the holder is another connection.
      if (d.holds.size > 0) {
        for (const op of batch.ops) {
          let refs: NodeRef[]
          try {
            refs = touchedRefs(d.level, op)
          } catch {
            refs = []
          }
          for (const ref of refs) {
            for (const key of [refKey(ref), ...ancestorKeys(d.level, ref)]) {
              const h = d.holds.get(key)
              if (h !== undefined && h.connId !== connId) throw new LiveError(423, `held by ${h.name}`)
            }
          }
        }
      }
      let applied: Op[]
      /**
       * A prefab document is a one-root wrapper, so the op layer reads it as a level scope and would let a
       * node in it reference another prefab — which the schema forbids and no reader could resolve. Checked
       * here rather than only before the write, so the batch is refused while it can still be rolled back.
       */
      const root = d.kind === 'prefab' ? d.level.nodes[0] : undefined
      const undo = root === undefined ? null : structuredClone(root)
      try {
        applied = applyBatch(d.level, batch.ops).ops
        if (root !== undefined) checkPrefab(root, 'prefab')
      } catch (e) {
        // Emptied and refilled, never replaced: every level that resolved this prefab holds **this** object,
        // and handing them a detached copy would leave them reading a prefab nobody is editing.
        if (root !== undefined && undo !== null) refill(root, undo)
        throw new LiveError(400, e instanceof OpError ? e.message : String(e))
      }
      // A batch can place a prefab nobody had referenced yet: resolve it now, or its inherited nodes would
      // not exist here until the document reopened — no holds on them, and nothing to repaint.
      hydrate(d)
      d.seq++
      d.log.push({ seq: d.seq, from: connId, ops: applied })
      while (d.log.length > logKeep) d.log.shift()
      // A removed node releases every hold on it or under it.
      const gone = new Set<string>()
      for (const op of applied) if (op.kind === 'removeNode' || op.kind === 'replaceNode') for (const key of d.holds.keys()) if (!stillThere(d.level, d.holds.get(key)!.ref)) gone.add(key)
      for (const key of gone) d.holds.delete(key)
      broadcast(d, 'ops', { seq: d.seq, from: connId, batchId: batch.batchId, ops: applied }, d.seq)
      if (gone.size > 0) broadcast(d, 'holds', { holds: holdsOf(d) })
      if (applied.length > 0) {
        d.dirtyBy.set(user.email, user)
        d.contributors.set(user.email, user)
        armFlush(d)
      }
      return { ok: true, seq: d.seq }
    },

    hold: (name, connId, user, refs) => {
      const d = must(name)
      clientOf(d, connId, user)
      const want = new Map(refs.map((r) => [refKey(r), r]))
      // Another's: named, and not taken. The rest of the set still applies.
      let holder: string | null = null
      const refused: NodeRef[] = []
      for (const [key, ref] of want) {
        const h = d.holds.get(key)
        if (h !== undefined && h.connId !== connId) {
          holder ??= h.name
          refused.push(ref)
          want.delete(key)
        }
      }
      const gone = new Set([...d.holds].filter(([key, h]) => h.connId === connId && !want.has(key)).map(([key]) => key))
      let changed = gone.size > 0 && releaseHolds(d, connId, gone)
      for (const [key, ref] of want) {
        if (d.holds.has(key)) continue
        d.holds.set(key, { ref, connId, name: user.name })
        changed = true
      }
      if (changed) broadcast(d, 'holds', { holds: holdsOf(d) })
      return holder === null ? { ok: true } : { ok: false, holder, refused }
    },

    ping: (name, connId, user) => {
      clientOf(must(name), connId, user)
    },

    sweep: () => {
      const cutoff = now() - staleMs
      const gone: { name: string; connId: string }[] = []
      for (const d of docs.values()) for (const [connId, at] of d.seen) if (at < cutoff) gone.push({ name: d.name, connId })
      for (const g of gone) api.leave(g.name, g.connId)
    },

    release: (name, connId, user, refs) => {
      const d = must(name)
      clientOf(d, connId, user)
      if (releaseHolds(d, connId, new Set(refs.map(refKey)))) broadcast(d, 'holds', { holds: holdsOf(d) })
    },

    presence: (name, connId, user, data) => {
      const d = must(name)
      clientOf(d, connId, user)
      for (const c of d.clients.values()) if (c.connId !== connId) c.send('presence', { from: connId, name: user.name, data })
    },

    flush: (name) => {
      const d = docs.get(canonKey(name))
      if (d !== undefined) flush(d)
    },
    flushAll: () => {
      for (const d of docs.values()) flush(d)
    },
    isOpen: (name) => docs.has(canonKey(name)),
    levelOf: (name) => docs.get(canonKey(name))?.level ?? null,
    status: () => [...docs.values()].map((d) => ({ name: d.name, seq: d.seq, peers: peersOf(d), holds: d.holds.size })),
  }
  return api
}

/** The refs of every ancestor of `ref` in its tree — a hold on any of them covers `ref`. */
const ancestorKeys = (level: Level, ref: NodeRef): string[] => {
  type N = { id: string; children?: N[] }
  const chain = (roots: readonly N[], id: string, trail: string[]): string[] | null => {
    for (const n of roots) {
      if (n.id === id) return trail
      const deeper = chain(n.children ?? [], id, [...trail, n.id])
      if (deeper !== null) return deeper
    }
    return null
  }
  if ('owner' in ref) {
    // The placement and its ancestors, then the prefab-side ancestors seen through the same placement.
    const above = chain(level.nodes as N[], ref.owner, []) ?? []
    const root = level.prefabs?.[level.nodes.length > 0 ? (findNode(level.nodes as N[], ref.owner) as { prefab?: string } | null)?.prefab ?? '' : ''] as N | undefined
    const inside = root === undefined ? [] : (chain(root.children ?? [], ref.node, []) ?? [])
    return [...above.map((id) => refKey({ id })), refKey({ id: ref.owner }), ...inside.map((node) => refKey({ owner: ref.owner, node }))]
  }
  if (ref.table !== undefined) {
    const root = level.prefabs?.[ref.table] as N | undefined
    const table = ref.table
    return root === undefined ? [] : (chain([root], ref.id, []) ?? []).map((id) => refKey({ table, id }))
  }
  return (chain(level.nodes as N[], ref.id, []) ?? []).map((id) => refKey({ id }))
}

const findNode = (roots: readonly { id: string; children?: unknown[] }[], id: string): unknown => {
  for (const n of roots) {
    if (n.id === id) return n
    const deeper = findNode((n.children ?? []) as { id: string; children?: unknown[] }[], id)
    if (deeper !== null && deeper !== undefined) return deeper
  }
  return null
}

/** Does the node a hold names still exist? Cheap enough: holds are few and structural ops are rare. */
const stillThere = (level: Level, ref: NodeRef): boolean => {
  const find = (roots: readonly { id: string; children?: readonly unknown[] }[], id: string): boolean =>
    roots.some((n) => n.id === id || find((n.children ?? []) as { id: string; children?: readonly unknown[] }[], id))
  if ('owner' in ref) return find(level.nodes, ref.owner)
  if (ref.table !== undefined) {
    const root = level.prefabs?.[ref.table]
    return root !== undefined && find([root], ref.id)
  }
  return find(level.nodes, ref.id)
}

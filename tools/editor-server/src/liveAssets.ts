import { applyAssetOps, LiveAssetError, validateLiveAsset, type AssetOp } from '../../../packages/content/src/liveAssets'
import type { AssetKind } from '../../../packages/content/src/assets'
import type { User } from './config'
import { LiveError } from './live'

/**
 * Data-file assets as live documents (ADR 0159) — a material now, any JSON kind with a validator later.
 *
 * The level's model, for a file with no tree in it: an edit is a batch of path ops (`@mp/content`'s
 * `liveAssets.ts`), applied in the order it arrives, numbered, and sent to **every** editor connected to any
 * room — a material shows on objects in every level, so everyone repaints it, and the sender's own copy of the
 * echo is its acknowledgement. The file is written behind, on the same debounce as a level (`idleMs` after the
 * last edit, `maxMs` at most), and on `flushAll`. No lock: two edits to one value, the last to land stays, as for
 * everything else (ADR 0158).
 *
 * A document opens on its first edit and stays open — they are small, and there are few — until its file is
 * deleted. Its `epoch` is this process's start: numbering begins again after a restart, and an editor holding
 * a number from before must not take the new ones as old.
 *
 * Pure over injected reads, writes, clock and connections, so it is tested with fakes.
 */
export interface LiveAssetsOptions {
  /** An asset's kind and content, by id, or `null` when there is no such file. */
  read: (assetId: string) => { kind: AssetKind; json: unknown } | null
  /** Write content back to the asset's file, wherever it now is. The repo-relative path, or `null` when gone. */
  write: (assetId: string, json: unknown) => string | null
  /** After a write: who edited since the last one, and the path — their sessions go dirty, the feed hears it. */
  changed: (users: User[], path: string) => void
  /** The live connection an edit arrives on, or `null` when this server has none by that id. */
  connection: (connId: string) => { user: User } | null
  /** To every editor connected to any room. */
  broadcast: (event: string, data: unknown) => void
  now?: () => number
  idleMs?: number
  maxMs?: number
  schedule?: (fn: () => void, ms: number) => () => void
}

/** What goes out on every stream for an edit. */
export interface AssetEvent {
  assetId: string
  epoch: number
  seq: number
  from: string
  batchId: string
  ops: AssetOp[]
}

export interface LiveAssets {
  /** Apply a batch from a connection. Throws `LiveError` 400 (a bad op, or one leaving the file invalid; unknown connection), 404 (no such live asset). */
  apply: (assetId: string, connId: string, user: User, batch: { batchId: string; ops: AssetOp[] }) => { ok: true; seq: number }
  /** The live copy, its number and this process's epoch, or `null` when the asset is not open. */
  current: (assetId: string) => { json: unknown; seq: number; epoch: number } | null
  /** This process's epoch: what a copy read off disk is numbered in, at `seq` 0. */
  epoch: number
  /** The file is gone: forget the document, unwritten edits and all. */
  forget: (assetId: string) => void
  flushAll: () => void
}

interface Doc {
  kind: AssetKind
  json: unknown
  seq: number
  dirtyBy: Map<string, User>
  cancelIdle: (() => void) | null
  cancelMax: (() => void) | null
}

export const createLiveAssets = (opts: LiveAssetsOptions): LiveAssets => {
  const idleMs = opts.idleMs ?? 500
  const maxMs = opts.maxMs ?? 5000
  const schedule =
    opts.schedule ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms)
      return () => clearTimeout(t)
    })
  const epoch = (opts.now ?? Date.now)()
  const docs = new Map<string, Doc>()

  const open = (assetId: string): Doc => {
    const have = docs.get(assetId)
    if (have !== undefined) return have
    const file = opts.read(assetId)
    if (file === null) throw new LiveError(404, `no asset ${assetId}`)
    if (validateLiveAsset(file.kind, file.json) === 'not a live asset kind') throw new LiveError(400, `a ${file.kind} is not edited live`)
    const d: Doc = { kind: file.kind, json: file.json, seq: 0, dirtyBy: new Map(), cancelIdle: null, cancelMax: null }
    docs.set(assetId, d)
    return d
  }

  const flush = (assetId: string, d: Doc): void => {
    d.cancelIdle?.()
    d.cancelMax?.()
    d.cancelIdle = null
    d.cancelMax = null
    if (d.dirtyBy.size === 0) return
    const path = opts.write(assetId, d.json)
    const users = [...d.dirtyBy.values()]
    d.dirtyBy.clear()
    if (path === null) {
      docs.delete(assetId)
      return
    }
    opts.changed(users, path)
  }

  return {
    epoch,
    apply: (assetId, connId, user, batch) => {
      const c = opts.connection(connId)
      if (c === null) throw new LiveError(400, 'unknown connection; reload the editor')
      if (c.user.email !== user.email) throw new LiveError(400, 'that connection is not yours')
      const d = open(assetId)
      let next: unknown
      try {
        next = applyAssetOps(d.json, batch.ops).json
      } catch (e) {
        throw new LiveError(400, e instanceof LiveAssetError ? e.message : String(e))
      }
      const why = validateLiveAsset(d.kind, next)
      if (why !== null) throw new LiveError(400, why)
      d.json = next
      d.seq++
      opts.broadcast('asset', { assetId, epoch, seq: d.seq, from: connId, batchId: batch.batchId, ops: batch.ops } satisfies AssetEvent)
      if (batch.ops.length > 0) {
        d.dirtyBy.set(user.email, user)
        d.cancelIdle?.()
        d.cancelIdle = schedule(() => flush(assetId, d), idleMs)
        d.cancelMax ??= schedule(() => flush(assetId, d), maxMs)
      }
      return { ok: true, seq: d.seq }
    },
    current: (assetId) => {
      const d = docs.get(assetId)
      return d === undefined ? null : { json: d.json, seq: d.seq, epoch }
    },
    forget: (assetId) => {
      const d = docs.get(assetId)
      if (d === undefined) return
      d.cancelIdle?.()
      d.cancelMax?.()
      docs.delete(assetId)
    },
    flushAll: () => {
      for (const [id, d] of docs) flush(id, d)
    },
  }
}

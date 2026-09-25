import { applyAssetOps, isAssetOp, type AssetOp } from '@mp/content'

/**
 * The editor's side of data-file assets edited live (ADR 0159).
 *
 * For each asset it has seen an edit to, it keeps what the server has confirmed (`base`, at `epoch` / `seq`),
 * the one batch of this tab's in flight, and this tab's edits not sent yet. What the tab shows is all three,
 * in that order — so a collaborator's edit arriving under mine lands beneath it, the server's order, the way a
 * level's unacked batches are replayed over a remote one (`collab.ts`).
 *
 * **One batch in flight per asset.** Edits made meanwhile wait, merged by path, the newest value of each, and go
 * as one batch when the echo of the last comes back: a colour drag is as many requests as round trips allow, and
 * they land in order. The echo, on this tab's own room stream, is the acknowledgement.
 *
 * A number out of step — an epoch from another process (the server restarted), or a gap — is answered by
 * fetching the live copy again.
 */

/** An `asset` event off a room stream, checked. */
export interface AssetEvent {
  assetId: string
  epoch: number
  seq: number
  from: string
  batchId: string
  ops: AssetOp[]
}

/** An `asset` event's data, or `null` when it is not one. The server's data, but checked like any wire input. */
export const parseAssetEvent = (data: unknown): AssetEvent | null => {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (typeof d.assetId !== 'string' || typeof d.epoch !== 'number' || typeof d.seq !== 'number' || typeof d.from !== 'string') return null
  if (typeof d.batchId !== 'string' || !Array.isArray(d.ops) || !d.ops.every(isAssetOp)) return null
  return { assetId: d.assetId, epoch: d.epoch, seq: d.seq, from: d.from, batchId: d.batchId, ops: d.ops }
}

/** Where a copy came from: the server process that numbered it, and how many edits it holds. `seq` 0: the file. */
export interface Origin {
  epoch: number
  seq: number
}

export interface AssetSyncHost {
  /** What the tab shows of an asset now — the library's copy. */
  shown: (assetId: string) => unknown
  /** Where the library's copy came from, when it has one. */
  origin: (assetId: string) => Origin | undefined
  /** Show a new version: the library takes it and the renderer follows. `remote` when someone else changed it. */
  show: (assetId: string, json: unknown, remote: boolean) => void
  /** The live copy from the server, and where it stands; `null` when it cannot be had. */
  fetch: (assetId: string) => Promise<{ json: unknown; origin: Origin } | null>
  /** Send a batch; `null` once the server took it, else why it refused. */
  post: (assetId: string, batch: { batchId: string; ops: AssetOp[] }) => Promise<string | null>
  /** An edit the server refused, already taken back off the screen. */
  refused: (assetId: string, why: string) => void
}

export interface AssetSync {
  /** This tab's edit: shown at once, sent behind. */
  edit: (assetId: string, ops: readonly AssetOp[]) => void
  /** An `asset` event's data off a room stream. */
  onEvent: (data: unknown) => void
  /**
   * The library was loaded again. Its copies are the server's at the time; put back on top whatever of this
   * tab's is not confirmed yet, and take a newer copy as the confirmed one.
   */
  reloaded: () => void
  /** Whether this tab has edits to it the server has not confirmed. */
  busy: (assetId: string) => boolean
}

interface Tracked {
  base: unknown
  origin: Origin
  inflight: { batchId: string; ops: AssetOp[] } | null
  pending: AssetOp[]
}

/** Newest value per path, the most recently touched last. */
const mergeOps = (into: readonly AssetOp[], add: readonly AssetOp[]): AssetOp[] => {
  const byPath = new Map<string, AssetOp>(into.map((op) => [op.path.join('\u0000'), op]))
  for (const op of add) {
    const key = op.path.join('\u0000')
    // A path inside one being replaced is part of that replacement already; drop the older, narrower edits.
    for (const k of [...byPath.keys()]) if (k.startsWith(`${key}\u0000`)) byPath.delete(k)
    byPath.delete(key)
    byPath.set(key, op)
  }
  return [...byPath.values()]
}

const newer = (a: Origin, than: Origin): boolean => a.epoch !== than.epoch || a.seq > than.seq

export const createAssetSync = (host: AssetSyncHost): AssetSync => {
  const tracked = new Map<string, Tracked>()
  /** Batch ids unique to this tab, so an echo is recognised whichever connection it went out on. */
  const tab = Math.random().toString(36).slice(2, 10)
  let nextBatch = 0

  const view = (t: Tracked): unknown => {
    let json = t.base
    if (t.inflight !== null) json = applyAssetOps(json, t.inflight.ops).json
    if (t.pending.length > 0) json = applyAssetOps(json, t.pending).json
    return json
  }

  const track = (assetId: string): Tracked => {
    let t = tracked.get(assetId)
    if (t === undefined) {
      // Unknown where it came from: `epoch` -1 matches nothing, so the first event fetches it fresh.
      t = { base: host.shown(assetId), origin: host.origin(assetId) ?? { epoch: -1, seq: 0 }, inflight: null, pending: [] }
      tracked.set(assetId, t)
    }
    return t
  }

  const pump = (assetId: string): void => {
    const t = tracked.get(assetId)
    if (t === undefined || t.inflight !== null || t.pending.length === 0) return
    const batch = { batchId: `${tab}-${(nextBatch++).toString(36)}`, ops: t.pending }
    t.inflight = batch
    t.pending = []
    void host.post(assetId, batch).then(
      (why) => {
        if (why === null) return // the echo confirms it
        if (t.inflight?.batchId !== batch.batchId) return
        t.inflight = null
        host.show(assetId, view(t), false)
        host.refused(assetId, why)
        pump(assetId)
      },
      (e: unknown) => {
        if (t.inflight?.batchId !== batch.batchId) return
        t.inflight = null
        host.show(assetId, view(t), false)
        host.refused(assetId, e instanceof Error ? e.message : String(e))
        pump(assetId)
      },
    )
  }

  const refetch = async (assetId: string): Promise<void> => {
    const fresh = await host.fetch(assetId).catch(() => null)
    const t = tracked.get(assetId)
    if (fresh === null || t === undefined) return
    t.base = fresh.json
    t.origin = fresh.origin
    host.show(assetId, view(t), true)
  }

  return {
    edit: (assetId, ops) => {
      if (ops.length === 0) return
      const t = track(assetId)
      t.pending = mergeOps(t.pending, ops)
      host.show(assetId, view(t), false)
      pump(assetId)
    },
    onEvent: (data) => {
      const e = parseAssetEvent(data)
      if (e === null) return
      const t = track(e.assetId)
      if (e.epoch !== t.origin.epoch || e.seq > t.origin.seq + 1) {
        // Out of step: this copy is not the one the numbers follow. The live copy has every edit up to now.
        if (t.inflight?.batchId === e.batchId) t.inflight = null
        void refetch(e.assetId)
        pump(e.assetId)
        return
      }
      if (e.seq <= t.origin.seq) return // in the copy already
      try {
        t.base = applyAssetOps(t.base, e.ops).json
      } catch {
        void refetch(e.assetId)
        return
      }
      t.origin = { epoch: e.epoch, seq: e.seq }
      if (t.inflight?.batchId === e.batchId) {
        // Mine, confirmed: nothing on screen changes, and the next can go.
        t.inflight = null
        pump(e.assetId)
        return
      }
      host.show(e.assetId, view(t), true)
    },
    reloaded: () => {
      for (const [assetId, t] of tracked) {
        const origin = host.origin(assetId)
        if (origin !== undefined && newer(origin, t.origin)) {
          t.base = host.shown(assetId)
          t.origin = origin
        }
        if (t.inflight !== null || t.pending.length > 0) host.show(assetId, view(t), false)
      }
    },
    busy: (assetId) => {
      const t = tracked.get(assetId)
      return t !== undefined && (t.inflight !== null || t.pending.length > 0)
    },
  }
}

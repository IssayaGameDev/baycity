import type { Snapshot, SnapshotEntity } from '@mp/net'

import { interpolateAt } from './interpolation'

export interface SnapshotClientOptions {
  /**
   * Interpolation buffer duration (ms): how far in the past remote entities are
   * rendered. DESIGN slider (game feel) — placeholder pending Kodjo, best chosen
   * at M4 when netsim makes it measurable under jitter/loss. See docs/netcode.md.
   */
  interpolationDelayMs: number
  /** Drop buffered snapshots older than this many ms behind the newest. */
  maxBufferMs?: number
  /** Injectable clock (ms). Defaults to `performance.now`. */
  now?: () => number
}

export interface SnapshotClient {
  ingest: (snapshot: Snapshot) => void
  /** Interpolated entity positions for the current render moment. */
  sample: () => SnapshotEntity[]
  bufferedCount: () => number
}

/**
 * Buffers incoming snapshots and samples an interpolated view delayed by
 * `interpolationDelayMs`. Pre-clock-sync (M2), it estimates "server now" by
 * extrapolating the newest snapshot's server time with locally-elapsed time;
 * real clock sync replaces this in M5.
 */
export const createSnapshotClient = (opts: SnapshotClientOptions): SnapshotClient => {
  const now = opts.now ?? (() => performance.now())
  const maxBufferMs = opts.maxBufferMs ?? 1000
  const buffer: Snapshot[] = []
  let lastServerTimeMs = 0
  let lastArrivalLocalMs = 0
  let hasBaseline = false

  const renderServerTime = (): number =>
    lastServerTimeMs + (now() - lastArrivalLocalMs) - opts.interpolationDelayMs

  return {
    ingest: (snapshot) => {
      const newest = buffer[buffer.length - 1]
      if (newest === undefined || snapshot.serverTimeMs >= newest.serverTimeMs) {
        buffer.push(snapshot)
      } else {
        const idx = buffer.findIndex((s) => s.serverTimeMs > snapshot.serverTimeMs)
        buffer.splice(idx, 0, snapshot)
      }
      lastServerTimeMs = buffer[buffer.length - 1]!.serverTimeMs
      lastArrivalLocalMs = now()
      hasBaseline = true

      const cutoff = lastServerTimeMs - maxBufferMs
      while (buffer.length > 2 && buffer[0]!.serverTimeMs < cutoff) buffer.shift()
    },
    sample: () => (hasBaseline ? interpolateAt(buffer, renderServerTime()) : []),
    bufferedCount: () => buffer.length,
  }
}

import type { Snapshot, SnapshotEntity } from '@mp/net'

import { interpolateAt } from './interpolation'

export interface SnapshotClientOptions {
  /**
   * Interpolation buffer duration (ms): how far in the past remote entities are
   * rendered. DESIGN slider (game feel); 100 ms provisional (Kodjo), tunable at
   * runtime. See docs/platform/netcode.md.
   */
  interpolationDelayMs: number
  /** Drop buffered snapshots older than this many ms behind the newest. */
  maxBufferMs?: number
  /**
   * How strongly each snapshot nudges the internal render clock (0..1, per
   * snapshot). Small = smoother (absorbs arrival jitter) but tracks drift slower.
   * Ignored when `serverNow` is supplied.
   */
  clockTracking?: number
  /**
   * Synced "server now" (ms), e.g. from `createClockSync`. When provided, playback
   * uses it (real clock sync, M5) instead of the interim snapshot-derived estimate.
   */
  serverNow?: () => number
  /** Injectable clock (ms). Defaults to `performance.now`. */
  now?: () => number
}

export interface SnapshotClient {
  ingest: (snapshot: Snapshot) => void
  /** Interpolated entity positions for the current render moment. Pure — safe to
   * call multiple times per frame (the render clock only advances on `ingest`). */
  sample: () => SnapshotEntity[]
  /** Adjust the interpolation buffer duration at runtime (design tuning). */
  setInterpolationDelayMs: (ms: number) => void
  bufferedCount: () => number
}

/**
 * Buffers snapshots and samples an interpolated view delayed by
 * `interpolationDelayMs`. Pre-clock-sync (M4), it keeps a free-running estimate of
 * `serverTime - localTime` that advances with real time and is *gently* corrected
 * by each snapshot — so arrival jitter doesn't stutter playback. Real clock sync
 * replaces this in M5.
 */
export const createSnapshotClient = (opts: SnapshotClientOptions): SnapshotClient => {
  const now = opts.now ?? (() => performance.now())
  const maxBufferMs = opts.maxBufferMs ?? 1000
  const tracking = opts.clockTracking ?? 0.1
  let delayMs = opts.interpolationDelayMs
  const buffer: Snapshot[] = []
  let clockOffset = 0 // estimate of serverTimeMs - localMs
  let hasBaseline = false

  return {
    ingest: (snapshot) => {
      const newest = buffer[buffer.length - 1]
      if (newest === undefined || snapshot.serverTimeMs >= newest.serverTimeMs) {
        buffer.push(snapshot)
      } else {
        const idx = buffer.findIndex((s) => s.serverTimeMs > snapshot.serverTimeMs)
        buffer.splice(idx, 0, snapshot)
      }

      const newestTimeMs = buffer[buffer.length - 1]!.serverTimeMs
      const targetOffset = newestTimeMs - now()
      if (!hasBaseline) {
        clockOffset = targetOffset
        hasBaseline = true
      } else {
        clockOffset += (targetOffset - clockOffset) * tracking
      }

      const cutoff = newestTimeMs - maxBufferMs
      while (buffer.length > 2 && buffer[0]!.serverTimeMs < cutoff) buffer.shift()
    },
    sample: () => {
      if (opts.serverNow) {
        if (buffer.length === 0) return []
        return interpolateAt(buffer, opts.serverNow() - delayMs)
      }
      if (!hasBaseline) return []
      return interpolateAt(buffer, now() + clockOffset - delayMs)
    },
    setInterpolationDelayMs: (ms) => {
      delayMs = ms
    },
    bufferedCount: () => buffer.length,
  }
}

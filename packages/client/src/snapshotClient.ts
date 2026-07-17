import type { Snapshot, SnapshotEntity } from '@mp/net'

import { interpolateAt } from './interpolation'

export interface SnapshotClientOptions {
  /**
   * Interpolation buffer duration (ms): how far in the past remote entities are
   * rendered. DESIGN slider (game feel); 100 ms provisional (Kodjo), tunable at
   * runtime. See docs/netcode.md.
   */
  interpolationDelayMs: number
  /** Drop buffered snapshots older than this many ms behind the newest. */
  maxBufferMs?: number
  /**
   * How strongly each snapshot nudges the render clock (0..1, per snapshot).
   * Small = smoother (absorbs arrival jitter) but tracks drift slower.
   */
  clockTracking?: number
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
      if (!hasBaseline) return []
      const renderServerTimeMs = now() + clockOffset - delayMs
      return interpolateAt(buffer, renderServerTimeMs)
    },
    setInterpolationDelayMs: (ms) => {
      delayMs = ms
    },
    bufferedCount: () => buffer.length,
  }
}

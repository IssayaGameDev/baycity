/**
 * Client↔server clock sync from ping/pong round-trips (SEED §3). Estimates the
 * offset between the local clock and the server clock (and the RTT), so the
 * client can compute "server now" — needed to render remote peers on a stable
 * timeline (client-authoritative, ADR 0011; its former lag-comp use is retired).
 */
export interface ClockSyncOptions {
  now?: () => number
  /** EMA factor for offset/RTT (0..1). Small = stable, tracks drift slowly. */
  smoothing?: number
}

export interface ClockSync {
  /** Record a completed round-trip: when we sent the ping, the server time it
   * reported, and when we received the pong (all ms, local clock for send/recv). */
  recordSample: (clientSendMs: number, serverTimeMs: number, clientRecvMs: number) => void
  /** Estimated current server time (ms). Equals local time until the first sample. */
  serverNow: () => number
  /** Smoothed round-trip time (ms). */
  rttMs: () => number
  ready: () => boolean
}

export const createClockSync = (opts: ClockSyncOptions = {}): ClockSync => {
  const now = opts.now ?? (() => performance.now())
  const smoothing = opts.smoothing ?? 0.1
  let offset = 0 // serverTime - localTime
  let rtt = 0
  let has = false

  return {
    recordSample: (clientSendMs, serverTimeMs, clientRecvMs) => {
      const sampleRtt = Math.max(0, clientRecvMs - clientSendMs)
      // The server's timestamp corresponds to ~the round-trip midpoint in local time.
      const sampleOffset = serverTimeMs - (clientSendMs + sampleRtt / 2)
      if (!has) {
        offset = sampleOffset
        rtt = sampleRtt
        has = true
      } else {
        offset += (sampleOffset - offset) * smoothing
        rtt += (sampleRtt - rtt) * smoothing
      }
    },
    serverNow: () => now() + offset,
    rttMs: () => rtt,
    ready: () => has,
  }
}

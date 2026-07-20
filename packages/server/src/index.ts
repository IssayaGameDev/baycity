import { startFixedLoop, type LoopHandle } from '@mp/core'

import { createRoom } from './room'
import { TICK_RATE_HZ } from './tps'
import { createUwsServerTransport, type UwsServerTransport } from './transport-uws'

/**
 * @mp/server — client-authoritative relay host (ADR 0011): rooms, fixed tick,
 * per-client snapshot construction. It owns no simulation — clients send their own
 * state and the server relays peers'. Headless, no rendering imports (SEED §6, law 2).
 */
export const SERVER_VERSION = '0.0.0' as const

export const DEFAULT_PORT = 9200
export { TICK_RATE_HZ }
export const SNAPSHOT_RATE_HZ = 20 // SEED §2: 15–20 Hz; upper end within the locked range

/** Tick-time stats for budget 3 (snapshot build < 33 ms/room; no physics anymore). */
export interface ServerStats {
  ticks: number
  tickAvgMs: number
  tickMaxMs: number
}

export interface ServerHandle {
  readonly port: number
  stats: () => ServerStats
  stop: () => Promise<void>
}

/** Starts the relay server. No side effects at import; call to run. */
export const startServer = async (opts: { port?: number } = {}): Promise<ServerHandle> => {
  const port = opts.port ?? DEFAULT_PORT
  const transport: UwsServerTransport = await createUwsServerTransport({ port })
  const room = createRoom()

  transport.onConnection((conn) => room.addConnection(conn))

  const snapshotIntervalMs = 1000 / SNAPSHOT_RATE_HZ
  let sinceSnapshotMs = 0
  let ticks = 0
  let tickSumMs = 0
  let tickMaxMs = 0

  const loop: LoopHandle = startFixedLoop({
    tickRateHz: TICK_RATE_HZ,
    onTick: (dtSeconds) => {
      const t0 = performance.now()
      room.step(dtSeconds)
      sinceSnapshotMs += dtSeconds * 1000
      if (sinceSnapshotMs >= snapshotIntervalMs) {
        sinceSnapshotMs -= snapshotIntervalMs
        room.sendSnapshots()
      }
      const dur = performance.now() - t0
      ticks += 1
      tickSumMs += dur
      if (dur > tickMaxMs) tickMaxMs = dur
    },
  })

  return {
    port,
    stats: () => ({ ticks, tickAvgMs: ticks > 0 ? tickSumMs / ticks : 0, tickMaxMs }),
    stop: async () => {
      loop.stop()
      transport.close()
    },
  }
}

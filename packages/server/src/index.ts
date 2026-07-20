import { Server } from 'colyseus'

import { getRoomStats, resetRoomStats, SNAPSHOT_RATE_HZ, TpsRoom } from './rooms'
import { TICK_RATE_HZ } from './tps'

/**
 * @mp/server — client-authoritative multiplayer host (ADR 0011/0013). Colyseus owns
 * the transport, room lifecycle, matchmaking and the scale-out path; each room relays
 * peers' state (no simulation, no `@colyseus/schema`). Uses Colyseus's default `ws`
 * transport; the uWebSockets transport is a later perf swap. Headless, no rendering
 * imports (SEED §6, law 2).
 */
export const SERVER_VERSION = '0.0.0' as const

export const DEFAULT_PORT = 9200
export { TICK_RATE_HZ, SNAPSHOT_RATE_HZ }

/** Tick-time stats for budget 3 (snapshot relay < 33 ms/room), aggregated across the
 * process's rooms. */
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

/** Starts the game server. No side effects at import; call to run. Defines the `tps`
 * room; clients reach it via matchmaking (`joinOrCreate('tps')`). */
export const startServer = async (opts: { port?: number } = {}): Promise<ServerHandle> => {
  const port = opts.port ?? DEFAULT_PORT
  resetRoomStats()
  const gameServer = new Server() // default ws transport
  gameServer.define('tps', TpsRoom)
  await gameServer.listen(port)

  return {
    port,
    stats: () => getRoomStats(),
    stop: async () => {
      await gameServer.gracefullyShutdown(false)
    },
  }
}

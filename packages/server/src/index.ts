import { Server } from 'colyseus'

import { getRoomStats, ParkourRoom, resetRoomStats, SNAPSHOT_RATE_HZ } from './rooms'

/**
 * @mp/server — client-authoritative multiplayer host (ADR 0011/0013). Colyseus owns
 * the transport, room lifecycle, matchmaking and the scale-out path; each room relays
 * peers' state (no simulation, no `@colyseus/schema`). Uses Colyseus's default `ws`
 * transport; the uWebSockets transport is a later perf swap. Headless, no rendering
 * imports (SEED §6, law 2).
 */
export const SERVER_VERSION = '0.0.0' as const

export const DEFAULT_PORT = 9200
export { SNAPSHOT_RATE_HZ }

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
 * room; clients reach it via matchmaking (`joinOrCreate('parkour')`). */
export const startServer = async (opts: { port?: number } = {}): Promise<ServerHandle> => {
  const port = opts.port ?? DEFAULT_PORT
  resetRoomStats()
  const gameServer = new Server() // default ws transport
  // Filtered by `level`: matchmaking only ever puts a client into a room whose creator passed the same
  // level name. The server still loads no content (ADR 0013) — it never learns what a level *is*, only
  // that two clients claiming different ones must not share a room, because geometry and the
  // movement-base index a rider replicates (ADR 0021) are both positional and would disagree.
  gameServer.define('parkour', ParkourRoom).filterBy(['level'])
  await gameServer.listen(port)

  return {
    port,
    stats: () => getRoomStats(),
    stop: async () => {
      await gameServer.gracefullyShutdown(false)
    },
  }
}

import { Server } from 'colyseus'

import { getRoomStats, GameRoom, resetRoomStats, SNAPSHOT_RATE_HZ } from './rooms'

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

/**
 * Starts the game server. No side effects at import; call to run.
 *
 * Defines **one** room type, `game`, for every game on the platform; clients reach it via matchmaking
 * (`joinOrCreate('game', { game, level })`).
 */
export const startServer = async (opts: { port?: number } = {}): Promise<ServerHandle> => {
  const port = opts.port ?? DEFAULT_PORT
  resetRoomStats()
  const gameServer = new Server() // default ws transport
  /**
   * Filtered by `game` **and** `level`: matchmaking only ever puts a client into a room whose creator passed
   * the same pair. The server still loads no content (ADR 0013) — it never learns what a game or a level *is*,
   * only that two clients claiming different ones must not share a room.
   *
   * `level` because geometry and the movement-base index a rider replicates (ADR 0021) are both positional and
   * would disagree. `game` because two games may have **different character controllers** (ADR 0052), so
   * peers would be replicated under the wrong locomotion assumptions — and because a room name per game would
   * mean this file importing every game, which is the dependency direction the server exists outside of.
   */
  gameServer.define('game', GameRoom).filterBy(['game', 'level'])
  await gameServer.listen(port)

  return {
    port,
    stats: () => getRoomStats(),
    stop: async () => {
      await gameServer.gracefullyShutdown(false)
    },
  }
}

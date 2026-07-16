import { startFixedLoop, type Connection, type LoopHandle } from '@mp/core'
import { encodeSnapshot } from '@mp/net'

import { createUwsServerTransport, type UwsServerTransport } from './transport-uws'
import { createSphereWorld } from './world'

/**
 * @mp/server — authoritative simulation host: rooms, fixed tick, per-client
 * snapshot construction, rewind ring buffer. Headless, no rendering imports
 * (SEED §6, law 2).
 */
export const SERVER_VERSION = '0.0.0' as const

export const DEFAULT_PORT = 9200
export const TICK_RATE_HZ = 30 // SEED §2 (locked starting point)
export const SNAPSHOT_RATE_HZ = 20 // SEED §2: 15–20 Hz; upper end within the locked range

export interface ServerHandle {
  readonly port: number
  stop: () => Promise<void>
}

/** Starts the walking-skeleton server. No side effects at import; call to run. */
export const startServer = async (opts: { port?: number } = {}): Promise<ServerHandle> => {
  const port = opts.port ?? DEFAULT_PORT
  const transport: UwsServerTransport = await createUwsServerTransport({ port })
  const world = createSphereWorld()
  const connections = new Set<Connection>()

  transport.onConnection((conn) => {
    connections.add(conn)
    conn.onClose(() => connections.delete(conn))
  })

  const snapshotIntervalMs = 1000 / SNAPSHOT_RATE_HZ
  let simTimeMs = 0
  let sinceSnapshotMs = 0

  const loop: LoopHandle = startFixedLoop({
    tickRateHz: TICK_RATE_HZ,
    onTick: (dtSeconds) => {
      const dtMs = dtSeconds * 1000
      simTimeMs += dtMs
      world.update(simTimeMs)

      sinceSnapshotMs += dtMs
      if (sinceSnapshotMs >= snapshotIntervalMs) {
        sinceSnapshotMs -= snapshotIntervalMs
        for (const conn of connections) {
          conn.send(encodeSnapshot(world.snapshotFor(conn.id, simTimeMs)))
        }
      }
    },
  })

  return {
    port,
    stop: async () => {
      loop.stop()
      transport.close()
    },
  }
}

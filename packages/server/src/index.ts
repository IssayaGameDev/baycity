import { startFixedLoop, type LoopHandle } from '@mp/core'
import { initPhysics } from '@mp/physics'

import { createRoom } from './room'
import { TICK_RATE_HZ } from './sim'
import { createUwsServerTransport, type UwsServerTransport } from './transport-uws'

/**
 * @mp/server — authoritative simulation host: rooms, fixed tick, per-client
 * snapshot construction, rewind ring buffer. Headless, no rendering imports
 * (SEED §6, law 2).
 */
export const SERVER_VERSION = '0.0.0' as const

export const DEFAULT_PORT = 9200
export { TICK_RATE_HZ }
export const SNAPSHOT_RATE_HZ = 20 // SEED §2: 15–20 Hz; upper end within the locked range

export interface ServerHandle {
  readonly port: number
  stop: () => Promise<void>
}

/** Starts the game server. No side effects at import; call to run. */
export const startServer = async (opts: { port?: number } = {}): Promise<ServerHandle> => {
  const port = opts.port ?? DEFAULT_PORT
  await initPhysics()
  const transport: UwsServerTransport = await createUwsServerTransport({ port })
  const room = createRoom()

  transport.onConnection((conn) => room.addConnection(conn))

  const snapshotIntervalMs = 1000 / SNAPSHOT_RATE_HZ
  let simTimeMs = 0
  let sinceSnapshotMs = 0

  const loop: LoopHandle = startFixedLoop({
    tickRateHz: TICK_RATE_HZ,
    onTick: (dtSeconds) => {
      simTimeMs += dtSeconds * 1000
      room.step(dtSeconds)

      sinceSnapshotMs += dtSeconds * 1000
      if (sinceSnapshotMs >= snapshotIntervalMs) {
        sinceSnapshotMs -= snapshotIntervalMs
        room.sendSnapshots(simTimeMs)
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

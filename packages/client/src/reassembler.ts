import type { EntityId } from '@mp/core'
import type { Snapshot, SnapshotEntity, SnapshotMessage } from '@mp/net'

/**
 * Reconstructs full snapshots from the wire's full/delta messages. Relies on the
 * reliable, ordered transport (WebSocket): a delta always applies to the message
 * before it. A UDP transport would need ack-based baselines instead.
 */
export interface SnapshotReassembler {
  apply: (msg: SnapshotMessage) => Snapshot
}

export const createSnapshotReassembler = (): SnapshotReassembler => {
  // Keeps whole entities, not just positions: the flags, facing and speed (v8/v9) travel with them,
  // and an entity the delta skipped has to retain everything it was last sent.
  const state = new Map<EntityId, SnapshotEntity>()
  return {
    apply: (msg) => {
      if (msg.isFull) state.clear()
      for (const e of msg.changed) state.set(e.id, e)
      for (const id of msg.removed) state.delete(id)
      return {
        serverTimeMs: msg.serverTimeMs,
        entities: [...state.values()].map((e) => ({
          id: e.id,
          position: e.position,
          flags: e.flags,
          yaw: e.yaw,
          speed: e.speed,
          base: e.base,
        })),
      }
    },
  }
}

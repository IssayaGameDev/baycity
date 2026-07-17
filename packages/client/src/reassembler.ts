import type { EntityId, Vec3 } from '@mp/core'
import type { Snapshot, SnapshotMessage } from '@mp/net'

/**
 * Reconstructs full snapshots from the wire's full/delta messages. Relies on the
 * reliable, ordered transport (WebSocket): a delta always applies to the message
 * before it. A UDP transport would need ack-based baselines instead.
 */
export interface SnapshotReassembler {
  apply: (msg: SnapshotMessage) => Snapshot
}

export const createSnapshotReassembler = (): SnapshotReassembler => {
  const state = new Map<EntityId, Vec3>()
  return {
    apply: (msg) => {
      if (msg.isFull) state.clear()
      for (const e of msg.changed) state.set(e.id, e.position)
      for (const id of msg.removed) state.delete(id)
      return {
        serverTimeMs: msg.serverTimeMs,
        lastProcessedInputSeq: msg.lastProcessedInputSeq,
        entities: [...state].map(([id, position]) => ({ id, position })),
      }
    },
  }
}

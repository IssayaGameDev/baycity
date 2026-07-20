import { entityId, type Connection, type EntityId, type Vec3 } from '@mp/core'
import {
  decodePing,
  decodeState,
  encodePong,
  encodeSnapshot,
  encodeWelcome,
  MSG_PING,
  MSG_STATE,
  quantizeAxis,
  readMessageType,
  type SnapshotEntity,
  type SnapshotMessage,
} from '@mp/net'

const FIRST_PLAYER_ID = 1000

interface Player {
  readonly conn: Connection
  readonly id: EntityId
  latest: Vec3 | null // last position this client reported (it owns its own body)
  sentFull: boolean
  baseline: Map<EntityId, Vec3> // last positions sent to this client (for delta)
}

// Relay an entity only when its quantized position actually changes.
const quantizedDiffers = (a: Vec3, b: Vec3): boolean =>
  quantizeAxis(a.x) !== quantizeAxis(b.x) ||
  quantizeAxis(a.y) !== quantizeAxis(b.y) ||
  quantizeAxis(a.z) !== quantizeAxis(b.z)

export interface Room {
  addConnection: (conn: Connection) => void
  /** Advance the snapshot clock (no simulation — clients own their own state). */
  step: (dtSeconds: number) => void
  sendSnapshots: () => void
}

/**
 * Client-authoritative room (ADR 0011): the server owns no simulation. Each client
 * simulates its own entity and sends its position (STATE); the server stores the
 * latest and relays peers' positions as per-client delta snapshots on its own
 * clock-synced timeline. It also assigns ids and answers clock-sync pings.
 */
export const createRoom = (): Room => {
  const players = new Map<Connection, Player>()
  let nextPlayerId = FIRST_PLAYER_ID
  let serverTimeMs = 0

  return {
    addConnection: (conn) => {
      const id = entityId(nextPlayerId++)
      const player: Player = { conn, id, latest: null, sentFull: false, baseline: new Map() }
      players.set(conn, player)
      conn.send(encodeWelcome({ playerId: id }))

      conn.onMessage((data) => {
        // Every message self-describes its version; decoders reject a mismatch.
        // Guard so a malformed/wrong-version frame can't crash the room.
        try {
          switch (readMessageType(data)) {
            case MSG_STATE:
              player.latest = decodeState(data)
              break
            case MSG_PING:
              conn.send(encodePong({ clientTimeMs: decodePing(data).clientTimeMs, serverTimeMs }))
              break
          }
        } catch {
          // ignore (schema-version mismatch or corrupt frame)
        }
      })
      conn.onClose(() => {
        players.delete(conn)
      })
    },

    step: (dtSeconds) => {
      serverTimeMs += dtSeconds * 1000
    },

    sendSnapshots: () => {
      const time = serverTimeMs >>> 0
      for (const player of players.values()) {
        // Peers only: a client is authoritative for its own body, so never relay
        // its own position back to it.
        const peers: SnapshotEntity[] = []
        for (const other of players.values()) {
          if (other === player || other.latest === null) continue
          peers.push({ id: other.id, position: other.latest })
        }
        player.conn.send(encodeSnapshot(snapshotFor(player, peers, time)))
      }
    },
  }
}

/** A full snapshot on first send, then per-client deltas vs the last positions sent. */
const snapshotFor = (player: Player, peers: SnapshotEntity[], time: number): SnapshotMessage => {
  if (!player.sentFull) {
    player.sentFull = true
    player.baseline = new Map(peers.map((e) => [e.id, e.position]))
    return { isFull: true, serverTimeMs: time, changed: peers, removed: [] }
  }
  const changed: SnapshotEntity[] = []
  const present = new Set<EntityId>()
  for (const e of peers) {
    present.add(e.id)
    const base = player.baseline.get(e.id)
    if (base === undefined || quantizedDiffers(base, e.position)) changed.push(e)
  }
  const removed: EntityId[] = []
  for (const id of player.baseline.keys()) if (!present.has(id)) removed.push(id)
  player.baseline = new Map(peers.map((e) => [e.id, e.position]))
  return { isFull: false, serverTimeMs: time, changed, removed }
}

import { entityId, type Connection, type EntityId, type Vec3 } from '@mp/core'
import {
  decodeFire,
  decodeInput,
  decodePing,
  encodeHit,
  encodePong,
  encodeSnapshot,
  encodeWelcome,
  MSG_FIRE,
  MSG_INPUT,
  MSG_PING,
  quantizeAxis,
  readMessageType,
  type InputCommand,
  type SnapshotEntity,
  type SnapshotMessage,
} from '@mp/net'

import { createRewindBuffer, hitScan } from './rewind'

const MAX_INPUT_QUEUE = 6 // bound buffered latency; drop oldest beyond this
const REWIND_MS = 1000 // history kept + max honored rewind window (SEED §3)
const FIRST_PLAYER_ID = 1000 // props (if any) use lower ids

/** One player's simulation, owned by a game. */
export interface PlayerSim {
  applyInput: (cmd: InputCommand) => void
  remove: () => void
}

/**
 * A game the room hosts: it owns the physics world, players, and props; the room
 * owns the generic netcode (connections, input queues, per-client delta snapshots,
 * ping/pong, lag-comp rewind). This is the seam that lets the server run different
 * games (ball demo, TPS) without duplicating the netcode.
 */
export interface GameSim {
  addPlayer: (id: EntityId) => PlayerSim
  step: (dtSeconds: number) => void
  /** All replicated entities (players + props) for snapshots. */
  entities: () => SnapshotEntity[]
  /** Positions recorded for lag-comp rewind (the hittable players). */
  hittablePositions: () => Map<EntityId, Vec3>
  /** Collider radius used for hit tests. */
  hitRadius: number
}

interface Player {
  readonly conn: Connection
  readonly id: EntityId
  readonly sim: PlayerSim
  queue: InputCommand[]
  lastProcessedSeq: number
  sentFull: boolean
  baseline: Map<EntityId, Vec3> // last positions sent to this client (for delta)
}

const ZERO_INPUT = (seq: number): InputCommand => ({ seq, moveX: 0, moveZ: 0, jump: false })

// Send an entity only when its quantized position actually changes.
const quantizedDiffers = (a: Vec3, b: Vec3): boolean =>
  quantizeAxis(a.x) !== quantizeAxis(b.x) ||
  quantizeAxis(a.y) !== quantizeAxis(b.y) ||
  quantizeAxis(a.z) !== quantizeAxis(b.z)

export interface Room {
  addConnection: (conn: Connection) => void
  step: (dtSeconds: number) => void
  sendSnapshots: () => void
}

export const createRoom = (game: GameSim): Room => {
  const players = new Map<Connection, Player>()
  const rewind = createRewindBuffer(REWIND_MS)
  let nextPlayerId = FIRST_PLAYER_ID
  let serverTimeMs = 0

  const broadcast = (data: ArrayBuffer): void => {
    for (const player of players.values()) player.conn.send(data)
  }

  const handleFire = (shooter: Player, data: ArrayBuffer): void => {
    const fire = decodeFire(data)
    const t = Math.max(serverTimeMs - REWIND_MS, Math.min(serverTimeMs, fire.fireTimeMs))
    const targetId = hitScan(rewind.positionsAt(t), fire.origin, fire.direction, game.hitRadius, shooter.id)
    if (targetId !== null) broadcast(encodeHit({ shooterId: shooter.id, targetId }))
  }

  return {
    addConnection: (conn) => {
      const id = entityId(nextPlayerId++)
      const player: Player = {
        conn,
        id,
        sim: game.addPlayer(id),
        queue: [],
        lastProcessedSeq: 0,
        sentFull: false,
        baseline: new Map(),
      }
      players.set(conn, player)
      conn.send(encodeWelcome({ playerId: id }))

      conn.onMessage((data) => {
        // Every message self-describes its version; decoders reject a mismatch.
        // Guard so a malformed/wrong-version frame can't crash the room.
        try {
          switch (readMessageType(data)) {
            case MSG_INPUT:
              player.queue.push(decodeInput(data))
              if (player.queue.length > MAX_INPUT_QUEUE) player.queue.shift()
              break
            case MSG_PING:
              conn.send(encodePong({ clientTimeMs: decodePing(data).clientTimeMs, serverTimeMs }))
              break
            case MSG_FIRE:
              handleFire(player, data)
              break
          }
        } catch {
          // ignore (schema-version mismatch or corrupt frame)
        }
      })
      conn.onClose(() => {
        player.sim.remove()
        players.delete(conn)
      })
    },

    step: (dtSeconds) => {
      for (const player of players.values()) {
        const cmd = player.queue.shift()
        if (cmd) {
          player.sim.applyInput(cmd)
          player.lastProcessedSeq = cmd.seq
        } else {
          player.sim.applyInput(ZERO_INPUT(player.lastProcessedSeq))
        }
      }
      game.step(dtSeconds)
      serverTimeMs += dtSeconds * 1000
      rewind.record(serverTimeMs, game.hittablePositions())
    },

    sendSnapshots: () => {
      const entities = game.entities()
      const time = serverTimeMs >>> 0
      for (const player of players.values()) {
        player.conn.send(encodeSnapshot(snapshotFor(player, entities, time)))
      }
    },
  }
}

/** A full snapshot on first send, then per-client deltas vs the last positions sent. */
const snapshotFor = (player: Player, entities: SnapshotEntity[], time: number): SnapshotMessage => {
  const lastProcessedInputSeq = player.lastProcessedSeq
  if (!player.sentFull) {
    player.sentFull = true
    player.baseline = new Map(entities.map((e) => [e.id, e.position]))
    return { isFull: true, serverTimeMs: time, lastProcessedInputSeq, changed: entities, removed: [] }
  }
  const changed: SnapshotEntity[] = []
  const present = new Set<EntityId>()
  for (const e of entities) {
    present.add(e.id)
    const base = player.baseline.get(e.id)
    if (base === undefined || quantizedDiffers(base, e.position)) changed.push(e)
  }
  const removed: EntityId[] = []
  for (const id of player.baseline.keys()) if (!present.has(id)) removed.push(id)
  player.baseline = new Map(entities.map((e) => [e.id, e.position]))
  return { isFull: false, serverTimeMs: time, lastProcessedInputSeq, changed, removed }
}

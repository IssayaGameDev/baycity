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
import { createPhysicsWorld, type PhysicsBody } from '@mp/physics'

import { createRewindBuffer, hitScan } from './rewind'
import {
  addBalls,
  addGround,
  addPlayerBody,
  applyPlayerInput,
  FIRST_PLAYER_ID,
  GRAVITY,
  PLAYER_RADIUS,
  playerSpawn,
  type Ball,
} from './sim'

const MAX_INPUT_QUEUE = 6 // bound buffered latency; drop oldest beyond this
const REWIND_MS = 1000 // history kept + max honored rewind window (SEED §3)

interface Player {
  readonly conn: Connection
  readonly id: EntityId
  readonly body: PhysicsBody
  queue: InputCommand[]
  lastProcessedSeq: number
  sentFull: boolean
  baseline: Map<EntityId, Vec3> // last positions sent to this client (for delta)
}

const ZERO_INPUT = (seq: number): InputCommand => ({ seq, moveX: 0, moveZ: 0 })

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

export const createRoom = (): Room => {
  const world = createPhysicsWorld({ gravity: GRAVITY })
  addGround(world)
  const balls: Ball[] = addBalls(world)

  const players = new Map<Connection, Player>()
  const rewind = createRewindBuffer(REWIND_MS)
  let nextPlayerId = FIRST_PLAYER_ID
  let serverTimeMs = 0

  const broadcast = (data: ArrayBuffer): void => {
    for (const player of players.values()) player.conn.send(data)
  }

  const handleFire = (shooter: Player, data: ArrayBuffer): void => {
    const fire = decodeFire(data)
    // Clamp the claimed time to the honored rewind window, then rewind and test.
    const t = Math.max(serverTimeMs - REWIND_MS, Math.min(serverTimeMs, fire.fireTimeMs))
    const targetId = hitScan(rewind.positionsAt(t), fire.origin, fire.direction, PLAYER_RADIUS, shooter.id)
    if (targetId !== null) broadcast(encodeHit({ shooterId: shooter.id, targetId }))
  }

  return {
    addConnection: (conn) => {
      const id = entityId(nextPlayerId++)
      const player: Player = {
        conn,
        id,
        body: addPlayerBody(world, playerSpawn(id)),
        queue: [],
        lastProcessedSeq: 0,
        sentFull: false,
        baseline: new Map(),
      }
      players.set(conn, player)
      conn.send(encodeWelcome({ playerId: id }))

      conn.onMessage((data) => {
        // Every message self-describes its protocol version; the decoders reject a
        // mismatch. Guard so a malformed/wrong-version message can't crash the room.
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
        player.body.remove()
        players.delete(conn)
      })
    },

    step: (dtSeconds) => {
      for (const player of players.values()) {
        const cmd = player.queue.shift()
        if (cmd) {
          applyPlayerInput(player.body, cmd)
          player.lastProcessedSeq = cmd.seq
        } else {
          applyPlayerInput(player.body, ZERO_INPUT(player.lastProcessedSeq))
        }
      }
      world.step(dtSeconds)
      serverTimeMs += dtSeconds * 1000

      // Record player colliders for lag compensation (SEED §3).
      const snapshotPositions = new Map<EntityId, Vec3>()
      for (const player of players.values()) snapshotPositions.set(player.id, player.body.translation())
      rewind.record(serverTimeMs, snapshotPositions)
    },

    sendSnapshots: () => {
      const entities: SnapshotEntity[] = [
        ...balls.map((b) => ({ id: b.id, position: b.body.translation() })),
        ...[...players.values()].map((p) => ({ id: p.id, position: p.body.translation() })),
      ]
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

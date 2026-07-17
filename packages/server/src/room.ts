import { entityId, type Connection, type EntityId } from '@mp/core'
import {
  decodeInput,
  encodeSnapshot,
  encodeWelcome,
  MSG_INPUT,
  readMessageType,
  type InputCommand,
  type SnapshotEntity,
} from '@mp/net'
import { createPhysicsWorld, type PhysicsBody } from '@mp/physics'

import {
  addBalls,
  addGround,
  addPlayerBody,
  applyPlayerInput,
  FIRST_PLAYER_ID,
  GRAVITY,
  playerSpawn,
  type Ball,
} from './sim'

const MAX_INPUT_QUEUE = 6 // bound buffered latency; drop oldest beyond this

interface Player {
  readonly conn: Connection
  readonly id: EntityId
  readonly body: PhysicsBody
  queue: InputCommand[]
  lastProcessedSeq: number
}

const ZERO_INPUT = (seq: number): InputCommand => ({ seq, moveX: 0, moveZ: 0 })

export interface Room {
  addConnection: (conn: Connection) => void
  step: (dtSeconds: number) => void
  sendSnapshots: (serverTimeMs: number) => void
}

export const createRoom = (): Room => {
  const world = createPhysicsWorld({ gravity: GRAVITY })
  addGround(world)
  const balls: Ball[] = addBalls(world)

  const players = new Map<Connection, Player>()
  let nextPlayerId = FIRST_PLAYER_ID

  return {
    addConnection: (conn) => {
      const id = entityId(nextPlayerId++)
      const player: Player = {
        conn,
        id,
        body: addPlayerBody(world, playerSpawn(id)),
        queue: [],
        lastProcessedSeq: 0,
      }
      players.set(conn, player)
      conn.send(encodeWelcome({ playerId: id }))

      conn.onMessage((data) => {
        if (readMessageType(data) !== MSG_INPUT) return
        player.queue.push(decodeInput(data))
        if (player.queue.length > MAX_INPUT_QUEUE) player.queue.shift()
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
          applyPlayerInput(player.body, ZERO_INPUT(player.lastProcessedSeq)) // starved: stop, keep ack
        }
      }
      world.step(dtSeconds)
    },

    sendSnapshots: (serverTimeMs) => {
      const entities: SnapshotEntity[] = [
        ...balls.map((b) => ({ id: b.id, position: b.body.translation() })),
        ...[...players.values()].map((p) => ({ id: p.id, position: p.body.translation() })),
      ]
      const time = serverTimeMs >>> 0
      for (const player of players.values()) {
        player.conn.send(
          encodeSnapshot({ serverTimeMs: time, lastProcessedInputSeq: player.lastProcessedSeq, entities }),
        )
      }
    },
  }
}

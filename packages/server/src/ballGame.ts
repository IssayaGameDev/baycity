import { type EntityId, type Vec3 } from '@mp/core'
import { createPhysicsWorld, type PhysicsBody } from '@mp/physics'

import type { GameSim, PlayerSim } from './room'
import {
  addBalls,
  addGround,
  addPlayerBody,
  applyPlayerInput,
  GRAVITY,
  PLAYER_RADIUS,
  playerSpawn,
  type Ball,
} from './sim'

/** The M2–M8 demo game: pushable balls + velocity-controlled ball players. */
export const createBallGame = (): GameSim => {
  const world = createPhysicsWorld({ gravity: GRAVITY })
  addGround(world)
  const balls: Ball[] = addBalls(world)
  const players = new Map<EntityId, PhysicsBody>()

  return {
    hitRadius: PLAYER_RADIUS,
    addPlayer: (id) => {
      const body = addPlayerBody(world, playerSpawn(id))
      players.set(id, body)
      const sim: PlayerSim = {
        applyInput: (cmd) => applyPlayerInput(body, cmd),
        remove: () => {
          body.remove()
          players.delete(id)
        },
      }
      return sim
    },
    step: (dt) => world.step(dt),
    entities: () => [
      ...balls.map((b) => ({ id: b.id, position: b.body.translation() })),
      ...[...players].map(([id, body]) => ({ id, position: body.translation() })),
    ],
    hittablePositions: () => {
      const m = new Map<EntityId, Vec3>()
      for (const [id, body] of players) m.set(id, body.translation())
      return m
    },
  }
}

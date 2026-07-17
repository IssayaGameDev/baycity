import { type EntityId, type Vec3 } from '@mp/core'

import type { GameSim, PlayerSim } from './room'
import { addCharacter, CHAR_RADIUS, createTpsWorld, playerSpawn, stepCharacter, TICK_DT, type CharacterState } from './tps'

/** M10 game: third-person character controllers on an obstacle course. */
export const createTpsGame = (): GameSim => {
  const world = createTpsWorld()
  const players = new Map<EntityId, CharacterState>()

  return {
    hitRadius: CHAR_RADIUS,
    addPlayer: (id) => {
      const state = addCharacter(world, playerSpawn(id))
      players.set(id, state)
      const sim: PlayerSim = {
        applyInput: (cmd) => stepCharacter(state, cmd, TICK_DT),
        remove: () => {
          state.body.remove()
          players.delete(id)
        },
      }
      return sim
    },
    step: (dt) => world.step(dt),
    entities: () => [...players].map(([id, s]) => ({ id, position: s.body.translation() })),
    hittablePositions: () => {
      const m = new Map<EntityId, Vec3>()
      for (const [id, s] of players) m.set(id, s.body.translation())
      return m
    },
  }
}

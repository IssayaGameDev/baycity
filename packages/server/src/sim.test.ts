import { createPhysicsWorld, initPhysics } from '@mp/physics'
import type { InputCommand } from '@mp/net'
import { beforeAll, describe, expect, it } from 'vitest'

import { addGround, addPlayerBody, applyPlayerInput, GRAVITY, playerSpawn, TICK_DT } from './sim'

describe('shared player sim', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  const run = (inputs: InputCommand[]): { x: number; y: number; z: number } => {
    const world = createPhysicsWorld({ gravity: GRAVITY })
    addGround(world)
    const body = addPlayerBody(world, playerSpawn(1000))
    for (const cmd of inputs) {
      applyPlayerInput(body, cmd)
      world.step(TICK_DT)
    }
    const p = body.translation()
    world.free()
    return p
  }

  const driveRight = (): InputCommand[] =>
    Array.from({ length: 60 }, (_, i) => ({ seq: i + 1, moveX: 1, moveZ: 0 }))

  it('is deterministic: identical inputs yield identical state (basis of reconciliation)', () => {
    // Server authority and client prediction run this same sim; matching results
    // are what keep corrections small (SEED §4).
    expect(run(driveRight())).toEqual(run(driveRight()))
  })

  it('moves the player in the commanded direction', () => {
    expect(run(driveRight()).x).toBeGreaterThan(run([]).x + 1)
  })
})

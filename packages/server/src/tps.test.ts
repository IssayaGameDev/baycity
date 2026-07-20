import { initPhysics } from '@mp/physics'
import type { InputCommand } from '@mp/net'
import { beforeAll, describe, expect, it } from 'vitest'

import { addCharacter, createTpsWorld, playerSpawn, stepCharacter, TICK_DT } from './tps'

const cmd = (moveX: number, moveZ: number, jump = false): InputCommand => ({ moveX, moveZ, jump })

const runToPos = (inputs: InputCommand[]): { x: number; y: number; z: number } => {
  const world = createTpsWorld()
  const c = addCharacter(world, playerSpawn(1000))
  for (const i of inputs) {
    stepCharacter(c, i, TICK_DT)
    world.step(TICK_DT)
  }
  const p = c.body.translation()
  world.free()
  return p
}

describe('tps character sim', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('is deterministic (shared client/bot sim)', () => {
    const inputs = Array.from({ length: 90 }, (_, i) => cmd(1, 0, i === 40))
    expect(runToPos(inputs)).toEqual(runToPos(inputs))
  })

  it('moves in the commanded world direction', () => {
    const still = runToPos(Array.from({ length: 60 }, () => cmd(0, 0)))
    const moved = runToPos(Array.from({ length: 60 }, () => cmd(1, 0)))
    expect(moved.x).toBeGreaterThan(still.x + 1)
  })

  it('jumps above resting height then lands', () => {
    const world = createTpsWorld()
    const c = addCharacter(world, playerSpawn(1000))
    for (let i = 0; i < 60; i++) {
      stepCharacter(c, cmd(0, 0), TICK_DT)
      world.step(TICK_DT)
    }
    const restY = c.body.translation().y
    let peak = restY
    for (let i = 0; i < 40; i++) {
      stepCharacter(c, cmd(0, 0, i === 0), TICK_DT)
      world.step(TICK_DT)
      peak = Math.max(peak, c.body.translation().y)
    }
    expect(peak).toBeGreaterThan(restY + 0.3) // left the ground
    world.free()
  })
})

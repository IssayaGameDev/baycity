import { initPhysics } from '@mp/physics'
import type { InputCommand } from '@mp/net'
import { beforeAll, describe, expect, it } from 'vitest'

import { addCharacter, createTpsWorld, DEFAULT_TUNING, playerSpawn, stepCharacter, TICK_DT } from './tps'

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

  it('jump apex ≈ the configured jump height (v₀ = √(2gh))', () => {
    const world = createTpsWorld()
    const c = addCharacter(world, playerSpawn(1000))
    for (let i = 0; i < 60; i++) {
      stepCharacter(c, cmd(0, 0), TICK_DT)
      world.step(TICK_DT)
    }
    const restY = c.body.translation().y
    stepCharacter(c, cmd(0, 0, true), TICK_DT) // jump from the ground
    world.step(TICK_DT)
    let peak = c.body.translation().y
    for (let i = 0; i < 80; i++) {
      stepCharacter(c, cmd(0, 0), TICK_DT)
      world.step(TICK_DT)
      peak = Math.max(peak, c.body.translation().y)
    }
    const apex = peak - restY
    expect(apex).toBeGreaterThan(DEFAULT_TUNING.jumpHeight * 0.8)
    expect(apex).toBeLessThan(DEFAULT_TUNING.jumpHeight * 1.3)
    world.free()
  })

  it('brakes to a stop on the ground after input is released', () => {
    const world = createTpsWorld()
    const c = addCharacter(world, playerSpawn(1000))
    for (let i = 0; i < 40; i++) {
      stepCharacter(c, cmd(1, 0), TICK_DT) // run up to full speed + settle on ground
      world.step(TICK_DT)
    }
    for (let i = 0; i < 20; i++) {
      stepCharacter(c, cmd(0, 0), TICK_DT) // release
      world.step(TICK_DT)
    }
    expect(Math.abs(c.vx)).toBeLessThan(0.05)
    world.free()
  })

  it('preserves horizontal momentum through a jump with no air input', () => {
    const world = createTpsWorld()
    const c = addCharacter(world, playerSpawn(1000))
    for (let i = 0; i < 40; i++) {
      stepCharacter(c, cmd(1, 0), TICK_DT) // reach full ground speed
      world.step(TICK_DT)
    }
    stepCharacter(c, cmd(1, 0, true), TICK_DT) // jump while moving
    world.step(TICK_DT)
    const xStart = c.body.translation().x
    for (let i = 0; i < 10; i++) {
      stepCharacter(c, cmd(0, 0), TICK_DT) // airborne, no input — old model would stop dead
      world.step(TICK_DT)
    }
    expect(c.body.translation().x).toBeGreaterThan(xStart + 0.5)
    world.free()
  })
})

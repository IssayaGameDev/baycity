import { entityId, type Vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { createLocalController, type LocalWorld } from './localController'

const ID = entityId(1000)

// A trivial world: the entity's x advances by moveX each step.
const makeWorld = (): LocalWorld => {
  let pos: Vec3 = { x: 0, y: 0, z: 0 }
  return {
    applyInput: (cmd) => {
      pos = { x: pos.x + cmd.moveX, y: 0, z: 0 }
    },
    readState: () => new Map([[ID, { ...pos }]]),
  }
}

/** One tick of running east. A command rather than positionals since ADR 0061. */
const EAST = { moveX: 1, moveZ: 0, jump: false }

describe('createLocalController', () => {
  it('advances authoritative state by the applied input (no correction)', () => {
    let t = 0
    const c = createLocalController({ world: makeWorld(), tickRateHz: 30, now: () => t })
    c.step(EAST)
    c.step(EAST)
    expect(c.state().get(ID)!.x).toBe(2)
  })

  it('render-interpolates between the last two ticks', () => {
    let t = 0
    const tick = 1000 / 30
    const c = createLocalController({ world: makeWorld(), tickRateHz: 30, now: () => t })
    c.step(EAST) // prev x=0, curr x=1, lastTickAt=0

    t = tick / 2 // halfway to the next tick
    expect(c.renderPositions().get(ID)!.x).toBeCloseTo(0.5, 5)

    t = tick * 2 // past the next tick — clamps to curr, no extrapolation
    expect(c.renderPositions().get(ID)!.x).toBe(1)
  })

  /** ADR 0140: the frame's fraction comes from the loop's schedule, so every drawn thing shares one timeline. */
  it('interpolates by the fraction it is given, whatever the clock says', () => {
    const t = 0
    const c = createLocalController({ world: makeWorld(), tickRateHz: 30, now: () => t })
    c.step(EAST)
    expect(c.renderPositions(0.25).get(ID)!.x).toBeCloseTo(0.25, 9)
  })
})

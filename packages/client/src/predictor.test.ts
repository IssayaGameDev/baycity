import { entityId, type EntityId, type Vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { createPredictor, type PredictedWorld } from './predictor'

const PLAYER = entityId(100)
const BALL = entityId(1)

// Mock world: the player's x advances by moveX each step; the ball is inert
// (moves only when restored to an authoritative position).
const makeWorld = (): PredictedWorld => {
  const state = new Map<EntityId, Vec3>([
    [PLAYER, { x: 0, y: 0, z: 0 }],
    [BALL, { x: 5, y: 0, z: 0 }],
  ])
  return {
    applyInput: (cmd) => {
      const p = state.get(PLAYER)!
      state.set(PLAYER, { x: p.x + cmd.moveX, y: 0, z: 0 })
    },
    readState: () => new Map(state),
    restore: (s) => {
      for (const [id, pos] of s) state.set(id, { ...pos })
    },
  }
}

describe('createPredictor (world predictor)', () => {
  const opts = (now: () => number) => ({ world: makeWorld(), tickRateHz: 100, correctionSmoothingMs: 100, now })

  it('render-interpolates a predicted entity between ticks', () => {
    let t = 0
    const p = createPredictor(opts(() => t))
    p.predict(1, 0) // player 0 -> 1
    p.predict(1, 0) // player 1 -> 2 (prev=1, curr=2, lastTickAt=0)
    t = 0
    expect(p.renderPositions().get(PLAYER)!.x).toBeCloseTo(1)
    t = 5
    expect(p.renderPositions().get(PLAYER)!.x).toBeCloseTo(1.5)
    t = 10
    expect(p.renderPositions().get(PLAYER)!.x).toBeCloseTo(2)
  })

  it('predicts multiple entities and leaves inert ones put', () => {
    let t = 0
    const p = createPredictor(opts(() => t))
    p.predict(1, 0)
    t = 10
    expect(p.renderPositions().get(BALL)!.x).toBeCloseTo(5)
  })

  it('reconciles cleanly when the server agrees', () => {
    let t = 0
    const p = createPredictor(opts(() => t))
    p.predict(1, 0)
    p.predict(1, 0)
    p.predict(1, 0) // player predicted x = 3
    p.reconcile(
      new Map([
        [PLAYER, { x: 1, y: 0, z: 0 }],
        [BALL, { x: 5, y: 0, z: 0 }],
      ]),
      1,
    )
    expect(p.pendingInputs()).toBe(2)
    t = 10
    expect(p.renderPositions().get(PLAYER)!.x).toBeCloseTo(3)
  })

  it('eases in an authoritative prop correction instead of snapping', () => {
    let t = 0
    const p = createPredictor(opts(() => t))
    p.predict(1, 0)
    p.predict(1, 0)
    p.predict(1, 0)
    const ballBefore = p.renderPositions().get(BALL)!.x // 5
    // server says the ball is at 8 (e.g. pushed by another player)
    p.reconcile(
      new Map([
        [PLAYER, { x: 1, y: 0, z: 0 }],
        [BALL, { x: 8, y: 0, z: 0 }],
      ]),
      1,
    )
    expect(p.renderPositions().get(BALL)!.x).toBeCloseTo(ballBefore) // continuous, no snap
    t = 100_000
    expect(p.renderPositions().get(BALL)!.x).toBeCloseTo(8, 1) // eased to corrected
  })
})

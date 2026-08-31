import { TICK_DT, vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics, type PhysicsWorld } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { addCharacter, CHAR_HALF_HEIGHT, CHAR_RADIUS, DEFAULT_TUNING, stepCharacter } from './groundController'

// TEMPORARY: measure what the character can actually do, so obstacle parameters are chosen against
// measured limits rather than arithmetic. Delete after the numbers are recorded in docs.
const STAND = CHAR_HALF_HEIGHT + CHAR_RADIUS
const TOP = 0.2 // half-thickness of the slabs below

const slab = (world: PhysicsWorld, centre: { x: number; y: number; z: number }, half: { x: number; z: number }): void => {
  world.addFixedBody({ position: vec3(centre.x, centre.y, centre.z), shape: { kind: 'cuboid', halfExtents: vec3(half.x, TOP, half.z) } })
}

/** Run toward +x from a run-up, jump at `jumpAtX`, and report whether we ended on the far slab. */
const attemptGap = (gap: number, runUp: number): boolean => {
  const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
  slab(world, { x: 0, y: 0, z: 0 }, { x: 6, z: 3 }) // take-off, edge at x=6
  slab(world, { x: 6 + gap + 6, y: 0, z: 0 }, { x: 6, z: 3 }) // landing, edge at x=6+gap
  const c = addCharacter(world, vec3(6 - runUp, TOP + STAND + 0.02, 0))

  let jumped = false
  let landed = false
  for (let t = 0; t < 200; t++) {
    // Jump on the last grounded tick before the edge; hold forward throughout.
    const p = c.body.translation()
    const wantJump = !jumped && c.grounded && p.x > 6 - 0.45
    if (wantJump) jumped = true
    // Held while rising, not tapped: `jumpCutScale` is live in DEFAULT_TUNING, so a one-tick press is a
    // deliberate short hop and would measure the *minimum* jump. The envelope is the maximum.
    stepCharacter(c, { moveX: 1, moveZ: 0, jump: wantJump || c.vy > 0 }, TICK_DT)
    world.step(TICK_DT)
    const now = c.body.translation()
    // Stop the moment it is standing safely past the far edge — otherwise it keeps running and
    // falls off the end of the landing slab, which reads as a failed jump.
    if (jumped && c.grounded && now.x > 6 + gap + 0.3 && now.y > 0) {
      landed = true
      break
    }
    if (now.y < -5) break // fell into the gap
  }
  world.free()
  return landed
}

/** Jump straight up onto a ledge `rise` above the floor; report whether we ended on it. */
const attemptStepUp = (rise: number, withJump: boolean): boolean => {
  const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
  slab(world, { x: 0, y: 0, z: 0 }, { x: 4, z: 3 })
  slab(world, { x: 6, y: rise, z: 0 }, { x: 2, z: 3 }) // ledge, near face at x=4
  const c = addCharacter(world, vec3(0, TOP + STAND + 0.02, 0))

  const onLedgeY = rise + TOP + STAND
  let jumped = false
  let up = false
  for (let t = 0; t < 240; t++) {
    const p = c.body.translation()
    const wantJump = withJump && !jumped && c.grounded && p.x > 3.2
    if (wantJump) jumped = true
    // Held while rising — see the note in `attemptGap`.
    stepCharacter(c, { moveX: 1, moveZ: 0, jump: wantJump || (withJump && c.vy > 0) }, TICK_DT)
    world.step(TICK_DT)
    const now = c.body.translation()
    // Standing on the ledge, past its near face — stop before it runs off the far end.
    if (c.grounded && now.x > 4.4 && Math.abs(now.y - onLedgeY) < 0.2) {
      up = true
      break
    }
    if (now.y < -5) break
  }
  world.free()
  return up
}

const largestPassing = (from: number, to: number, step: number, test: (v: number) => boolean): number => {
  let best = Number.NaN
  for (let v = from; v <= to + 1e-9; v += step) if (test(Math.round(v * 1000) / 1000)) best = Math.round(v * 1000) / 1000
  return best
}

describe('movement envelope (measured)', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('reports the limits every obstacle parameter is bounded by', () => {
    const t = DEFAULT_TUNING
    const airTime = 2 * Math.sqrt((2 * t.jumpHeight) / t.gravity)

    const gapRunning = largestPassing(0.5, 6, 0.1, (g) => attemptGap(g, 5))
    const gapStanding = largestPassing(0.5, 6, 0.1, (g) => attemptGap(g, 0.05))
    const stepNoJump = largestPassing(0.1, 1.2, 0.05, (r) => attemptStepUp(r, false))
    const stepJump = largestPassing(0.1, 4, 0.1, (r) => attemptStepUp(r, true))

    /* eslint-disable no-console */
    console.log(`
--- movement envelope -------------------------------------------------
speed              ${t.moveSpeed} m/s
jump apex          ${t.jumpHeight} m      gravity ${t.gravity} m/s²
air time           ${airTime.toFixed(3)} s (theoretical reach ${(t.moveSpeed * airTime).toFixed(2)} m)
capsule            ${(CHAR_RADIUS * 2).toFixed(1)} m wide, ${(CHAR_HALF_HEIGHT * 2 + CHAR_RADIUS * 2).toFixed(1)} m tall

MEASURED
max gap, running   ${gapRunning.toFixed(1)} m
max gap, standing  ${gapStanding.toFixed(1)} m
max step-up, walk  ${stepNoJump.toFixed(2)} m   (no jump; autostep)
max step-up, jump  ${stepJump.toFixed(1)} m
-----------------------------------------------------------------------`)
    /* eslint-enable no-console */
    expect(gapRunning).toBeGreaterThan(0)
  })
})

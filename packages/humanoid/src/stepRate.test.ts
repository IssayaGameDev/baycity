import type { InputCommand } from '@mp/core'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { addCharacter, CHAR_HALF_HEIGHT, CHAR_RADIUS, DEFAULT_TUNING, stepCharacter, type CharacterTuning } from './groundController'

/**
 * The same moves at 30, 60 and 120 steps a second (ADR 0215, Kodjo: "same jump, different result is wrong code").
 * Before, a running jump reached 31 cm further at 120 than at 30, a held jump re-jumped 14 cm higher, and a run sank
 * 20 cm into the floor at some rates and not others. What stays is the tick's own quantum: a landing is noticed at
 * the end of the step it happens in, and the physics' resolve now and then delivers part of a step.
 */

const RATES = [30, 60, 120]
/** Keyboard's tuning at a mid Level: instant starts, a hard brake, air drag. */
const KEYBOARD: CharacterTuning = { ...DEFAULT_TUNING, groundMaxAccel: Infinity, groundBrakeMaxAccel: 200, airMaxAccel: 100, airDrag: 0.5, moveSpeed: 20 }
/** How far apart two rates may land, in metres: the resolve's partial steps, measured up to 5 cm. */
const NEAR = 0.06
const STILL: InputCommand = { moveX: 0, moveZ: 0, jump: false }
const SOLE = CHAR_HALF_HEIGHT + CHAR_RADIUS

interface Trace {
  /** Position at each sampled time. */
  readonly at: readonly { x: number; y: number }[]
  readonly peak: number
  /** When footing first came back after it was lost, or `null`. */
  readonly landed: number | null
}

/** Settle a second, then run `seconds` of `input(t)` at `hz`; positions at `times` (multiples of 1/30 s). */
const trace = (hz: number, tuning: CharacterTuning, seconds: number, input: (t: number) => InputCommand, times: readonly number[], spawnY = SOLE + 0.1): Trace => {
  const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
  world.addFixedBody({ position: { x: 0, y: -0.5, z: 0 }, shape: { kind: 'cuboid', halfExtents: { x: 500, y: 0.5, z: 500 } } })
  const c = addCharacter(world, { x: 0, y: spawnY, z: 0 })
  const dt = 1 / hz
  if (spawnY <= SOLE + 0.1)
    for (let k = 0; k < hz; k++) {
      stepCharacter(c, STILL, dt, tuning)
      world.step(dt)
    }
  const at: { x: number; y: number }[] = []
  let peak = -Infinity
  let left = spawnY > SOLE + 0.1
  let landed: number | null = null
  for (let k = 0; k < Math.round(seconds * hz); k++) {
    const t = k * dt
    if (times.some((s) => Math.abs(s - t) < dt / 2)) at.push({ x: c.body.translation().x, y: c.body.translation().y })
    const was = c.grounded
    stepCharacter(c, input(t), dt, tuning)
    world.step(dt)
    peak = Math.max(peak, c.body.translation().y)
    if (was && !c.grounded) left = true
    if (left && !was && c.grounded && landed === null) landed = t + dt
  }
  world.free()
  return { at, peak, landed }
}

const agree = (name: string, tuning: CharacterTuning, seconds: number, input: (t: number) => InputCommand, times: readonly number[], spawnY?: number): void => {
  const [base, ...rest] = RATES.map((hz) => ({ hz, ...trace(hz, tuning, seconds, input, times, spawnY) }))
  for (const r of rest) {
    r.at.forEach((p, i) => {
      expect(Math.abs(p.x - base!.at[i]!.x), `${name}: x at ${times[i]} s, ${r.hz} against 30`).toBeLessThan(NEAR)
      expect(Math.abs(p.y - base!.at[i]!.y), `${name}: y at ${times[i]} s, ${r.hz} against 30`).toBeLessThan(NEAR)
    })
    expect(Math.abs(r.peak - base!.peak), `${name}: peak, ${r.hz} against 30`).toBeLessThan(NEAR)
    // Noticed at the end of the step it happens in: a 30 Hz tick is the most two rates can disagree by.
    if (base!.landed !== null) expect(Math.abs(r.landed! - base!.landed), `${name}: landing, ${r.hz} against 30`).toBeLessThanOrEqual(1 / 30 + 1e-9)
  }
}

beforeAll(async () => {
  await initPhysics()
})

describe('the same moves at 30, 60 and 120 steps a second (ADR 0215)', () => {
  for (const [label, tuning] of [['the default tuning', DEFAULT_TUNING], ["Keyboard's", KEYBOARD]] as const) {
    it(`agree with ${label}`, () => {
      agree('standing jump, held', tuning, 2.5, (t) => ({ ...STILL, jump: t >= 0.5 }), [0.7, 1, 1.5, 2])
      agree('run from rest', tuning, 1.5, () => ({ ...STILL, moveX: 1 }), [0.2, 0.5, 1])
      // Sampled before the landing: after it the held jump goes again a step sooner or later at each rate.
      agree('running jump', tuning, 2, (t) => ({ moveX: 1, moveZ: 0, jump: t >= 1 && t < 1.1 }), [1.2, 1.4, 1.6])
      agree('run, let go, coast and brake', tuning, 2, (t) => ({ ...STILL, moveX: t < 1 ? 1 : 0 }), [1.2, 1.5, 1.9])
      agree('drop from 6 m', tuning, 1.5, () => STILL, [0.2, 0.3, 0.6], SOLE + 6)
    })
  }

  /**
   * Kodjo's lava: a gentle drop gave one free jump, the landing called from up to 0.4 m above the floor — and at 120
   * steps a second every held jump went again from about 14 cm up. Footing comes back with the soles on the floor.
   */
  it('lands on the floor, not above it, whatever the rate', () => {
    for (const hz of RATES)
      for (const drop of [0.3, 0.5, 1, 3]) {
        const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
        world.addFixedBody({ position: { x: 0, y: -0.5, z: 0 }, shape: { kind: 'cuboid', halfExtents: { x: 50, y: 0.5, z: 50 } } })
        const c = addCharacter(world, { x: 0, y: SOLE + drop, z: 0 })
        const dt = 1 / hz
        let soles: number | null = null
        for (let k = 0; k < hz * 2 && soles === null; k++) {
          stepCharacter(c, { ...STILL, jump: true }, dt, DEFAULT_TUNING)
          world.step(dt)
          if (c.grounded) soles = c.body.translation().y - SOLE
        }
        world.free()
        expect(soles, `${hz} Hz, ${drop} m`).not.toBeNull()
        expect(soles!, `${hz} Hz, ${drop} m: the soles when footing came back`).toBeLessThan(0.05)
      }
  })
})

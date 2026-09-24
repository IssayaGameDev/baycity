import { COLLIDER, SEQUENCE, instantiateLevel, type Level, type TypeInfo } from '@mp/content'
import { TICK_DT, vec3 } from '@mp/core'
import { addCharacter, CHAR_HALF_HEIGHT, CHAR_RADIUS, stepCharacter } from '@mp/humanoid'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * Riding a platform a sequence moves (ADR 0137), through the loader and the character exactly as the game ticks
 * them: sliced when the deck moves too far in one tick (ADR 0104), posed, half a step, the character, half a
 * step. What `humanoid`'s own carry tests prove with a hand-posed body, proved here for the real path.
 */

const TYPES: TypeInfo = { get: (type) => (type === COLLIDER || type === SEQUENCE ? {} : { singleton: true }) }
const STILL = { moveX: 0, moveZ: 0, jump: false }
const SOLE = CHAR_HALF_HEIGHT + CHAR_RADIUS
const DECK_HALF = 0.2

/** A 6 × 0.4 × 6 deck at y = 20, going up `rise` metres and back at `speed`, eased, forever. */
const lift = (rise: number, speed: number): Level => ({
  id: 'fx',
  config: {},
  nodes: [
    {
      id: 'deck',
      transform: { position: vec3(0, 20, 0) },
      components: [
        { id: 'col', type: COLLIDER, params: { shape: { kind: 'box', halfExtents: vec3(3, DECK_HALF, 3) } } },
        {
          id: 'seq',
          type: SEQUENCE,
          params: {
            name: 'lift',
            clock: 'shared',
            axes: 'object',
            loop: 'yoyo',
            times: 0,
            offset: 0,
            stages: [{ id: 's', steps: [{ id: 'up', kind: 'move', to: vec3(0, rise, 0), timing: { by: 'speed', speed }, ease: 'in-out-sine' }] }],
          },
        },
      ],
    },
  ],
})

/** Ride it for `ticks` ticks and report the worst gap between the soles and the deck. */
const ride = (level: Level, ticks: number): number => {
  const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
  const loaded = instantiateLevel(world, level, TYPES)
  const deck = loaded.nodes[0]!.colliderHandles[0]!
  const char = addCharacter(world, vec3(0, 20 + DECK_HALF + SOLE + 0.02, 0))
  let prev = -1
  let worst = 0
  for (let k = 0; k < ticks; k++) {
    const now = k * TICK_DT * 1000
    if (prev < 0) prev = now
    const slices = loaded.motionSlices(prev, now, SOLE)
    for (let s = 1; s <= slices; s++) {
      const at = prev + ((now - prev) * s) / slices
      loaded.update(at, char.base?.colliderHandle)
      world.step(TICK_DT / slices / 2)
      stepCharacter(char, STILL, TICK_DT / slices, undefined, loaded.basePose)
      world.step(TICK_DT / slices / 2)
    }
    prev = now
    // Settling onto it first: the first second is the character landing, not the carry.
    if (k < 30) continue
    const top = loaded.basePose(deck)!.position.y + DECK_HALF
    worst = Math.max(worst, Math.abs(char.body.translation().y - SOLE - top))
  }
  world.free()
  return worst
}

beforeAll(async () => {
  await initPhysics()
})

describe('riding a sequence', () => {
  it('stays on a lift going up and down at ordinary speeds', () => {
    for (const speed of [2, 6, 12]) expect(ride(lift(8, speed), 240), `${speed} m/s`).toBeLessThan(0.1)
  })

  /** Eased, a 40 m/s average peaks near 63 m/s — two slices a tick, which is the path ADR 0104 added. */
  it('stays on one fast enough to be sliced', () => {
    expect(ride(lift(20, 40), 240)).toBeLessThan(0.1)
  })
})

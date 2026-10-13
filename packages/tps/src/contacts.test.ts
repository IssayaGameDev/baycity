import { COLLIDER, SEQUENCE, instantiateLevel, type Level, type Node, type TypeInfo } from '@mp/content'
import { TICK_DT, TICK_RATE_HZ, vec3 } from '@mp/core'
import { addCharacter, CHAR_HALF_HEIGHT, CHAR_RADIUS, stepCharacter } from '@mp/humanoid'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { contactsNow } from './contacts'

/**
 * Kodjo's lava (ADR 0208): with jump held, a player bounced on a hazard a few times before it killed. A fast mover
 * anywhere in the level slices every tick (ADR 0104); the landing was one slice and the jump the next, and the
 * rules read what the capsule touched after the last slice only — by then it was in the air.
 */

const TYPES: TypeInfo = { get: (type) => (type === COLLIDER || type === SEQUENCE ? {} : { singleton: true }) }
const SOLE = CHAR_HALF_HEIGHT + CHAR_RADIUS
const HOLD_JUMP = { moveX: 0, moveZ: 0, jump: true }

const lava: Node = {
  id: 'lava',
  transform: { position: vec3(0, -1, 0) },
  components: [{ id: 'lava-col', type: COLLIDER, params: { shape: { kind: 'box', halfExtents: vec3(20, 1, 20) } } }],
}
/** Far from the player, at 1.5 m a tick — past the 1 m a rider allows, so every tick is two slices. */
const racer: Node = {
  id: 'racer',
  transform: { position: vec3(500, 0, 0) },
  components: [
    { id: 'racer-col', type: COLLIDER, params: { shape: { kind: 'box', halfExtents: vec3(1, 1, 1) } } },
    {
      id: 'racer-seq',
      type: SEQUENCE,
      params: {
        name: '',
        clock: 'shared',
        axes: 'object',
        loop: 'restart',
        times: 0,
        offset: 0,
        stages: [{ id: 'go', steps: [{ id: 'm', kind: 'move', to: vec3(1000, 0, 0), timing: { by: 'speed', speed: 1.5 * TICK_RATE_HZ }, ease: 'linear' }] }],
      },
    },
  ],
}
const level: Level = { id: 'fx', config: {}, nodes: [lava, racer] }

/**
 * Drop the player from `height` onto the lava, jump held, ticking as the game does; the tick it lands, what each
 * reading saw. Fast enough a fall that the landing is a real touch — not the probe calling it landed from above.
 */
const land = (height: number): { slices: number; everySlice: boolean; lastSlice: boolean } => {
  const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
  const loaded = instantiateLevel(world, level, TYPES)
  const floor = loaded.nodes[0]!.colliderHandles[0]!
  const char = addCharacter(world, vec3(0, SOLE + height, 0))
  let prev = -1
  try {
    for (let k = 0; k < 3 * TICK_RATE_HZ; k++) {
      const now = k * TICK_DT * 1000
      if (prev < 0) prev = now
      const slices = loaded.motionSlices(prev, now, SOLE)
      const seen = new Set<number>()
      let landed = false
      for (let s = 1; s <= slices; s++) {
        loaded.update(prev + ((now - prev) * s) / slices, char.base?.colliderHandle, s === 1)
        loaded.shove(char.body)
        world.step(TICK_DT / slices / 2)
        stepCharacter(char, HOLD_JUMP, TICK_DT / slices, undefined, loaded.basePose)
        world.step(TICK_DT / slices / 2)
        landed ||= char.grounded
        for (const h of contactsNow(char.body)) seen.add(h)
      }
      prev = now
      if (landed) return { slices, everySlice: seen.has(floor), lastSlice: contactsNow(char.body).includes(floor) }
    }
    throw new Error(`never landed from ${height} m`)
  } finally {
    world.free()
  }
}

beforeAll(async () => {
  await initPhysics()
})

describe('what the capsule touched in a tick', () => {
  it('counts a touch from any slice of it, though the player jumped off before the last', () => {
    // Ten drops a little apart, so the landing falls in either slice.
    const runs = Array.from({ length: 10 }, (_, i) => land(8 + i * 0.1))
    for (const [i, r] of runs.entries()) {
      expect(r.slices, `drop ${i}`).toBe(2)
      expect(r.everySlice, `drop ${i}`).toBe(true)
    }
    // What the rules used to read: after the last slice only. It misses a landing in the first.
    expect(runs.some((r) => !r.lastSlice)).toBe(true)
  })
})

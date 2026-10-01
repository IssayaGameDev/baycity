import { COLLIDER, SEQUENCE, instantiateLevel, type Level, type Node, type TypeInfo } from '@mp/content'
import { TICK_DT, vec3, type Vec3 } from '@mp/core'
import { addCharacter, CHAR_HALF_HEIGHT, CHAR_RADIUS, stepCharacter } from '@mp/humanoid'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * A platform a sequence moves **into** a player (ADR 0186), through the loader and the character exactly as the
 * game ticks them: sliced (ADR 0104), posed, half a step, the push, the character, half a step. The character
 * controller resolves only the character's own motion, so before the push a wall arriving at any speed — slow
 * ones included — passed straight through whoever it met.
 */

const TYPES: TypeInfo = { get: (type) => (type === COLLIDER || type === SEQUENCE ? {} : { singleton: true }) }
const SOLE = CHAR_HALF_HEIGHT + CHAR_RADIUS
const STILL = { moveX: 0, moveZ: 0, jump: false }

/** A box, and — given `to` and `speed` — a sequence that waits 1.5 s (the player lands) then moves it by `to`. */
const box = (id: string, at: Vec3, half: Vec3, to?: Vec3, speed = 0): Node => ({
  id,
  transform: { position: at },
  components: [
    { id: `${id}-col`, type: COLLIDER, params: { shape: { kind: 'box', halfExtents: half } } },
    ...(to === undefined
      ? []
      : [
          {
            id: `${id}-seq`,
            type: SEQUENCE,
            params: {
              name: '',
              clock: 'shared',
              axes: 'object',
              loop: 'restart',
              times: 0,
              offset: 0,
              stages: [
                { id: `${id}-a`, steps: [{ id: `${id}-w`, kind: 'wait', seconds: 1.5 }] },
                { id: `${id}-b`, steps: [{ id: `${id}-m`, kind: 'move', to, timing: { by: 'speed', speed }, ease: 'linear' }] },
                { id: `${id}-c`, steps: [{ id: `${id}-r`, kind: 'wait', seconds: 100 }] },
              ],
            },
          },
        ]),
  ],
})

const levelOf = (nodes: Node[]): Level => ({ id: 'fx', config: {}, nodes })
const ground = box('ground', vec3(0, -0.5, 0), vec3(40, 0.5, 40))

/** Run the game's tick for `seconds`; the player's position and the last node's (the mover's) at the end. */
const run = (level: Level, spawn: Vec3, seconds: number, cmd = STILL): { player: Vec3; mover: Vec3; highest: number } => {
  const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
  const loaded = instantiateLevel(world, level, TYPES)
  const mover = loaded.nodes[loaded.nodes.length - 1]!.colliderHandles[0]!
  const char = addCharacter(world, spawn)
  let prev = -1
  let highest = -Infinity
  for (let k = 0; k < seconds * 30; k++) {
    const now = k * TICK_DT * 1000
    if (prev < 0) prev = now
    const slices = loaded.motionSlices(prev, now, SOLE)
    for (let s = 1; s <= slices; s++) {
      const at = prev + ((now - prev) * s) / slices
      loaded.update(at, char.base?.colliderHandle, s === 1)
      world.step(TICK_DT / slices / 2)
      loaded.shove(char.body)
      stepCharacter(char, cmd, TICK_DT / slices, undefined, loaded.basePose)
      world.step(TICK_DT / slices / 2)
    }
    prev = now
    highest = Math.max(highest, char.body.translation().y)
  }
  const result = { player: char.body.translation(), mover: loaded.basePose(mover)!.position, highest }
  world.free()
  return result
}

beforeAll(async () => {
  await initPhysics()
})

describe('a platform moving into a player', () => {
  /** A wall 1 m thick, 3 m tall, crossing from x = −3 to x = 10 through a player standing at the origin. */
  const sweep = (speed: number, cmd = STILL): { player: Vec3; face: number } => {
    const wall = box('wall', vec3(-3, 1.5, 0), vec3(0.5, 1.5, 3), vec3(13, 0, 0), speed)
    const end = run(levelOf([ground, wall]), vec3(0, SOLE + 0.3, 0), 13 / speed + 2.5, cmd)
    return { player: end.player, face: end.mover.x + 0.5 }
  }

  it('pushes a player standing in its way ahead of it, slow or fast', () => {
    for (const speed of [0.5, 2, 10, 20, 40]) {
      const { player, face } = sweep(speed)
      expect(player.x, `${speed} m/s`).toBeGreaterThan(face + CHAR_RADIUS - 0.03)
    }
  })

  it('stays a wall to a player walking into it as it comes', () => {
    const { player, face } = sweep(2, { moveX: -1, moveZ: 0, jump: false })
    expect(player.x).toBeGreaterThan(face + CHAR_RADIUS - 0.03)
  })

  /** A bar's tip comes faster than its hub: the push follows the turn at the player's place, not the bar's centre. */
  it('sweeps a player along ahead of a spinning bar', () => {
    for (const seconds of [2, 0.5, 0.25]) {
      const bar: Node = {
        id: 'bar',
        transform: { position: vec3(0, 0.75, 0) },
        components: [
          { id: 'bar-col', type: COLLIDER, params: { shape: { kind: 'box', halfExtents: vec3(3, 0.5, 0.25) } } },
          {
            id: 'bar-seq',
            type: SEQUENCE,
            params: {
              name: '',
              clock: 'shared',
              axes: 'object',
              loop: 'restart',
              times: 0,
              offset: 0,
              stages: [
                { id: 'a', steps: [{ id: 'w', kind: 'wait', seconds: 1.5 }] },
                { id: 'b', steps: [{ id: 't', kind: 'turn', axis: vec3(0, 1, 0), angle: 180, timing: { by: 'seconds', seconds }, ease: 'linear' }] },
                { id: 'c', steps: [{ id: 'r', kind: 'wait', seconds: 100 }] },
              ],
            },
          },
        ],
      }
      // Beside the bar on +z: half a turn brings its far end round through the player and back along x, so a
      // player pushed ahead of it ends on the −z side.
      const end = run(levelOf([ground, bar]), vec3(2, SOLE + 0.3, 1.2), seconds + 2.5)
      expect(end.player.z, `half a turn in ${seconds} s`).toBeLessThan(-(0.25 + CHAR_RADIUS - 0.03))
    }
  })

  /** Kodjo's call: pinned with nowhere to go, the player stays and the wall passes through — nobody is launched. */
  it('passes through a player pinned against a still wall, and throws nobody', () => {
    const still = box('still', vec3(3, 1.5, 0), vec3(0.5, 1.5, 3))
    const wall = box('wall', vec3(-3, 1.5, 0), vec3(0.5, 1.5, 3), vec3(13, 0, 0), 5)
    const end = run(levelOf([ground, still, wall]), vec3(0, SOLE + 0.3, 0), 13 / 5 + 2.5)
    expect(end.player.x).toBeCloseTo(2.5 - CHAR_RADIUS, 1)
    expect(end.highest).toBeLessThan(SOLE + 0.31)
  })

  /** The lift was taken as the base a tick early, through the floor's edge, and was let off pushing. */
  it('lifts a player standing on a floor edge half over a fast lift', () => {
    const floor = box('floor', vec3(-5, -0.5, 0), vec3(5, 0.5, 5))
    const lift = box('lift', vec3(2, -1.2, 0), vec3(2, 0.2, 2), vec3(0, 4, 0), 20)
    const end = run(levelOf([floor, lift]), vec3(0.1, SOLE + 0.3, 0), 4 / 20 + 2.5)
    expect(end.player.y - SOLE).toBeCloseTo(end.mover.y + 0.2, 1)
  })

  it('leaves riding as it was: on the deck going up, down or sideways', () => {
    for (const [to, speed] of [
      [vec3(0, 6, 0), 20],
      [vec3(0, -6, 0), 5],
      [vec3(30, 0, 0), 20],
    ] as const) {
      const deck = box('deck', vec3(0, 10, 0), vec3(3, 0.2, 3), to, speed)
      const end = run(levelOf([deck]), vec3(0, 10.2 + SOLE + 0.3, 0), Math.hypot(to.x, to.y, to.z) / speed + 2.5)
      expect(Math.abs(end.player.y - SOLE - (end.mover.y + 0.2)), JSON.stringify(to)).toBeLessThan(0.03)
      expect(Math.abs(end.player.x - end.mover.x), JSON.stringify(to)).toBeLessThan(0.03)
    }
  })
})

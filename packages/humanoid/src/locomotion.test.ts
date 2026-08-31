import { createRegistry, createComponentRuntime, characterAccess, type Effects } from '@mp/components'
import { COLLIDER, instantiateLevel, type ComponentData, type Level, type Node } from '@mp/content'
import { TICK_DT, vec3, type InputCommand } from '@mp/core'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { addCharacter, CHAR_HALF_HEIGHT, CHAR_RADIUS, DEFAULT_TUNING, type CharacterState } from './groundController'
import { createLocomotion, LOCOMOTION_DEF } from './locomotion'

/**
 * Locomotion as a component (ADR 0061).
 *
 * The behaviour of `stepCharacter` is not retested here — it has 119 tests of its own and this is a move, not
 * a rewrite. What is tested is the *seam*: that the component runs in the movement slot, that it moves the
 * character it was bound to, that the game's own tuning reaches it, that a game attaching none simply does not
 * move, and that the unbound registry definition is inert.
 */

const STAND = CHAR_HALF_HEIGHT + CHAR_RADIUS
const STILL: InputCommand = { moveX: 0, moveZ: 0, jump: false }
const EAST: InputCommand = { moveX: 1, moveZ: 0, jump: false }

const comp = (id: string, type: string, params: Record<string, unknown> = {}): ComponentData => ({ id, type, params })
const levelOf = (nodes: Node[]): Level => ({ id: 'loco', config: {}, nodes })
const noEffects = (): Effects => ({ kill: () => {}, progress: () => {} })

const floor = (): Node => ({
  id: 'floor',
  transform: { position: vec3(0, -0.5, 0) },
  components: [comp('c0', COLLIDER, { shape: { kind: 'box', halfExtents: vec3(20, 0.5, 20) } })],
})

describe('the locomotion component', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  /** A world, a floor, a character on it, and the runtime wired the way a host wires it. */
  const scene = (opts: { attach: boolean; tuning?: typeof DEFAULT_TUNING } = { attach: true }) => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateLevel(world, levelOf([floor()]), createRegistry([]))
    const char: CharacterState = addCharacter(world, vec3(0, STAND + 0.02, 0))
    const tuning = opts.tuning ?? DEFAULT_TUNING
    const def = createLocomotion({ character: () => char, tuning: () => tuning, platforms: () => loaded.basePose })
    const registry = createRegistry([LOCOMOTION_DEF])
    const runtime = createComponentRuntime(loaded, registry, {
      character: characterAccess(char),
      effects: noEffects(),
      player: {
        id: 'player',
        components: opts.attach ? [comp('loco', 'Locomotion')] : [],
        defs: [def],
      },
    })
    runtime.attach(0, 0, TICK_DT)
    /** One host tick, in the host's order: platforms, half-step, movement slot, half-step. */
    const tick = (cmd: InputCommand, n = 1): void => {
      const half = TICK_DT / 2
      loaded.update(n * TICK_DT * 1000)
      world.step(half)
      runtime.locomote(n, n * TICK_DT * 1000, TICK_DT, cmd)
      world.step(half)
    }
    return { world, char, runtime, tick }
  }

  it('moves the character it was bound to', () => {
    const { world, char, tick } = scene()
    for (let n = 1; n <= 20; n++) tick(EAST, n)
    expect(char.body.translation().x).toBeGreaterThan(1)
    world.free()
  })

  /** A game that attaches no locomotion does not move. Honest: there is nothing to ask. */
  it('does nothing when a game attaches none', () => {
    const { world, char, tick } = scene({ attach: false })
    for (let n = 1; n <= 20; n++) tick(EAST, n)
    expect(char.body.translation().x).toBeCloseTo(0, 6)
    world.free()
  })

  /**
   * The game's tuning, through the deps, not a default. One source — the object a debug pane is bound to —
   * which is why this component deliberately has no parameters of its own.
   */
  it('runs at the game its own tuning', () => {
    const slow = { ...DEFAULT_TUNING, moveSpeed: 1 }
    const fast = { ...DEFAULT_TUNING, moveSpeed: 10 }
    const run = (tuning: typeof DEFAULT_TUNING): number => {
      const { world, char, tick } = scene({ attach: true, tuning })
      for (let n = 1; n <= 20; n++) tick(EAST, n)
      const x = char.body.translation().x
      world.free()
      return x
    }
    expect(run(fast)).toBeGreaterThan(run(slow) * 2)
  })

  /** A live getter, so changing the object mid-session is followed rather than snapshotted at attach. */
  it('reads the tuning fresh each tick', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateLevel(world, levelOf([floor()]), createRegistry([]))
    const char = addCharacter(world, vec3(0, STAND + 0.02, 0))
    const tuning = { ...DEFAULT_TUNING, moveSpeed: 0 }
    const runtime = createComponentRuntime(loaded, createRegistry([LOCOMOTION_DEF]), {
      character: characterAccess(char),
      effects: noEffects(),
      player: {
        id: 'player',
        components: [comp('loco', 'Locomotion')],
        defs: [createLocomotion({ character: () => char, tuning: () => tuning })],
      },
    })
    runtime.attach(0, 0, TICK_DT)
    const tick = (n: number): void => {
      world.step(TICK_DT / 2)
      runtime.locomote(n, 0, TICK_DT, EAST)
      world.step(TICK_DT / 2)
    }
    for (let n = 1; n <= 10; n++) tick(n)
    expect(char.body.translation().x).toBeCloseTo(0, 6)

    tuning.moveSpeed = 8
    for (let n = 11; n <= 30; n++) tick(n)
    expect(char.body.translation().x).toBeGreaterThan(1)
    world.free()
  })

  /** `fixedUpdate` is a different moment, and locomotion must not be in it. */
  it('does not run in the general fixed-update sweep', () => {
    const { world, char, runtime } = scene()
    for (let n = 1; n <= 20; n++) {
      runtime.fixedUpdate(n, 0, TICK_DT)
      world.step(TICK_DT)
    }
    expect(char.body.translation().x).toBeCloseTo(0, 6)
    world.free()
  })

  /** The registry's copy has nothing bound, so a tool can hold it without a character existing. */
  it('has an inert definition for a registry', () => {
    expect(LOCOMOTION_DEF.type).toBe('Locomotion')
    expect(LOCOMOTION_DEF.attachesTo).toBe('player')
    expect(LOCOMOTION_DEF.singleton).toBe(true)
    expect(() => LOCOMOTION_DEF.hooks?.onLocomote?.({} as never, { dt: TICK_DT } as never, STILL)).not.toThrow()
  })

  /** A game names its own, so two games' locomotion are two things rather than one name twice. */
  it('can be named by the game', () => {
    const def = createLocomotion({ character: () => null, tuning: () => DEFAULT_TUNING }, 'SwingLocomotion')
    expect(def.type).toBe('SwingLocomotion')
  })
})

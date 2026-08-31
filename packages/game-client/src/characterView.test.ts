import { entityId, vec3, type EntityId } from '@mp/core'
import { createAnimator, DEFAULT_GAIT, PART_NAMES, restPose, type Animator, type AnimatorFactory, type GaitTuning, type Pose } from '@mp/humanoid'
import { THREE } from '@mp/render-three'
import { describe, expect, it } from 'vitest'

import { createCharacterViews, type CharacterPlacement } from './characterView'

/**
 * The animator seam (ADR 0063).
 *
 * The gait's own behaviour is tested in `@mp/humanoid`; what matters here is that a game can **replace** it.
 * Before this, `createCharacterViews` called `createAnimator` directly, so every game on the platform animated
 * identically and a game with movement of its own had no way to show it.
 *
 * Headless: the rig is Three meshes, which need no WebGL context to build or pose.
 */

const scene = (): THREE.Scene => new THREE.Scene()

/**
 * A whole `CharacterPlacement`, with the derived fields left `null` — which is how a *peer* arrives, so the
 * view derives speed and facing from movement. The values do not matter here; what is under test is which
 * animator receives them.
 */
const placement = (position = vec3(0, 1, 0), states: ReadonlySet<string> | null = null): CharacterPlacement => ({
  isSelf: true,
  position,
  yaw: null,
  speed: null,
  vy: null,
  grounded: true,
  rising: false,
  carry: null,
  base: 0,
  name: 'test',
  states,
})

describe('the animator a game supplies', () => {
  it('is used instead of the shared gait', () => {
    const built: number[] = []
    const flat: Pose = restPose()
    const mine: AnimatorFactory = (_gait, seed) => {
      built.push(seed)
      return { step: () => flat }
    }
    const views = createCharacterViews(scene(), { ...DEFAULT_GAIT }, mine)
    const id = entityId(7)
    views.upsert(id, placement(), 1 / 60)

    expect(built).toHaveLength(1)
    // The pose the view reports is the one this animator returned, not one the shared cycle produced.
    expect(views.poseOf(id)).toBe(flat)
  })

  /** One animator per character, seeded per id — what stops two players rolling the same steps. */
  it('is built once per character, with a different seed each', () => {
    const seeds: number[] = []
    const mine: AnimatorFactory = (_gait, seed) => {
      seeds.push(seed)
      return { step: () => restPose() }
    }
    const views = createCharacterViews(scene(), { ...DEFAULT_GAIT }, mine)
    for (const n of [1, 2, 3]) views.upsert(entityId(n), placement(), 1 / 60)
    // Called again for one that already exists — the animator is not rebuilt.
    views.upsert(entityId(1), placement(), 1 / 60)

    expect(seeds).toHaveLength(3)
    expect(new Set(seeds).size).toBe(3)
  })

  it('is handed the gait the host is holding, so the pane still retunes it live', () => {
    let seen: GaitTuning | null = null
    const gait: GaitTuning = { ...DEFAULT_GAIT }
    const mine: AnimatorFactory = (g) => {
      seen = g
      return { step: () => restPose() }
    }
    createCharacterViews(scene(), gait, mine).upsert(entityId(1), placement(), 1 / 60)
    expect(seen).toBe(gait)
  })

  /**
   * The expected shape for a game adding a state of its own: wrap the shared cycle and override the pose while
   * that state is active. It reads the state by **closure**, which is why nothing had to be added to
   * `AnimationInput` — the game supplies the factory, so it already has access to its own things.
   */
  it('can wrap the shared gait and override it for a state the platform never heard of', () => {
    let dashing = false
    const tucked: Pose = restPose()
    const mine: AnimatorFactory = (gait, seed) => {
      const shared = createAnimator(gait, seed)
      return {
        step: (input, dt) => {
          const pose = shared.step(input, dt)
          return dashing ? tucked : pose
        },
      }
    }
    const views = createCharacterViews(scene(), { ...DEFAULT_GAIT }, mine)
    const id: EntityId = entityId(1)

    views.upsert(id, placement(), 1 / 60)
    const running = views.poseOf(id)
    expect(running).not.toBe(tucked)

    dashing = true
    views.upsert(id, placement(vec3(0.2, 1, 0)), 1 / 60)
    expect(views.poseOf(id)).toBe(tucked)
  })

  /** Absent, it is the shared procedural gait — which is every game today. */
  it('defaults to the shared gait', () => {
    const views = createCharacterViews(scene(), { ...DEFAULT_GAIT })
    const id = entityId(1)
    views.upsert(id, placement(), 1 / 60)
    const pose = views.poseOf(id)
    expect(pose).not.toBeNull()
    // A real pose the cycle wrote: every joint has a rotation, and it is not the object `restPose` returns.
    expect(Object.keys(pose!.rotation)).toHaveLength(PART_NAMES.length)
    expect(pose).not.toBe(restPose())
  })
})

/** A default animator is still exactly `createAnimator`, so the fallback is not a second implementation. */
describe('the default', () => {
  it('is the shared gait itself, not a copy of it', () => {
    const a: Animator = createAnimator({ ...DEFAULT_GAIT }, 1)
    expect(typeof a.step).toBe('function')
  })
})

/**
 * A peer's game states reaching the animator (ADR 0064).
 *
 * The local player's states come from a closure over the game's own component (ADR 0063), which cannot answer
 * for anybody else — a peer's arrive as bits on the wire, and the host hands the animator a reader for them.
 * One animator body then covers both, which is the property these check.
 */
describe('the states an animator is handed', () => {
  it('is empty for a game that declared none', () => {
    const seen: ReadonlySet<string>[] = []
    const mine: AnimatorFactory = (_gait, _seed, states) => ({
      step: () => {
        seen.push(states())
        return restPose()
      },
    })
    const views = createCharacterViews(scene(), { ...DEFAULT_GAIT }, mine)
    views.upsert(entityId(1), placement(), 1 / 60)
    expect([...seen[0]!]).toEqual([])
  })

  it('reports whatever the host wrote for that character, live', () => {
    const seen: string[][] = []
    const mine: AnimatorFactory = (_gait, _seed, states) => ({
      step: () => {
        seen.push([...states()].sort())
        return restPose()
      },
    })
    const views = createCharacterViews(scene(), { ...DEFAULT_GAIT }, mine)
    const id = entityId(1)

    views.upsert(id, placement(vec3(0, 1, 0), new Set(['dash'])), 1 / 60)
    views.upsert(id, placement(vec3(0, 1, 0), new Set(['dash', 'glide'])), 1 / 60)
    // Cleared, not sticky: a state that stops being sent stops being animated.
    views.upsert(id, placement(vec3(0, 1, 0), null), 1 / 60)

    expect(seen).toEqual([['dash'], ['dash', 'glide'], []])
  })

  /** Per character, so one peer dashing does not put everybody in a dash pose. */
  it('is not shared between characters', () => {
    const seen = new Map<number, string[]>()
    const mine: AnimatorFactory = (_gait, seed, states) => ({
      step: () => {
        seen.set(seed, [...states()])
        return restPose()
      },
    })
    const views = createCharacterViews(scene(), { ...DEFAULT_GAIT }, mine)
    views.upsert(entityId(1), placement(vec3(0, 1, 0), new Set(['dash'])), 1 / 60)
    views.upsert(entityId(2), placement(vec3(0, 1, 0), null), 1 / 60)

    const [a, b] = [...seen.values()]
    expect(a).toEqual(['dash'])
    expect(b).toEqual([])
  })
})

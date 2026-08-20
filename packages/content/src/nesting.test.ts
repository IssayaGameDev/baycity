import { vec3, type Vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics, type PhysicsWorld } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { instantiateLegacyLevel } from './loader'
import { moveTrack, spinTrack } from './track'
import type { Behavior, Level, PrefabInstance, Prefab } from './types'

/**
 * Nested placement: a child instance is posed against its parent's *animated* pose, to any depth. This is
 * what lets motion compose — a bar spinning on a moving deck — which no single behaviour can express.
 */
const T = 4000

/** A one-piece prefab, optionally a trigger so its collider handle is findable from outside. */
const box = (id: string, half = vec3(1, 0.5, 1), trigger = false): Prefab => ({
  id,
  pieces: [
    {
      collider: { kind: 'box', halfExtents: half },
      transform: { position: vec3(0, 0, 0) },
      ...(trigger ? { trigger: { kind: 'goal' as const } } : {}),
    },
  ],
})

/**
 * The old `move`/`rotate` behaviors as the keyframe tracks that replaced them (ADR 0029). The presets
 * reproduce them exactly, so every assertion below is unchanged — which is the point of running these
 * fixtures through the new evaluator rather than rewriting the expectations.
 *
 * A track's keys are **absolute local poses**, so an animated frame away from the origin has to say where it
 * starts. Defaulted, because every fixture here but one places it at the origin.
 */
const moves = (axis: Vec3, distance: number, base: Vec3 = vec3(0, 0, 0)): Behavior => ({
  kind: 'track',
  keys: moveTrack(base, axis, distance, T),
  loop: 'loop',
})
const spins = (axis: Vec3, base: Vec3 = vec3(0, 0, 0)): Behavior => ({
  kind: 'track',
  keys: spinTrack(base, axis, T),
  loop: 'loop',
})

const levelOf = (instances: PrefabInstance[]): Level => ({
  id: 'nest',
  config: { fallBehavior: 'physical-fall', fallY: -100 },
  instances,
})

const near = (got: Vec3, want: Vec3, why: string, digits = 5): void => {
  expect(got.x, `${why} (x)`).toBeCloseTo(want.x, digits)
  expect(got.y, `${why} (y)`).toBeCloseTo(want.y, digits)
  expect(got.z, `${why} (z)`).toBeCloseTo(want.z, digits)
}

describe('nested placement', () => {
  let world: PhysicsWorld

  beforeAll(async () => {
    await initPhysics()
  })

  const load = (instances: PrefabInstance[]): ReturnType<typeof instantiateLegacyLevel> => {
    world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    return instantiateLegacyLevel(world, levelOf(instances))
  }

  it('places a child against its parent, rotation and all', () => {
    // Parent turned a quarter turn about +y, so the child's local +x points along world −z.
    const loaded = load([
      {
        prefab: box('parent'),
        transform: { position: vec3(10, 0, 0), rotation: vec3(0, Math.PI / 2, 0) },
        children: [{ prefab: box('child'), transform: { position: vec3(2, 0, 0) } }],
      },
    ])
    expect(loaded.visuals, 'a piece each').toHaveLength(2)
    near(loaded.visuals[0]!.position, vec3(10, 0, 0), 'parent')
    near(loaded.visuals[1]!.position, vec3(10, 0, -2), "child's local +x is the parent's, not the world's")
    world.free()
  })

  it('composes to arbitrary depth', () => {
    const loaded = load([
      {
        prefab: box('a'),
        transform: { position: vec3(1, 0, 0) },
        children: [
          {
            prefab: box('b'),
            transform: { position: vec3(2, 0, 0) },
            children: [{ prefab: box('c'), transform: { position: vec3(4, 0, 0) } }],
          },
        ],
      },
    ])
    near(loaded.visuals[2]!.position, vec3(7, 0, 0), 'three levels add up')
    world.free()
  })

  it('accumulates scale down the chain, into offsets and collider dimensions', () => {
    const loaded = load([
      {
        prefab: box('parent', vec3(1, 1, 1)),
        transform: { position: vec3(0, 0, 0), scale: vec3(2, 2, 2) },
        children: [{ prefab: box('child', vec3(1, 1, 1)), transform: { position: vec3(3, 0, 0) } }],
      },
    ])
    near(loaded.visuals[1]!.position, vec3(6, 0, 0), "the parent's scale scales the child's offset")
    expect(loaded.visuals[1]!.collider).toEqual({ kind: 'box', halfExtents: vec3(2, 2, 2) })
    world.free()
  })

  it('carries a static child along with a moving parent', () => {
    const loaded = load([
      {
        prefab: box('deck'),
        transform: { position: vec3(0, 0, 0) },
        behavior: moves(vec3(1, 0, 0), 8),
        children: [{ prefab: box('crate'), transform: { position: vec3(0, 1, 0) } }],
      },
    ])
    // Half a period is full travel: (1 − cos π)/2 = 1.
    loaded.update(T / 2)
    near(loaded.visuals[0]!.position, vec3(8, 0, 0), 'deck at full travel')
    near(loaded.visuals[1]!.position, vec3(8, 1, 0), 'crate came with it')
    world.free()
  })

  it('orbits a static child around a rotating parent', () => {
    const loaded = load([
      {
        prefab: box('turntable'),
        transform: { position: vec3(0, 0, 0) },
        behavior: spins(vec3(0, 1, 0)),
        children: [{ prefab: box('rider'), transform: { position: vec3(3, 0, 0) } }],
      },
    ])
    loaded.update(T / 4) // a quarter turn
    near(loaded.visuals[1]!.position, vec3(0, 0, -3), 'the child moved although it has no behaviour')
    world.free()
  })

  it('composes both motions at once — the case the old flat loader could not express', () => {
    const loaded = load([
      {
        prefab: box('deck'),
        transform: { position: vec3(0, 0, 0) },
        behavior: moves(vec3(1, 0, 0), 8),
        children: [{ prefab: box('bar'), transform: { position: vec3(0, 1, 0) }, behavior: spins(vec3(0, 1, 0)) }],
      },
    ])
    loaded.update(T / 2)
    near(loaded.visuals[1]!.position, vec3(8, 1, 0), 'rode the deck')
    // Half a period of spin is a half turn: the quaternion for π about +y is (0, 1, 0, 0).
    const q = loaded.visuals[1]!.rotation
    expect(Math.abs(q.y), 'and spun a half turn while riding').toBeCloseTo(1, 5)
    expect(Math.abs(q.w)).toBeCloseTo(0, 5)
    world.free()
  })

  it("reads a child's move axis in the parent's frame", () => {
    const loaded = load([
      {
        prefab: box('parent'),
        transform: { position: vec3(0, 0, 0), rotation: vec3(0, Math.PI / 2, 0) },
        children: [{ prefab: box('slider'), transform: { position: vec3(0, 0, 0) }, behavior: moves(vec3(1, 0, 0), 4) }],
      },
    ])
    loaded.update(T / 2)
    near(loaded.visuals[1]!.position, vec3(0, 0, -4), 'travelled along the parent\'s +x, which is world −z')
    world.free()
  })

  it('makes a static piece under a moving ancestor a movement base', () => {
    // The correctness point: it is not moving under its own steam, but it *is* moving in the world, so it
    // needs a kinematic body and a base index — otherwise a rider on it is never carried.
    const loaded = load([
      {
        prefab: box('deck'),
        transform: { position: vec3(0, 0, 0) },
        behavior: moves(vec3(1, 0, 0), 8),
        children: [{ prefab: box('crate', vec3(1, 0.5, 1), true), transform: { position: vec3(0, 1, 0) } }],
      },
    ])
    const crate = loaded.triggers.find((t) => t.kind === 'goal')!
    const index = loaded.baseIndex(crate.colliderHandle)
    expect(index, 'a static child of a mover is still something you can ride').toBeDefined()
    expect(loaded.basePose(crate.colliderHandle)).toBeDefined()
    world.free()
  })

  it('gives a rider on a nested piece the carry it inherits from above', () => {
    const loaded = load([
      {
        prefab: box('deck'),
        transform: { position: vec3(0, 0, 0) },
        behavior: moves(vec3(1, 0, 0), 8),
        children: [{ prefab: box('crate', vec3(1, 0.5, 1), true), transform: { position: vec3(0, 1, 0) } }],
      },
    ])
    const crate = loaded.triggers.find((t) => t.kind === 'goal')!
    const index = loaded.baseIndex(crate.colliderHandle)!

    // A quarter period in, the mover is at its fastest: distance·π/period.
    loaded.update(T / 4 - 5)
    loaded.update(T / 4 + 5)
    const carry = loaded.baseCarry(index, vec3(0, 0, 0))!
    expect(carry.x, "the parent's speed, inherited by a child with no behaviour of its own").toBeCloseTo(
      (8 * Math.PI) / (T / 1000),
      2,
    )
    expect(carry.z).toBeCloseTo(0, 6)
    world.free()
  })

  it('numbers movement bases depth-first, so every client agrees', () => {
    const loaded = load([
      {
        prefab: box('deck', vec3(1, 0.5, 1), true),
        transform: { position: vec3(0, 0, 0) },
        behavior: moves(vec3(1, 0, 0), 2),
        children: [{ prefab: box('bar', vec3(1, 0.5, 1), true), transform: { position: vec3(0, 1, 0) }, behavior: spins(vec3(0, 1, 0)) }],
      },
      {
        prefab: box('lift', vec3(1, 0.5, 1), true),
        transform: { position: vec3(20, 0, 0) },
        behavior: moves(vec3(0, 1, 0), 3, vec3(20, 0, 0)),
      },
    ])
    // Creation order is: deck's piece, then its child's piece, then the next top-level instance's.
    const indices = loaded.triggers.map((t) => loaded.baseIndex(t.colliderHandle))
    expect(indices).toEqual([0, 1, 2])
    world.free()
  })

  it('leaves a fully static subtree out of the movers entirely', () => {
    const loaded = load([
      {
        prefab: box('ground', vec3(1, 0.5, 1), true),
        transform: { position: vec3(0, 0, 0) },
        children: [{ prefab: box('kerb', vec3(1, 0.5, 1), true), transform: { position: vec3(0, 1, 0) } }],
      },
    ])
    for (const t of loaded.triggers) expect(loaded.baseIndex(t.colliderHandle), 'nothing moves, nothing to ride').toBeUndefined()
    world.free()
  })
})

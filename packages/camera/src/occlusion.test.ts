import type { Vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { occlusionFor, type Hit, type OcclusionQueries } from './occlusion'

/**
 * The decision, with the world faked as slabs along the boom. The boom runs +Z, 10 m long, so a slab is
 * just an interval of distance-from-the-target and the casts are trivially computable from it.
 *
 * One rule, and the negative case is the whole of it: the camera moves only where staying would put it
 * inside solid, because that is the near plane in geometry and a view through the back of the level
 * (ADR 0055).
 */
const BOOM: Vec3 = { x: 0, y: 0, z: 10 }
const LEN = 10
const TARGET: Vec3 = { x: 0, y: 0, z: 0 }

/**
 * A world of slabs, each `[near, far]` in metres from the target along the boom. A slab's index is its
 * collider handle, so what comes back names which slab was hit.
 */
const world = (...slabs: readonly [number, number][]): OcclusionQueries => ({
  cast: (origin, direction, maxDistance, skip) => {
    const outward = direction.z > 0
    const from = origin.z
    let best: Hit | undefined
    slabs.forEach(([near, far], handle) => {
      if (skip !== undefined && skip.includes(handle)) return
      // The face this sweep meets first, and how far away it is.
      const face = outward ? near : far
      const d = outward ? face - from : from - face
      if (d < 0 || d > maxDistance) return
      if (best === undefined || d < best.distance) best = { distance: d, colliderHandle: handle }
    })
    return best
  },
  occupied: (p) => slabs.some(([near, far]) => p.z > near && p.z < far),
})

const CLEAR = { occluders: [] }

describe('camera occlusion', () => {
  it('keeps the full boom with nothing in the way', () => {
    expect(occlusionFor(world(), TARGET, BOOM, LEN)).toEqual({ limit: 10, seeThrough: false, ...CLEAR })
  })

  it('sees through an obstruction and does not move', () => {
    expect(occlusionFor(world([4, 4.2]), TARGET, BOOM, LEN)).toEqual({ limit: 10, seeThrough: true, occluders: [0] })
  })

  /**
   * The case that deleted the thickness test this used to have. Standing under a wide platform with the
   * camera plainly above it is the ordinary setup, and it is exactly what a thickness allowance refused:
   * the platform is thick, so the camera moved, so the hole it had just cut was pointless.
   *
   * There is nothing for a thickness to protect against once the camera is known to be in open air, and
   * `occupied` already knows that. Gating on it also made the camera flip as it orbited, since a slab's
   * chord along the boom grows without bound as the crossing gets shallower.
   */
  it('sees through a thick one just the same, so long as the camera is in clear air', () => {
    expect(occlusionFor(world([4, 8]), TARGET, BOOM, LEN)).toEqual({ limit: 10, seeThrough: true, occluders: [0] })
  })

  /**
   * The one guarantee that survives from ADR 0020, and now the only reason the camera ever moves. Inside
   * the slab there is no distance to stay at: the near plane is in solid, and dithering the slab does not
   * help because you are looking at the level from inside it.
   */
  it('moves in when the camera itself would be inside solid', () => {
    expect(occlusionFor(world([9.9, 10.1]), TARGET, BOOM, LEN)).toEqual({ limit: 9.9, seeThrough: false, ...CLEAR })
  })

  it('moves in to where the sweep cleared, exactly as ADR 0020 did', () => {
    // Camera inside the far slab, so the limit is the *first* thing in the way, not the one it is inside.
    expect(occlusionFor(world([3, 3.5], [9.5, 11]), TARGET, BOOM, LEN).limit).toBe(3)
  })

  /**
   * Naming the surfaces is the whole reason the hole lands on the obstruction rather than on whatever
   * happens to lie in a volume — the floor beside the character's feet above all.
   */
  it('names every surface in the way, nearest first', () => {
    const both = occlusionFor(world([4, 4.1], [4.4, 4.5]), TARGET, BOOM, LEN)
    expect(both.seeThrough).toBe(true)
    expect(both.occluders).toEqual([0, 1])
  })

  it('stops at six surfaces, however many are stacked', () => {
    const many = world([1, 1.05], [1.2, 1.25], [1.4, 1.45], [1.6, 1.65], [1.8, 1.85], [2, 2.05], [2.2, 2.25])
    expect(occlusionFor(many, TARGET, BOOM, LEN).occluders).toHaveLength(6)
  })

  /**
   * One sightline is not a character. The camera aims near the head, so a platform lying across the body
   * with the head clear above it reports nothing in the way at all — which is what the extra probes down
   * the capsule are for.
   */
  it('finds what the boom misses but the body does not', () => {
    // Only a sweep starting below the aim point meets this one.
    const overTheBody: OcclusionQueries = {
      cast: (origin, _d, _m, skip) =>
        origin.y < 0 && !(skip ?? []).includes(3) ? { distance: 2, colliderHandle: 3 } : undefined,
      occupied: () => false,
    }
    expect(occlusionFor(overTheBody, TARGET, BOOM, LEN)).toEqual({ limit: 10, seeThrough: false, ...CLEAR })
    expect(occlusionFor(overTheBody, TARGET, BOOM, LEN, { probes: [{ x: 0, y: -1, z: 0 }] })).toEqual({
      limit: 10,
      seeThrough: true,
      occluders: [3],
    })
  })

  // The camera slides along the boom, so a probe's clearance is not a distance it could move to.
  it('takes the pull-in distance from the boom, never from a probe', () => {
    const q: OcclusionQueries = {
      cast: (origin, _d, _m, skip) => {
        const handle = origin.y < 0 ? 1 : 0
        return (skip ?? []).includes(handle) ? undefined : { distance: origin.y < 0 ? 1 : 4, colliderHandle: handle }
      },
      occupied: () => true,
    }
    expect(occlusionFor(q, TARGET, BOOM, LEN, { probes: [{ x: 0, y: -1, z: 0 }] }).limit).toBe(4)
  })

  it('asks nothing more once the forward sweep comes back clear', () => {
    let calls = 0
    const counted: OcclusionQueries = {
      cast: () => {
        calls++
        return undefined
      },
      occupied: () => {
        throw new Error('should not be asked')
      },
    }
    expect(occlusionFor(counted, TARGET, BOOM, LEN).seeThrough).toBe(false)
    expect(calls, 'one cast on the common frame').toBe(1)
  })
})

/**
 * Below the feet, nothing is see-through. Removing ADR 0020's pull-in removed what kept the camera out of
 * the ground, and a hole in the ground is a view of the level's underside.
 *
 * Three earlier answers were worse and are recorded so none is tried again. Keying on the collider the
 * character stands on collapses the camera into the head on the most common surface in the game. Clamping
 * how far the camera may pitch down freezes the orbit outright. Testing the *hit's* height against the feet
 * does nothing at all, because a sphere sweep stops its own radius short of what it meets, so a hit on the
 * floor underfoot reports a centre above the feet.
 *
 * A boom straight down from a character standing at the origin: feet at 0, aim 2 m up.
 */
describe('below the feet', () => {
  const AIM: Vec3 = { x: 0, y: 2, z: 0 }
  /** Straight down, long enough to put the camera at y = -5. */
  const DOWN: Vec3 = { x: 0, y: -7, z: 0 }
  /** Straight up, putting the camera at y = 9. */
  const UP: Vec3 = { x: 0, y: 7, z: 0 }

  /** One surface, `depth` metres along the boom. */
  const at = (depth: number): OcclusionQueries => ({
    cast: (_o, _d, _m, skip) => ((skip ?? []).includes(1) ? undefined : { distance: depth, colliderHandle: 1 }),
    occupied: () => false,
  })

  it('stops at what is in the way instead of holing it', () => {
    expect(occlusionFor(at(3), AIM, DOWN, 7, { feetY: 0 })).toEqual({ limit: 3, seeThrough: false, ...CLEAR })
  })

  it('holds the distance when the camera stays above the feet', () => {
    // The same obstruction, the same boom length, aimed up instead: scenery, and it gets the hole.
    expect(occlusionFor(at(3), AIM, UP, 7, { feetY: 0 })).toEqual({ limit: 7, seeThrough: true, occluders: [1] })
  })

  /**
   * The case a surface normal cannot answer, and the reason this is about the camera and not the surface: a
   * platform's top face points up whether it is under your feet or over your head.
   */
  it('holes a platform overhead, whose top face points up exactly like the ground does', () => {
    expect(occlusionFor(at(2), AIM, UP, 7, { feetY: 0 }).seeThrough).toBe(true)
  })

  it('keeps the full boom below the feet when nothing is in the way at all', () => {
    const clear: OcclusionQueries = { cast: () => undefined, occupied: () => false }
    expect(occlusionFor(clear, AIM, DOWN, 7, { feetY: 0 })).toEqual({ limit: 7, seeThrough: false, ...CLEAR })
  })

  it('goes anywhere when no feet are given', () => {
    expect(occlusionFor(at(3), AIM, DOWN, 7).seeThrough).toBe(true)
  })

  // The boundary is the camera's own height, so it is reached at a predictable pitch rather than depending
  // on what the sweep happened to graze.
  it('switches at the height of the feet, not at the height of the hit', () => {
    // Camera at y = -0.001: below. At y = +0.001: above.
    expect(occlusionFor(at(3), AIM, { x: 0, y: -2.001, z: 0 }, 2.001, { feetY: 0 }).seeThrough).toBe(false)
    expect(occlusionFor(at(1), AIM, { x: 0, y: -1.999, z: 0 }, 1.999, { feetY: 0 }).seeThrough).toBe(true)
  })
})

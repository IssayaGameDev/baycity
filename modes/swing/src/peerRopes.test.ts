import { entityId, vec3, type Vec3 } from '@mp/core'
import type { PhysicsBody, PhysicsWorld } from '@mp/physics'
import type { Peer } from '@mp/tps'
import { describe, expect, it } from 'vitest'

import { createPeerRopes } from './peerRopes'
import { DEFAULT_ROPE } from './rope'
import { SWINGING_STATE } from './swing'

/**
 * Other players' ropes, worked out locally (ADR 0068).
 *
 * The behaviour worth testing is the **latch**, not the geometry: searching once on the rising edge gives a
 * fixed anchor, and searching every frame would give one that wandered away from them as they swung. That is
 * the difference between a rope and a laser pointer, and it is invisible until two people are in a room.
 */

const T = DEFAULT_ROPE
const A = entityId(1)
const B = entityId(2)

const peer = (id: typeof A, swinging: boolean, position: Vec3 = vec3(0, 1, 0), yaw = 0): Peer => ({
  id,
  position,
  yaw,
  states: swinging ? new Set([SWINGING_STATE]) : new Set(),
})

/**
 * A world where every cast hits something 10 m along the ray, and which counts the casts.
 *
 * The count is the point: a latch that re-searched would show up as casts on every frame instead of one.
 */
const fakeWorld = (): PhysicsWorld & { casts: number } => {
  const w = {
    casts: 0,
    castSphere: (): { distance: number; colliderHandle: number } => {
      w.casts += 1
      return { distance: 10, colliderHandle: 1 }
    },
    addDynamicBody: (): PhysicsBody => ({}) as PhysicsBody,
  }
  return w as unknown as PhysicsWorld & { casts: number }
}

/** A world where nothing is ever hit. */
const emptyWorld = (): PhysicsWorld => ({ castSphere: () => undefined }) as unknown as PhysicsWorld

describe('a peer swinging', () => {
  it('gets an anchor on the frame the bit turns on', () => {
    const ropes = createPeerRopes()
    const world = fakeWorld()

    ropes.update([peer(A, false)], world, T)
    expect(ropes.ropeOf(A)).toBeUndefined()

    ropes.update([peer(A, true)], world, T)
    expect(ropes.ropeOf(A)).toBeDefined()
    expect(ropes.holders()).toEqual([A])
  })

  /** The whole reason this file exists. */
  it('keeps the same anchor while they swing away from it', () => {
    const ropes = createPeerRopes()
    const world = fakeWorld()

    ropes.update([peer(A, true, vec3(0, 1, 0))], world, T)
    const first = ropes.ropeOf(A)
    const castsAfterGrab = world.casts

    // Three more frames, each with them somewhere else — which is what swinging is.
    ropes.update([peer(A, true, vec3(1, 2, 1))], world, T)
    ropes.update([peer(A, true, vec3(3, 4, 2))], world, T)
    ropes.update([peer(A, true, vec3(5, 3, 4))], world, T)

    // Same rope object, and not one extra cast: it was latched, not re-derived.
    expect(ropes.ropeOf(A)).toBe(first)
    expect(world.casts).toBe(castsAfterGrab)
  })

  it('lets go when the bit turns off, and re-grabs fresh after', () => {
    const ropes = createPeerRopes()
    const world = fakeWorld()

    ropes.update([peer(A, true)], world, T)
    const first = ropes.ropeOf(A)
    ropes.update([peer(A, false)], world, T)
    expect(ropes.ropeOf(A)).toBeUndefined()

    ropes.update([peer(A, true, vec3(9, 1, 9))], world, T)
    const second = ropes.ropeOf(A)
    expect(second).toBeDefined()
    // A new search, not the old anchor handed back.
    expect(second).not.toBe(first)
  })

  it('draws nothing when the search finds nothing', () => {
    const ropes = createPeerRopes()
    ropes.update([peer(A, true)], emptyWorld(), T)
    // They still swing; there is just no line, which beats a line to a guess.
    expect(ropes.ropeOf(A)).toBeUndefined()
    expect(ropes.holders()).toEqual([])
  })

  it('waits for a world', () => {
    const ropes = createPeerRopes()
    ropes.update([peer(A, true)], null, T)
    expect(ropes.ropeOf(A)).toBeUndefined()
  })

  it('forgets whoever left the room mid-swing', () => {
    const ropes = createPeerRopes()
    const world = fakeWorld()

    ropes.update([peer(A, true), peer(B, true)], world, T)
    expect(ropes.holders()).toHaveLength(2)

    ropes.update([peer(B, true)], world, T)
    expect(ropes.ropeOf(A)).toBeUndefined()
    expect(ropes.holders()).toEqual([B])
  })

  it('holds one rope per player', () => {
    const ropes = createPeerRopes()
    const world = fakeWorld()
    ropes.update([peer(A, true, vec3(0, 1, 0)), peer(B, true, vec3(20, 1, 0))], world, T)

    const a = ropes.ropeOf(A)
    const b = ropes.ropeOf(B)
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a!.anchor).not.toEqual(b!.anchor)
  })

  /** The rest length is what the spring would be measured against, so it has to be the length at the grab. */
  it('measures the rope from their shoulder to the anchor', () => {
    const ropes = createPeerRopes()
    ropes.update([peer(A, true)], fakeWorld(), T)
    const rope = ropes.ropeOf(A)
    expect(rope).toBeDefined()
    // The fake hits at 10 m along whichever ray, so the rest length is that.
    expect(rope!.restLength).toBeCloseTo(10, 4)
  })
})

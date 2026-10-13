import { vec3 } from '@mp/core'
import { THREE } from '@mp/render-three'
import { describe, expect, it } from 'vitest'

import { CAMERA_TUNABLES, DEFAULT_CAMERA_PARAMS, createOrbitCamera, type OcclusionQueries } from './index'

/**
 * The tunables are data so this package never learns what a Tweakpane is, and the price of that is a list
 * that can drift from the parameters it names. This is the guard.
 */
describe('the tunables', () => {
  it('names only real parameters', () => {
    for (const t of CAMERA_TUNABLES) {
      expect(DEFAULT_CAMERA_PARAMS, t.key).toHaveProperty(t.key)
      expect(typeof DEFAULT_CAMERA_PARAMS[t.key], t.key).toBe('number')
    }
  })

  it('names each one once', () => {
    const keys = CAMERA_TUNABLES.map((t) => t.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('brackets every default inside its own range', () => {
    for (const t of CAMERA_TUNABLES) {
      const value = DEFAULT_CAMERA_PARAMS[t.key]
      expect(value, `${t.key} starts outside its slider`).toBeGreaterThanOrEqual(t.min)
      expect(value, `${t.key} starts outside its slider`).toBeLessThanOrEqual(t.max)
    }
  })

  // `camZoom` is the live value, moved by the wheel rather than by a slider, and its range is two other
  // tunables. A slider for it would fight the wheel.
  it('leaves the zoom itself off the list', () => {
    expect(CAMERA_TUNABLES.map((t) => t.key)).not.toContain('camZoom')
  })
})

/**
 * The camera collides unless the level says it may see through (ADR 0148). A wall 3 m along every sightline,
 * and the eases off, so one frame lands where it is going.
 */
describe('seeing through', () => {
  const BODY = vec3(0, 1, 0)
  /** The aim point: a metre above the capsule's centre. */
  const AIM = new THREE.Vector3(0, 2, 0)
  const WALL = 7
  const wall: OcclusionQueries = {
    cast: (_o, _d, _m, skip) => ((skip ?? []).includes(WALL) ? undefined : { distance: 3, colliderHandle: WALL }),
    occupied: () => false,
  }
  const frame = (seeThrough?: boolean): { distance: number; holed: readonly number[] } => {
    const three = new THREE.PerspectiveCamera(60, 1, 0.1, 1000)
    const orbit = createOrbitCamera(three, {
      params: {
        camZoomSmooth: 0,
        camPushInSmooth: 0,
        camReturnSmooth: 0,
        landKick: 0,
        ...(seeThrough === undefined ? {} : { camSeeThrough: seeThrough }),
      },
    })
    orbit.observe(wall)
    let holed: readonly number[] = []
    orbit.update(1 / 60, BODY, (handles) => {
      holed = handles
    })
    return { distance: three.position.distanceTo(AIM), holed }
  }

  it('stops at the wall by default, and holes nothing', () => {
    const { distance, holed } = frame()
    expect(distance).toBeCloseTo(3, 6)
    expect(holed).toEqual([])
  })

  it('keeps its distance and holes the wall when the level sees through', () => {
    const { distance, holed } = frame(true)
    expect(distance).toBeGreaterThan(6)
    expect(holed).toEqual([WALL])
  })
})

/** A dead player's head, lying on the floor away from the capsule (ADR 0209). */
describe('a focus', () => {
  const BODY = vec3(0, 1, 0)
  const HEAD = vec3(4, 0.15, -2)
  /** Every point a sightline was cast from, with the eases and the lookahead off. */
  const castFrom = (focus?: typeof HEAD): { three: THREE.PerspectiveCamera; from: { y: number }[] } => {
    const three = new THREE.PerspectiveCamera(60, 1, 0.1, 1000)
    const orbit = createOrbitCamera(three, {
      params: { camZoomSmooth: 0, camPushInSmooth: 0, camReturnSmooth: 0, landKick: 0, camLookahead: 0, camSeeThrough: true },
    })
    const from: { y: number }[] = []
    orbit.observe({
      cast: (origin) => {
        from.push({ y: origin.y })
        return undefined
      },
      occupied: () => false,
    })
    orbit.update(1 / 60, BODY, () => {}, focus)
    return { three, from }
  }

  it('is what the camera aims at, not the capsule', () => {
    const { three } = castFrom(HEAD)
    const wanted = new THREE.Vector3(HEAD.x, HEAD.y, HEAD.z).sub(three.position).normalize()
    const got = three.getWorldDirection(new THREE.Vector3())
    expect(got.x).toBeCloseTo(wanted.x, 4)
    expect(got.y).toBeCloseTo(wanted.y, 4)
    expect(got.z).toBeCloseTo(wanted.z, 4)
  })

  it('is the only sightline kept clear — none down a body, which would start under the floor', () => {
    expect(castFrom().from.some((o) => o.y < BODY.y + 1 - 1e-6), 'alive, the body is probed below the aim').toBe(true)
    const { from } = castFrom(HEAD)
    expect(from.length).toBeGreaterThan(0)
    for (const o of from) expect(o.y).toBeCloseTo(HEAD.y, 6)
  })
})

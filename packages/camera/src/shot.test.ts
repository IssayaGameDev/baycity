import { vec3 } from '@mp/core'
import { THREE } from '@mp/render-three'
import { describe, expect, it } from 'vitest'

import { createOrbitCamera } from './orbit'

/**
 * The authored eye — `shot` (ADR 0060).
 *
 * Testable with no physics because `observe` is never called: the camera treats absent queries as an empty
 * world, which is exactly the case these want. What is checked is the geometry, since the whole feature is
 * "the eye is *there* and it is still looking at the character".
 */

const BODY = vec3(0, 1, 0)

/** A camera with the eases switched off, so one `update` lands where it is going instead of part way. */
const instant = () => {
  const three = new THREE.PerspectiveCamera(60, 1, 0.1, 1000)
  const orbit = createOrbitCamera(three, {
    params: { shotSmooth: 0, camZoomSmooth: 0, camPushInSmooth: 0, camReturnSmooth: 0, landKick: 0 },
  })
  const step = (): void => void orbit.update(1 / 60, BODY, () => {})
  return { three, orbit, step }
}

/** Where the camera is looking, as a unit vector. */
const forward = (c: THREE.PerspectiveCamera): THREE.Vector3 => c.getWorldDirection(new THREE.Vector3())

describe('an authored eye', () => {
  it('orbits behind the character when no shot is held', () => {
    const { three, step } = instant()
    step()
    // Default yaw is 0, which puts the boom on +Z, and the default zoom is 7 m out.
    expect(three.position.z).toBeGreaterThan(3)
    expect(Math.abs(three.position.x)).toBeLessThan(1e-6)
  })

  it('puts the eye exactly where it was told', () => {
    const { three, orbit, step } = instant()
    const eye = vec3(-9, 4, 2)
    orbit.shot(eye)
    step()
    expect(three.position.x).toBeCloseTo(eye.x, 4)
    expect(three.position.y).toBeCloseTo(eye.y, 4)
    expect(three.position.z).toBeCloseTo(eye.z, 4)
  })

  /** A shot that does not look at the player is not a shot. */
  it('still looks at the character from there', () => {
    const { three, orbit, step } = instant()
    orbit.shot(vec3(-9, 4, 2))
    step()
    // The aim point sits a metre above the capsule's centre, which is where the boom aims too.
    const aim = new THREE.Vector3(BODY.x, BODY.y + 1, BODY.z)
    const wanted = aim.sub(three.position).normalize()
    const got = forward(three)
    expect(got.x).toBeCloseTo(wanted.x, 4)
    expect(got.y).toBeCloseTo(wanted.y, 4)
    expect(got.z).toBeCloseTo(wanted.z, 4)
  })

  /**
   * Released, it is back on the boom — but on the boom *as the shot left it*, not back where the mouse had
   * been. That is the handover below working: the eye ends up at zoom distance on the shot's side, rather
   * than at the authored 9.8 m out.
   */
  it('goes back to the boom when the shot is released', () => {
    const { three, orbit, step } = instant()
    const eye = vec3(-9, 4, 2)
    orbit.shot(eye)
    step()
    orbit.shot(null)
    step()

    const aim = new THREE.Vector3(BODY.x, BODY.y + 1, BODY.z)
    const away = three.position.distanceTo(aim)
    // The boom is the 7 m default zoom, give or take its half-metre rise. The shot was 9.8 m out.
    expect(away).toBeGreaterThan(6)
    expect(away).toBeLessThan(8)
    // Same side it was watching from, which is the continuity the handover buys.
    expect(three.position.x).toBeLessThan(0)
  })

  /**
   * The handover: the orbit's yaw follows the shot's direction while it is held, so letting go resumes from
   * where the shot was looking rather than snapping back to whatever the mouse had been doing.
   */
  it('hands the orbit back pointing where the shot pointed', () => {
    const { orbit, step } = instant()
    expect(orbit.yaw()).toBeCloseTo(0, 6)
    // Straight out along +X, so the eye→target direction is -X and the yaw is a quarter turn from +Z.
    orbit.shot(vec3(10, 1, 0))
    step()
    expect(orbit.yaw()).toBeCloseTo(Math.PI / 2, 4)
    orbit.shot(null)
    step()
    // Released, and the orbit kept the angle rather than reverting to 0.
    expect(orbit.yaw()).toBeCloseTo(Math.PI / 2, 4)
  })

  /** Mouse look is overridden while a shot is held — that is the point of one. */
  it('ignores mouse look while held', () => {
    const { three, orbit, step } = instant()
    const eye = vec3(0, 3, -8)
    orbit.shot(eye)
    step()
    orbit.lookMouse(400, 0)
    step()
    expect(three.position.x).toBeCloseTo(eye.x, 4)
    expect(three.position.z).toBeCloseTo(eye.z, 4)
  })

  /** With the ease on, it is a move rather than a cut: one frame gets part of the way, not all of it. */
  it('eases in rather than cutting', () => {
    const three = new THREE.PerspectiveCamera(60, 1, 0.1, 1000)
    const orbit = createOrbitCamera(three, { params: { shotSmooth: 0.25, camZoomSmooth: 0, landKick: 0 } })
    orbit.shot(vec3(-9, 4, 2))
    orbit.update(1 / 60, BODY, () => {})
    expect(three.position.x).toBeGreaterThan(-9)
    expect(three.position.x).toBeLessThan(0)
  })
})

import { AT_REST_POSE, combineSequences, type SequenceAxes, type Stage, type Step } from '@mp/content'
import { eulerToQuat, rotateVec3, vec3, type Quat, type Vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { pointToWorld, routeSteps, worldToPoint, type PointFrame } from './sequencePoints'

/**
 * A move point in the viewport (ADR 0144) is where the game puts the target, so the conversion is checked
 * against the game's own rule: `combineSequences` framing the point, then the frame tree composing it
 * (`loader.ts`: `world = parent + parentRot · (parentScale ⊙ local)`).
 */

const expectVec = (got: Vec3, want: Vec3): void => {
  expect(got.x).toBeCloseTo(want.x, 9)
  expect(got.y).toBeCloseTo(want.y, 9)
  expect(got.z).toBeCloseTo(want.z, 9)
}
const add = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z)
const mul = (a: Vec3, b: Vec3): Vec3 => vec3(a.x * b.x, a.y * b.y, a.z * b.z)

/** A parent turned and stretched out of line with the level, and a child turned inside it. */
const parentPos = vec3(10, -2, 4)
const parentRot: Quat = eulerToQuat(vec3(0.4, -1.1, 0.3))
const parentScale = vec3(2, 0.5, 3)
const local = vec3(1, 2, -1)
const ownRotation = vec3(-0.2, 0.9, 0.5)

/** Where the game draws the target when one sequence says `p`, with nothing else moving it. */
const gameWorld = (p: Vec3, axes: SequenceAxes): Vec3 => {
  const off = combineSequences([{ pose: { ...AT_REST_POSE, position: p }, axes }], { parentRot, parentScale, ownRotation })
  return add(parentPos, rotateVec3(parentRot, mul(parentScale, add(local, off.position))))
}
const frame: PointFrame = { rest: add(parentPos, rotateVec3(parentRot, mul(parentScale, local))), parentRot, ownRotation }

describe('a point in the world', () => {
  const p = vec3(3, -1.5, 2)

  for (const axes of ['object', 'level'] as const) {
    it(`is where the game puts the target, in ${axes} axes, under a turned and stretched parent`, () => {
      expectVec(pointToWorld(p, axes, frame), gameWorld(p, axes))
    })

    it(`comes back to the same point from the world, in ${axes} axes`, () => {
      expectVec(worldToPoint(pointToWorld(p, axes, frame), axes, frame), p)
    })
  }

  it('is that many metres along the level in level axes, whatever the parent does', () => {
    expectVec(pointToWorld(vec3(0, 4, 0), 'level', frame), add(frame.rest, vec3(0, 4, 0)))
  })

  it('is the target’s place itself for the point it was placed at', () => {
    expectVec(pointToWorld(vec3(0, 0, 0), 'object', frame), frame.rest)
  })
})

describe('a route', () => {
  const move = (id: string, x: number, target?: string): Step => ({ id, kind: 'move', to: vec3(x, 0, 0), timing: { by: 'seconds', seconds: 1 }, ease: 'linear', ...(target === undefined ? {} : { target }) })
  const stages: readonly Stage[] = [
    { id: 'A', steps: [move('a', 1), { id: 'w', kind: 'wait', seconds: 1 }, move('kid', 5, 'left')] },
    { id: 'B', steps: [move('b', 2)] },
    { id: 'C', steps: [{ id: 't', kind: 'turn', axis: vec3(0, 1, 0), angle: 90, timing: { by: 'seconds', seconds: 1 }, ease: 'linear' }, move('c', 3)] },
  ]

  it('is the moves aimed at its target, in the order they play', () => {
    expect(routeSteps(stages, '').map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(routeSteps(stages, 'left').map((s) => s.id)).toEqual(['kid'])
    expect(routeSteps(stages, 'nobody')).toEqual([])
  })
})

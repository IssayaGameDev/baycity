import { SELF, type SequenceAxes, type Stage, type Step } from '@mp/content'
import { conjQuat, eulerToQuat, mulQuat, quat, rotateVec3, vec3, type Quat, type Vec3 } from '@mp/core'

/**
 * A sequence's move points in the viewport (ADR 0144): a point as a place in the world, a dragged copy's place
 * as a point, and which points make an object's route.
 *
 * A point is from where its target was placed, in the sequence's axes, and `combineSequences` is the rule
 * (ADR 0137, ADR 0106): `object` axes turn it by the target's placed rotation inside its parent, `level` axes
 * leave it along the level's. Both undo the parent's scale, so in the world a point is always that many metres
 * from the target's place — which makes the conversion a rotation and nothing else.
 *
 * Pure, because "where does this number put the object" is the part worth being sure about.
 */

/** Where a target was placed, in the terms a point is framed by. */
export interface PointFrame {
  /** Its world position as placed: its parent's world transform applied to its authored local position. */
  readonly rest: Vec3
  /** Its parent's world rotation; the identity at the top of the level. */
  readonly parentRot: Quat
  /** Its own authored rotation, an XYZ euler in radians. */
  readonly ownRotation: Vec3
}

/** The rotation that takes a point into the world: the target's placed world rotation, or none. */
const pointAxes = (axes: SequenceAxes, f: PointFrame): Quat => (axes === 'object' ? mulQuat(f.parentRot, eulerToQuat(f.ownRotation)) : quat())

/** Where a move to `p` puts its target, in the world. */
export const pointToWorld = (p: Vec3, axes: SequenceAxes, f: PointFrame): Vec3 => {
  const d = rotateVec3(pointAxes(axes, f), p)
  return vec3(f.rest.x + d.x, f.rest.y + d.y, f.rest.z + d.z)
}

/** The point a move needs to put its target at `w` in the world: `pointToWorld`'s inverse. */
export const worldToPoint = (w: Vec3, axes: SequenceAxes, f: PointFrame): Vec3 =>
  rotateVec3(conjQuat(pointAxes(axes, f)), vec3(w.x - f.rest.x, w.y - f.rest.y, w.z - f.rest.z))

export type MoveStep = Extract<Step, { kind: 'move' }>

/**
 * The move steps one sequence takes `target` through, in the order it plays them: stage by stage, and in a
 * stage by the order of its steps. `target` is a step's key — `SELF` for the object the sequence is on.
 */
export const routeSteps = (stages: readonly Stage[], target: string): MoveStep[] =>
  stages.flatMap((s) => s.steps.filter((step): step is MoveStep => step.kind === 'move' && (step.target ?? SELF) === target))

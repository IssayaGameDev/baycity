import { rotateVec3, type Quat, type Vec3 } from '@mp/core'

/**
 * Snapping to an increment (ADR 0114).
 *
 * **Absolute**, anchored at zero: `round(v / step) * step`. That is what makes snapping able to *straighten*
 * something — an object at 7° with a 15° increment lands on 15°, not on 22°.
 *
 * The distinction matters because `TransformControls` snaps translation and scale absolutely but rotation
 * **incrementally**: it rounds `rotationAngle`, how far the drag has turned, so a round amount is added to
 * whatever angle you already had and round angles are unreachable. Rotation is therefore snapped here instead.
 *
 * Pure, and separate from the composition root, because "which values can this land on" is the part worth
 * being sure about.
 */

/** Nearest multiple of `step`. A step of zero or less means no snapping, so the value passes through. */
export const snapToGrid = (value: number, step: number): number => (step > 0 ? Math.round(value / step) * step : value)

/**
 * An angle in **radians**, rounded to four decimals **of a degree** (ADR 0136).
 *
 * The file stores radians and the Inspector shows degrees, so the rounding belongs to the unit a person reads.
 * Rounding the radians instead saved 90° as 1.5708, which is 90.0002° — and about Y that is at the XYZ
 * decomposition's gimbal lock, where it read back as 89.9998.
 */
export const roundAngle = (radians: number): number => ((Math.round(((radians * 180) / Math.PI) * 1e4) / 1e4) * Math.PI) / 180

/**
 * Snap an XYZ Euler, given in **radians**, to a grid given in **degrees**.
 *
 * Per axis rather than as one orientation: a gizmo drag turns about a single ring, so the other two angles are
 * already whatever they were and rounding them changes nothing. About the free-rotate ring — a camera-facing
 * axis — this is an approximation, which is the price of landing on round angles at all.
 */
export const snapAnglesDeg = (radians: { x: number; y: number; z: number }, stepDeg: number): { x: number; y: number; z: number } => {
  if (stepDeg <= 0) return { x: radians.x, y: radians.y, z: radians.z }
  const step = (stepDeg * Math.PI) / 180
  return { x: snapToGrid(radians.x, step), y: snapToGrid(radians.y, step), z: snapToGrid(radians.z, step) }
}

/** Below this, an axis did not move: what a drag leaves of an untouched axis after a trip through the matrices. */
const MOVED = 1e-9

/**
 * A move's world position, snapped as Unity snaps one (ADR 0179).
 *
 * - **World handles** (no `rotation`): Unity's grid snap. Every axis the drag moved lands on the nearest multiple of
 *   `step` — the object's **position**, its centre — and an axis it did not move stays exactly where it started, on
 *   the grid or not. Snapping an axis nobody touched is how dragging X used to move Y and Z.
 * - **Local handles** (`rotation`, the handles' frame): a world grid cannot be followed along a tilted axis, so the
 *   move goes in whole steps along each handle axis, counted from where it started — Unity's increment snap, which
 *   is also all Unity does with local handles.
 *
 * `now` and `start` are world positions; so is what comes back.
 */
export const snapMove = (now: Vec3, start: Vec3, step: number, rotation?: Quat): Vec3 => {
  if (step <= 0) return { x: now.x, y: now.y, z: now.z }
  if (rotation === undefined) {
    const axis = (n: number, s: number): number => (Math.abs(n - s) < MOVED ? s : snapToGrid(n, step))
    return { x: axis(now.x, start.x), y: axis(now.y, start.y), z: axis(now.z, start.z) }
  }
  const back = { x: -rotation.x, y: -rotation.y, z: -rotation.z, w: rotation.w }
  const d = rotateVec3(back, { x: now.x - start.x, y: now.y - start.y, z: now.z - start.z })
  const along = (v: number): number => (Math.abs(v) < MOVED ? 0 : snapToGrid(v, step))
  const moved = rotateVec3(rotation, { x: along(d.x), y: along(d.y), z: along(d.z) })
  return { x: start.x + moved.x, y: start.y + moved.y, z: start.z + moved.z }
}

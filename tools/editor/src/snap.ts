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

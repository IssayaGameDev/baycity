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

/**
 * The half-extents of a box's **world axis-aligned** bounding box (ADR 0117).
 *
 * A rotated box reaches further along a world axis than its own half-extents: the standard result is
 * `|R| · h`, the rotation matrix with every entry made positive, applied to the half-extents. At 90° that
 * simply swaps two axes, which is what a wall standing on its edge needs.
 *
 * `m` is the rotation's 3×3 part in column-major order, as `THREE.Matrix4.elements` gives it.
 */
export const worldHalfExtents = (m: readonly number[], half: { x: number; y: number; z: number }): { x: number; y: number; z: number } => {
  const a = (i: number): number => Math.abs(m[i] ?? 0)
  return {
    x: a(0) * half.x + a(4) * half.y + a(8) * half.z,
    y: a(1) * half.x + a(5) * half.y + a(9) * half.z,
    z: a(2) * half.x + a(6) * half.y + a(10) * half.z,
  }
}

/**
 * How far to move something so its **minimum corner** lands on the grid (ADR 0117).
 *
 * Snapping the centre is what made half of all sizes wrong: a box three cells wide, centred on a grid line,
 * has its edges halfway between lines — so the end cells are half covered. The edge is the thing that meets
 * the next platform, and the middle is a number nobody looks at.
 */
export const cornerSnapDelta = (
  min: { x: number; y: number; z: number },
  step: number,
): { x: number; y: number; z: number } => ({
  x: snapToGrid(min.x, step) - min.x,
  y: snapToGrid(min.y, step) - min.y,
  z: snapToGrid(min.z, step) - min.z,
})

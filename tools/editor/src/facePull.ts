import { snapToGrid } from './snap'

/**
 * Pulling one face of a box (ADR 0119).
 *
 * The gesture SketchUp calls push/pull: grab a face, drag it along its own normal, and the opposite face stays
 * where it is. That is what the scale tool cannot do — it grows a box about its centre, so both faces move.
 *
 * Pure, and separate from the viewport, because the parts worth being sure about are arithmetic: which face
 * was grabbed, how far the pointer dragged along it, and the scale-and-position pair that distance comes to.
 *
 * **A face pull changes size *and* position.** Growing by `d` on one side means the size grows by `d` and the
 * centre moves by `d / 2`, because a box is stored as a centre plus a size. That is the whole trick.
 */

export type Axis = 'x' | 'y' | 'z'

/** Which face: an axis, and which end of it. `+1` is the face on the positive side. */
export interface Face {
  axis: Axis
  sign: 1 | -1
}

interface V3 {
  x: number
  y: number
  z: number
}

/**
 * The face a hit normal names, snapped to the nearest of the six.
 *
 * Snapped rather than read off, because a **rounded** box's corners and fillets have normals pointing between
 * two axes — and a rounded box is one of the two shapes this works on. The largest component wins, which for
 * a flat face is exact and for a fillet picks the face it belongs to.
 *
 * `null` for a normal with no direction at all, which should not happen but is not worth a throw.
 */
export const faceFromNormal = (n: V3): Face | null => {
  const ax = Math.abs(n.x)
  const ay = Math.abs(n.y)
  const az = Math.abs(n.z)
  if (ax === 0 && ay === 0 && az === 0) return null
  if (ax >= ay && ax >= az) return { axis: 'x', sign: n.x >= 0 ? 1 : -1 }
  if (ay >= az) return { axis: 'y', sign: n.y >= 0 ? 1 : -1 }
  return { axis: 'z', sign: n.z >= 0 ? 1 : -1 }
}

/**
 * How far along a line the point nearest a ray sits.
 *
 * The line is the face's normal through its centre; the ray is the pointer. Returns the parameter `t` in
 * metres along `lineDir`, which must be a unit vector. This is what a single-axis gizmo handle does, and it is
 * stable at any camera angle **except** looking straight down the line, where the two are parallel and there
 * is no nearest point — `null` then, so the caller holds the last good value instead of jumping.
 */
export const distanceAlongAxis = (rayOrigin: V3, rayDir: V3, lineOrigin: V3, lineDir: V3): number | null => {
  const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z
  const w = { x: lineOrigin.x - rayOrigin.x, y: lineOrigin.y - rayOrigin.y, z: lineOrigin.z - rayOrigin.z }
  const dr = dot(rayDir, rayDir)
  const dl = dot(lineDir, lineDir)
  const rl = dot(rayDir, lineDir)
  const denom = dr * dl - rl * rl
  // Parallel: the ray runs along the line, so every point on it is equally near.
  if (Math.abs(denom) < 1e-9) return null
  return (rl * dot(rayDir, w) - dr * dot(lineDir, w)) / denom
}

/**
 * The distance to actually apply: the **face's new position** snapped to the grid, expressed as a delta.
 *
 * Snapping the distance dragged would anchor the grid to wherever the face started — the fault of ADR 0113,
 * ADR 0114 and ADR 0117 in turn. Snapping where the face *lands* is what lets a face be brought onto the grid
 * from off it.
 *
 * `step` of zero or less means no snapping.
 */
export const snappedPull = (faceAt: number, raw: number, step: number): number =>
  step > 0 ? snapToGrid(faceAt + raw, step) - faceAt : raw

/**
 * The scale and position a pull comes to: the scale in the node's own frame, the position in its **parent's**.
 *
 * `distance` is in **local** units along the face's axis and is positive outward, whichever face it is: the
 * caller has already turned a world drag into "how much bigger this side wants to be".
 *
 * `axisInParent` is the node's own `face.axis` as a unit vector **in the parent's frame** — the node's
 * rotation applied to that axis, unsigned. It is what the half-growth is moved along, and it is required
 * rather than defaulted precisely because the default is the bug it fixes.
 *
 * **The two frames are not the same one.** Scale is the node's own, so growing `scale.x` moves the face along
 * the node's local x; position is stored in the parent's frame, so nudging `position.x` moves the centre along
 * the *parent's* x. They coincide only when the node is unrotated. Rotated, the box grew one way and its
 * centre slid another, which read as the whole object teleporting mid-drag: measured on an authored platform
 * at rotation (-90, -75, -90), a 5 m pull dragged the anchored face 3.54 m. A box turned 180 degrees was
 * worst — the centre moved the full 5 m, backwards. Every pull on every rotated box was affected, except one
 * whose rotation is about the pulled axis itself, where the axis does not move.
 *
 * Clamped so the box never inverts and never shrinks below `minSize`. The clamp is applied to the *size*, and
 * the position follows from whatever size survived it, so a pull held past the far face simply stops.
 */
export const pulled = (
  scale: V3,
  position: V3,
  face: Face,
  distance: number,
  minSize: number,
  axisInParent: V3,
): { scale: V3; position: V3 } => {
  const size = scale[face.axis]
  const next = Math.max(minSize, size + distance)
  const grew = next - size
  // Half the growth, toward the face that moved: the other face has to stay put.
  const step = (grew / 2) * face.sign
  return {
    scale: { ...scale, [face.axis]: next },
    position: {
      x: position.x + axisInParent.x * step,
      y: position.y + axisInParent.y * step,
      z: position.z + axisInParent.z * step,
    },
  }
}

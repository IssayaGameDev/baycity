import type { Vec3 } from '@mp/core'
import { gridCells, type SurfaceGrid } from '@mp/mode'

/**
 * Drawing a game's surface grid over a box (ADR 0120).
 *
 * The cells are drawn as children of the node's **mesh holder**, which is the frame every other mesh in the
 * viewport is built in: `buildItemMeshes` sets the holder's scale to the inverse of the node's world scale, so
 * a child of it is placed in plain world metres, oriented and positioned with the node. Exactly the frame the
 * game lays its caps out in before rotating them, so the offsets here are the offsets there.
 *
 * Riding the node's group is what makes the preview live for nothing. Three composes the transform chain, so a
 * move, a turn, a reparent or a parent's move re-runs none of this. Only a **size** change alters the cell
 * count, and that is precisely the edit the editor already rebuilds an item's meshes for — including every
 * frame of a face pull.
 *
 * Pure, and separate from the viewport, for the reason `snap.ts` and `facePull.ts` are: the part worth being
 * sure about is the arithmetic, and `main.ts` is not where arithmetic should be read.
 */

/** A cell to draw: its centre in metres from the node's origin, and the side of its square. */
export interface CellQuad {
  x: number
  y: number
  z: number
  /** Side of the square, metres. Smaller than the pitch, so the gap between cells is the real gap. */
  side: number
}

/**
 * How far above the face a cell is drawn (m).
 *
 * Enough to beat depth precision on a face tens of metres from the camera, far too little to read as
 * floating — and well under the fillet of a rounded box, so it does not lift off the corner.
 */
const LIFT = 0.002

/**
 * Every cell of `grid` as a quad on the **top** face of a box of `size`, in the node's own metres.
 *
 * `size` is the box's full extent, so the top face is at `size.y / 2` — the node's origin is the box's centre.
 * That is `half.y`, which is where `capsFor` puts a cap's base, so a previewed cell and a real cap sit on the
 * same plane.
 *
 * A zero or negative extent on any axis has no face to draw on.
 */
export const gridQuads = (grid: SurfaceGrid, size: Vec3): CellQuad[] => {
  if (!(size.x > 0) || !(size.y > 0) || !(size.z > 0)) return []
  const y = size.y / 2 + LIFT
  return gridCells(grid).map((cell) => ({ x: cell.x, y, z: cell.z, side: grid.size }))
}

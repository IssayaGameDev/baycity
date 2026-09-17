import type { ComponentData } from '@mp/content'
import type { Vec3 } from '@mp/core'

/**
 * What a game would tile onto one surface, for a **tool** to draw before the game has run.
 *
 * A game whose components generate geometry at runtime — keyboard's caps (ADR 0069) — leaves an author placing
 * platforms blind: nothing in the editor says where the cells land, so fitting two platforms together so their
 * cells continue means doing the arithmetic by hand.
 *
 * This is the answer, and the shape of it is the point: the game returns the **grid**, not the geometry. A
 * description is a few numbers whatever the cell count, so a tool can ask for it on every frame of a drag, and
 * the tool owns the drawing — which keeps `@mp/mode` free of a renderer, as everything else here is.
 *
 * Axis-aligned in the surface's own frame, because that is the only frame a tool can place cells in without
 * knowing what they are for. A rotated or nested node composes through the tool's own transform chain.
 */
export interface SurfaceGrid {
  /** Cells along local x and local z. Never zero: a surface with no room for a whole cell has no grid at all. */
  readonly cols: number
  readonly rows: number
  /** Centre-to-centre spacing, in metres. Both axes: a cell is square. */
  readonly pitch: number
  /** The side of one cell's footprint, in metres. Smaller than `pitch` leaves a visible gap between cells. */
  readonly size: number
  /**
   * The first cell's centre, in metres from the surface's centre.
   *
   * Stored rather than derived so a tool inverts exactly the arithmetic the game used. Two copies of that
   * rule is how a preview ends up one cell over from the thing it is previewing.
   */
  readonly startX: number
  readonly startZ: number
}

/**
 * Ask a game what it would tile onto one box surface (ADR 0120).
 *
 * `components` are the node's, so the game decides from its own components whether this surface is one of its
 * at all — a tool never learns which component means what. `size` is the box's full extent in metres, and
 * `settings` the game's own values as the editor currently holds them, so a live edit to one is reflected
 * without the game being reloaded.
 *
 * `null` for a surface this game tiles nothing onto, which is most of them.
 */
export type SurfaceGridOf = (
  components: readonly ComponentData[],
  size: Vec3,
  settings: Readonly<Record<string, unknown>>,
) => SurfaceGrid | null

/**
 * The cells of a grid, as offsets from the surface's centre in its own frame.
 *
 * Here rather than in each tool: the offsets are `startX + col * pitch`, which is the arithmetic the grid
 * exists to communicate, and a tool re-deriving it is the copy this type is meant to prevent.
 */
export const gridCells = (grid: SurfaceGrid): { x: number; z: number }[] => {
  const out: { x: number; z: number }[] = []
  for (let c = 0; c < grid.cols; c += 1)
    for (let r = 0; r < grid.rows; r += 1) out.push({ x: grid.startX + c * grid.pitch, z: grid.startZ + r * grid.pitch })
  return out
}

/**
 * How much of the surface no cell covers, per axis, in metres — the strip left over at **each** edge.
 *
 * The number an author would otherwise reach for a calculator to find: whole cells only, and the remainder
 * split between the two edges, so this is what stands between the last cell and the surface's edge.
 */
export const gridMargin = (grid: SurfaceGrid, size: Vec3): { x: number; z: number } => ({
  x: (size.x - grid.cols * grid.pitch) / 2,
  z: (size.z - grid.rows * grid.pitch) / 2,
})

import { gridMargin, type SurfaceGrid } from '@mp/mode'
import { describe, expect, it } from 'vitest'

import { gridQuads } from './surfaceGrid'

const v = (x: number, y: number, z: number) => ({ x, y, z })

/** A 0.9 m pitch at 0.88 fill — the game's declared defaults. */
const gridFor = (cols: number, rows: number, pitch = 0.9, fill = 0.88): SurfaceGrid => ({
  cols,
  rows,
  pitch,
  size: pitch * fill,
  startX: -((cols - 1) * pitch) / 2,
  startZ: -((rows - 1) * pitch) / 2,
})

describe('gridQuads', () => {
  it('draws one quad per cell', () => {
    expect(gridQuads(gridFor(5, 3), v(4.5, 0.5, 2.7))).toHaveLength(15)
  })

  /** `capsFor` puts a cap's base at `half.y`; a cell drawn anywhere else previews the wrong plane. */
  it('sits just above the top face, which is half the height up', () => {
    for (const q of gridQuads(gridFor(2, 2), v(1.8, 4, 1.8))) {
      expect(q.y).toBeGreaterThan(2)
      expect(q.y).toBeLessThan(2.01)
    }
  })

  it('reports the cell footprint, not the pitch, so the gap between cells is real', () => {
    const [q] = gridQuads(gridFor(2, 2), v(1.8, 1, 1.8))
    expect(q!.side).toBeCloseTo(0.792, 9)
  })

  it('centres the block of cells on the face', () => {
    const xs = gridQuads(gridFor(5, 5), v(4.5, 1, 4.5)).map((q) => q.x)
    const zs = gridQuads(gridFor(5, 5), v(4.5, 1, 4.5)).map((q) => q.z)
    expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(0, 9)
    expect(Math.min(...zs) + Math.max(...zs)).toBeCloseTo(0, 9)
  })

  it('lays cells out one pitch apart', () => {
    const xs = [...new Set(gridQuads(gridFor(5, 1), v(4.5, 1, 0.9)).map((q) => q.x))].sort((a, b) => a - b)
    expect(xs).toHaveLength(5)
    for (let i = 1; i < xs.length; i += 1) expect(xs[i]! - xs[i - 1]!).toBeCloseTo(0.9, 9)
  })

  /** A cell never crosses the edge: the last one's far side is inside the face by the leftover margin. */
  it('keeps every cell inside the face', () => {
    const size = v(5, 1, 5) // 5 columns of 0.9 leaves 0.5 over, 0.25 a side
    for (const q of gridQuads(gridFor(5, 5), size)) {
      expect(Math.abs(q.x) + q.side / 2).toBeLessThanOrEqual(size.x / 2)
      expect(Math.abs(q.z) + q.side / 2).toBeLessThanOrEqual(size.z / 2)
    }
  })

  /** The cells are metres in the node's frame, so the box's proportions do not stretch them. */
  it('is unaffected by how flat or long the box is', () => {
    const wide = gridQuads(gridFor(4, 4), v(3.6, 0.1, 3.6))
    const tall = gridQuads(gridFor(4, 4), v(3.6, 40, 3.6))
    expect(wide.map((q) => [q.x, q.z])).toEqual(tall.map((q) => [q.x, q.z]))
    expect(wide[0]!.side).toBe(tall[0]!.side)
  })

  it('has nothing to draw on a box with no extent', () => {
    expect(gridQuads(gridFor(2, 2), v(0, 1, 2))).toEqual([])
    expect(gridQuads(gridFor(2, 2), v(2, 0, 2))).toEqual([])
    expect(gridQuads(gridFor(2, 2), v(2, 1, 0))).toEqual([])
  })
})

describe('gridMargin', () => {
  /** The number an author would otherwise reach for a calculator to find. */
  it('reports the strip left over at each edge', () => {
    expect(gridMargin(gridFor(5, 5), v(5, 1, 5))).toEqual({ x: 0.25, z: 0.25 })
  })

  it('is zero when the face is a whole number of cells', () => {
    const m = gridMargin(gridFor(5, 3), v(4.5, 1, 2.7))
    expect(m.x).toBeCloseTo(0, 9)
    expect(m.z).toBeCloseTo(0, 9)
  })
})

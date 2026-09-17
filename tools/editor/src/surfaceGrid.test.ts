import { gridMargin, type SurfaceGrid } from '@mp/mode'
import { THREE } from '@mp/render-three'
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

/**
 * The frame the cells are drawn in, which is the part that actually broke (ADR 0120).
 *
 * `buildItemMeshes` counter-scales the mesh holder by the group's **world** scale, so a child of it sits in
 * world metres. That only holds if the group is already in the scene when it is asked — built before
 * parenting it reports its own scale instead, and the holder is then left carrying the parent chain's scale.
 *
 * The meshes hid that: they are built at `ws` and multiplied by exactly the leftover, so the two errors
 * cancelled. A cell placed at an absolute size has nothing to cancel with, and came out scaled by the parent.
 */
describe('the frame a cell is drawn in', () => {
  const chain = (parentScale: [number, number, number], localScale: [number, number, number], parentFirst: boolean) => {
    const root = new THREE.Group()
    const parent = new THREE.Group()
    parent.scale.set(...parentScale)
    root.add(parent)
    const g = new THREE.Group()
    g.scale.set(...localScale)
    const holder = new THREE.Group()
    g.add(holder)
    const counterScale = (): THREE.Vector3 => {
      g.updateWorldMatrix(true, false)
      const ws = g.getWorldScale(new THREE.Vector3())
      const inv = (v: number): number => (Math.abs(v) < 1e-6 ? 1 : 1 / v)
      holder.scale.set(inv(ws.x), inv(ws.y), inv(ws.z))
      return ws
    }
    let seen: THREE.Vector3
    if (parentFirst) {
      parent.add(g)
      seen = counterScale()
    } else {
      seen = counterScale()
      parent.add(g)
    }
    // One cell, as `gridQuads` gives it: 0.792 m square, one 0.9 m pitch out along x.
    const cell = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2))
    cell.position.set(0.9, 0, 0)
    cell.scale.set(0.792, 1, 0.792)
    holder.add(cell)
    root.updateWorldMatrix(true, true)
    return {
      seen,
      size: cell.getWorldScale(new THREE.Vector3()),
      at: cell.getWorldPosition(new THREE.Vector3()),
    }
  }

  const PARENT: [number, number, number] = [5, 1, 1]
  const LOCAL: [number, number, number] = [33.3, 0.3, 33.3]

  it('keeps a cell square and one pitch out under a scaled parent', () => {
    const { size, at } = chain(PARENT, LOCAL, true)
    expect(size.x).toBeCloseTo(0.792, 6)
    expect(size.z).toBeCloseTo(0.792, 6)
    expect(at.x).toBeCloseTo(0.9, 6)
  })

  it('reports the true world scale, which is what the cell count comes from', () => {
    expect(chain(PARENT, LOCAL, true).seen.x).toBeCloseTo(166.5, 6)
  })

  /** What the bug looked like: the parent's 5 landed on the cell's size and on its spacing. */
  it('is wrong when the group is asked before it is in the scene', () => {
    const { seen, size, at } = chain(PARENT, LOCAL, false)
    expect(seen.x).toBeCloseTo(33.3, 6)
    expect(size.x).toBeCloseTo(3.96, 6)
    expect(at.x).toBeCloseTo(4.5, 6)
  })
})

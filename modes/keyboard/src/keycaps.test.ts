import { vec3 } from '@mp/core'
import { THREE } from '@mp/render-three'
import { describe, expect, it } from 'vitest'

import { advancePress, boardOf, capsFor, capsUnder, DEFAULT_PRESS, glyphAt, MAX_SWEEP, sweepPoints, type KeyboardParams, type PressState } from './keycaps'

/**
 * Turning a standing character back into the caps under them (ADR 0069).
 *
 * The placement lays caps out and the lookup inverts it, and **two copies of that arithmetic is how a press
 * lands beside the foot instead of under it**. So the test that matters is the round trip: place every cap,
 * then stand on each one and expect to get that cap back.
 *
 * Headless. There is no renderer here and none is needed — the maths is the part that goes wrong.
 */

const P: KeyboardParams = { pitch: 0.6, fill: 0.88, height: 0.3, glyphs: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', seed: 1 }
/** A character's footprint: the capsule's radius. */
const FOOT = 0.4

const platform = (
  position = vec3(0, 1, 0),
  half = vec3(4, 0.25, 3),
  rotation = { x: 0, y: 0, z: 0, w: 1 },
): { collider: { kind: 'box'; halfExtents: typeof half }; position: typeof position; rotation: typeof rotation } => ({
  collider: { kind: 'box', halfExtents: half },
  position,
  rotation,
})

/** Place a board's caps and index them the way `drawKeycaps` does, so the lookup can be exercised. */
const placed = (
  item: ReturnType<typeof platform>,
  params: KeyboardParams = P,
  boardIndex = 0,
): { board: NonNullable<ReturnType<typeof boardOf>>; caps: Map<string, string>; points: Map<string, THREE.Vector3> } => {
  const board = boardOf(item, params)
  if (board === null) throw new Error('board did not tile')
  const caps = new Map<string, string>()
  const points = new Map<string, THREE.Vector3>()
  for (const cap of capsFor(board, item.collider.halfExtents, params)) {
    const key = `${boardIndex}:${cap.col}:${cap.row}`
    caps.set(key, key)
    points.set(key, new THREE.Vector3().setFromMatrixPosition(cap.matrix))
  }
  return { board, caps, points }
}

describe('tiling a board', () => {
  /**
   * Caps sit on a lattice shared by every board, not centred on each one (ADR 0115). A cap is kept only where
   * its whole footprint fits, so nothing overhangs.
   */
  it('takes the lattice cells whose centre is on the face', () => {
    const board = boardOf(platform(vec3(0, 1, 0), vec3(4, 0.25, 3)), P)!
    for (let c = 0; c < board.cols; c += 1) {
      const x = board.startX + c * P.pitch
      expect(Math.abs(x), `column ${c} has its centre off the face`).toBeLessThan(4 + 1e-9)
    }
    // And the next cell along each way has its centre off the face.
    expect(Math.abs(board.startX - P.pitch)).toBeGreaterThanOrEqual(4 - 1e-9)
  })

  /**
   * The point of the lattice, and the thing that was impossible before: two boards placed edge to edge
   * continue each other. Centring made this need an overlap of `width mod pitch` — a different number for
   * every board size (ADR 0115).
   */
  it('keeps two boards in step, so a seam is a whole number of cells and never a phase error', () => {
    const half = vec3(2.5, 0.25, 2.5)
    const a = boardOf(platform(vec3(0, 1, 0), half), P)!
    const b = boardOf(platform(vec3(5, 1, 0), half), P)!
    const worldX = (board: typeof a, col: number): number => board.origin.x + board.startX + col * P.pitch
    // Every cap of both boards is on one lattice, whatever the sizes and wherever they are put.
    for (const [board, label] of [[a, 'A'], [b, 'B']] as const)
      for (let c = 0; c < board.cols; c += 1) {
        const x = worldX(board, c)
        expect(Math.abs(x / P.pitch - Math.round(x / P.pitch)), `${label} column ${c} is off the lattice`).toBeLessThan(1e-6)
      }
    // Consecutive cells across the seam: every cell of the pair belongs to exactly one board (ADR 0116), so
    // two boards edge to edge continue each other with nothing missing.
    expect(worldX(b, 0) - worldX(a, a.cols - 1)).toBeCloseTo(P.pitch, 6)
  })

  it('joins without a gap at any width, which is the whole point', () => {
    // No rule to satisfy: the author places platforms, not the grid (ADR 0116).
    for (const width of [5, 4, 3.7, 6.25, 9]) {
      const half = vec3(width / 2, 0.25, 2.5)
      const a = boardOf(platform(vec3(0, 1, 0), half), P)!
      const b = boardOf(platform(vec3(width, 1, 0), half), P)!
      const worldX = (board: typeof a, col: number): number => board.origin.x + board.startX + col * P.pitch
      expect(worldX(b, 0) - worldX(a, a.cols - 1), `width ${width}`).toBeCloseTo(P.pitch, 6)
    }
  })

  it('needs no special position: any offset keeps both boards on the lattice', () => {
    const half = vec3(2.5, 0.25, 2.5)
    for (const at of [3.7, 5, 6.25, 11.1]) {
      const b = boardOf(platform(vec3(at, 1, 0), half), P)!
      for (let c = 0; c < b.cols; c += 1) {
        const x = b.origin.x + b.startX + c * P.pitch
        expect(Math.abs(x / P.pitch - Math.round(x / P.pitch)), `at ${at}, column ${c}`).toBeLessThan(1e-6)
      }
    }
  })

  it('keeps every cap inside the platform', () => {
    const half = vec3(4, 0.25, 3)
    const { points } = placed(platform(vec3(0, 1, 0), half))
    for (const p of points.values()) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(half.x)
      expect(Math.abs(p.z)).toBeLessThanOrEqual(half.z)
    }
  })

  /**
   * A cell belongs to the board its centre is on (ADR 0116), so what decides this is whether a centre lands on
   * the face — not whether the cap would fit. A small platform in a compound ground getting its cap matters
   * more than a small isolated one getting an oversized cap: the first is a hole in the floor, the second is
   * a choice somebody made by putting a Keyboard on something narrower than a key.
   */
  it('gives a platform smaller than a cap the cell whose centre lands on it', () => {
    const board = boardOf(platform(vec3(0, 0, 0), vec3(0.2, 0.25, 0.2)), P)
    expect(board?.cols).toBe(1)
    expect(board?.rows).toBe(1)
  })

  it('refuses a platform no cell centre falls on', () => {
    // Half a pitch off the lattice, and narrower than half a cell: the nearest centres are both outside it.
    const off = P.pitch / 2
    expect(boardOf(platform(vec3(off, 0, off), vec3(0.2, 0.25, 0.2)), P)).toBeNull()
  })

  it('sits caps on the face, not half sunk into it', () => {
    const half = vec3(4, 0.25, 3)
    const { points } = placed(platform(vec3(0, 1, 0), half))
    // The geometry runs y 0…1 from its own base, so a cap's origin belongs exactly on the top face.
    for (const p of points.values()) expect(p.y).toBeCloseTo(1 + half.y, 9)
  })
})

describe('finding the caps under a character', () => {
  /** The one that matters: placement and lookup are two copies of one rule and must agree everywhere. */
  it('always includes the cap being stood on, flat', () => {
    const { board, caps, points } = placed(platform())
    // Not a fixed number: how many cells land on a face is the lattice's business (ADR 0115), and this test
    // is about the lookup finding whichever cap you are stood on.
    expect(points.size).toBeGreaterThan(0)
    for (const [key, at] of points) {
      const stood = vec3(at.x, at.y + 0.3, at.z)
      expect(capsUnder([board], caps, stood, FOOT)).toContain(key)
    }
  })

  it('always includes the cap being stood on, rotated', () => {
    const spin = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 5, 0))
    const item = platform(vec3(7, 2, -3), vec3(3, 0.25, 2), { x: spin.x, y: spin.y, z: spin.z, w: spin.w })
    const { board, caps, points } = placed(item)
    for (const [key, at] of points) {
      const up = new THREE.Vector3(0, 0.3, 0).applyQuaternion(spin)
      expect(capsUnder([board], caps, vec3(at.x + up.x, at.y + up.y, at.z + up.z), FOOT)).toContain(key)
    }
  })

  it('always includes the cap being stood on, tilted', () => {
    const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.25, 0, 0))
    const item = platform(vec3(0, 3, 0), vec3(3, 0.25, 3), { x: tilt.x, y: tilt.y, z: tilt.z, w: tilt.w })
    const { board, caps, points } = placed(item)
    for (const [key, at] of points) {
      const up = new THREE.Vector3(0, 0.3, 0).applyQuaternion(tilt)
      expect(capsUnder([board], caps, vec3(at.x + up.x, at.y + up.y, at.z + up.z), FOOT)).toContain(key)
    }
  })

  /**
   * A footprint is a footprint, not a point: a 0.4 m capsule on a 0.6 m pitch covers between one and four
   * caps depending on where it lands, which is what makes the print read as feet rather than as a single key.
   */
  it('presses a handful, not one and not the board', () => {
    const { board, caps, points } = placed(platform())
    const onCap = [...points.values()][40]!
    const dead = capsUnder([board], caps, vec3(onCap.x, onCap.y + 0.3, onCap.z), FOOT)
    expect(dead.length).toBeGreaterThanOrEqual(1)
    expect(dead.length).toBeLessThanOrEqual(4)

    // Standing on the corner between four caps should take all four.
    const between = vec3(onCap.x + board.pitch / 2, onCap.y + 0.3, onCap.z + board.pitch / 2)
    expect(capsUnder([board], caps, between, FOOT)).toHaveLength(4)
  })

  it('presses more of the board as the footprint grows', () => {
    const { board, caps, points } = placed(platform())
    const at = [...points.values()][40]!
    const stood = vec3(at.x, at.y + 0.3, at.z)
    expect(capsUnder([board], caps, stood, 2).length).toBeGreaterThan(capsUnder([board], caps, stood, FOOT).length)
  })

  /**
   * The bug this replaces: the band above the face was 2.5 m, so a player falling two metres up pressed every
   * key beneath them all the way down.
   */
  it('finds nothing while a player is still falling toward it', () => {
    const { board, caps, points } = placed(platform())
    const at = [...points.values()][40]!
    for (const above of [0.6, 1, 2, 5]) expect(capsUnder([board], caps, vec3(at.x, at.y + above, at.z), FOOT)).toHaveLength(0)
    // And still catches a sole a few centimetres off the surface, which is where the gait puts one mid-plant.
    expect(capsUnder([board], caps, vec3(at.x, at.y - 0.25, at.z), FOOT).length).toBeGreaterThan(0)
  })

  it('finds nothing beside the board', () => {
    const { board, caps } = placed(platform(vec3(0, 1, 0), vec3(4, 0.25, 3)))
    expect(capsUnder([board], caps, vec3(20, 1.3, 0), FOOT)).toHaveLength(0)
    expect(capsUnder([board], caps, vec3(0, 1.3, 20), FOOT)).toHaveLength(0)
  })

  /** Otherwise walking under a platform would press the keys on top of it. */
  it('finds nothing from underneath', () => {
    const { board, caps } = placed(platform(vec3(0, 6, 0), vec3(4, 0.25, 3)))
    expect(capsUnder([board], caps, vec3(0, 2, 0), FOOT)).toHaveLength(0)
  })

  it('picks the right board out of several', () => {
    const a = placed(platform(vec3(0, 1, 0), vec3(3, 0.25, 3)), P, 0)
    const b = placed(platform(vec3(30, 1, 0), vec3(3, 0.25, 3)), P, 1)
    const caps = new Map([...a.caps, ...b.caps])

    const [key, at] = [...b.points][7]!
    expect(capsUnder([a.board, b.board], caps, vec3(at.x, at.y + 0.3, at.z), FOOT)).toContain(key)
  })
})

describe('lettering', () => {
  it('is the same every time for the same cell', () => {
    expect(glyphAt(7, 3, 4, 26)).toBe(glyphAt(7, 3, 4, 26))
  })

  it('stays inside the alphabet it was given', () => {
    for (let c = 0; c < 40; c += 1)
      for (let r = 0; r < 40; r += 1) {
        const i = glyphAt(1, c, r, 26)
        expect(i).toBeGreaterThanOrEqual(0)
        expect(i).toBeLessThan(26)
      }
  })

  it('re-letters the board when the seed changes', () => {
    const board = (seed: number): string => {
      let s = ''
      for (let c = 0; c < 12; c += 1) for (let r = 0; r < 12; r += 1) s += glyphAt(seed, c, r, 26)
      return s
    }
    expect(board(1)).not.toBe(board(2))
  })

  it('spreads across the alphabet rather than favouring a few letters', () => {
    const seen = new Set<number>()
    for (let c = 0; c < 20; c += 1) for (let r = 0; r < 20; r += 1) seen.add(glyphAt(1, c, r, 26))
    // A hash that collapsed — a bad shift, a lost multiply — would show up as a handful of letters.
    expect(seen.size).toBeGreaterThan(20)
  })
})

describe('a press goes all the way down', () => {
  const DT = 1 / 60
  const struck = (): PressState => ({ held: true, committed: true, at: 0 })
  const settle = (cap: PressState, frames: number): number[] => {
    const trace: number[] = []
    for (let i = 0; i < frames; i++) {
      advancePress(cap, DEFAULT_PRESS, DT)
      trace.push(cap.at)
    }
    return trace
  }

  it('bottoms out even when the foot is there for a single frame', () => {
    const cap = struck()
    // One frame of contact, then nobody re-asserts `held`.
    const trace = settle(cap, 30)
    expect(Math.max(...trace)).toBe(1)
    // And it does not stay down: once bottomed it rises.
    expect(trace[trace.length - 1]!).toBeLessThan(1)
  })

  it('does not bottom out without the commitment — the old behaviour, for contrast', () => {
    const cap: PressState = { held: true, committed: false, at: 0 }
    expect(Math.max(...settle(cap, 30))).toBeLessThan(1)
  })

  it('stays down while somebody keeps standing on it', () => {
    const cap = struck()
    for (let i = 0; i < 30; i++) {
      cap.held = true
      advancePress(cap, DEFAULT_PRESS, DT)
    }
    expect(cap.at).toBe(1)
  })

  it('reports itself finished only once fully up and unheld', () => {
    const cap = struck()
    let live = true
    let frames = 0
    while (live && frames < 200) {
      live = advancePress(cap, DEFAULT_PRESS, DT)
      frames++
    }
    expect(live).toBe(false)
    expect(cap.at).toBe(0)
    // Down in downTime, up in upTime: about (0.05 + 0.65) × 60 frames.
    expect(frames).toBeGreaterThan(30)
  })
})

describe('sweeping a frame of travel', () => {
  it('samples no wider than the spacing and ends exactly at the destination', () => {
    const pts = sweepPoints(vec3(0, 1, 0), vec3(0, 1, 2.1), 0.4)
    expect(pts[pts.length - 1]).toEqual(vec3(0, 1, 2.1))
    let prev = vec3(0, 1, 0)
    for (const p of pts) {
      expect(Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z)).toBeLessThanOrEqual(0.4 + 1e-9)
      prev = p
    }
    // Two footprints of radius 0.4 always overlap along the path, so no cap between them can be missed.
    expect(pts.length).toBe(6)
  })

  it('is one point — the destination — when the travel is shorter than the spacing', () => {
    expect(sweepPoints(vec3(0, 0, 0), vec3(0.1, 0, 0), 0.4)).toEqual([vec3(0.1, 0, 0)])
  })

  it('interpolates height too, so a sweep down a ramp follows the ramp', () => {
    const pts = sweepPoints(vec3(0, 2, 0), vec3(0, 0, 2), 1)
    expect(pts[0]!.y).toBeCloseTo(2 - 2 / pts.length, 9)
  })

  it('treats a whole-level jump as a teleport, not a run', () => {
    // A respawn from the last board to spawn is ~56 m; a frame at 15 fps and 32 m/s is 2.1 m.
    expect(MAX_SWEEP).toBeGreaterThan(2.1)
    expect(MAX_SWEEP).toBeLessThan(56)
  })
})

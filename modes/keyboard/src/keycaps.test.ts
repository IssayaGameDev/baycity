import { vec3 } from '@mp/core'
import { THREE } from '@mp/render-three'
import { describe, expect, it } from 'vitest'

import { boardOf, capsFor, capsUnder, glyphAt, type KeyboardParams } from './keycaps'

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
  it('fits whole caps only, and centres the leftover', () => {
    const board = boardOf(platform(vec3(0, 1, 0), vec3(4, 0.25, 3)), P)!
    // 8 m / 0.6 = 13.3 -> 13 columns; 6 m / 0.6 = 10 rows.
    expect(board.cols).toBe(13)
    expect(board.rows).toBe(10)
    const first = board.startX
    const last = board.startX + (board.cols - 1) * board.pitch
    expect(Math.abs(first)).toBeCloseTo(Math.abs(last), 9)
  })

  it('keeps every cap inside the platform', () => {
    const half = vec3(4, 0.25, 3)
    const { points } = placed(platform(vec3(0, 1, 0), half))
    for (const p of points.values()) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(half.x)
      expect(Math.abs(p.z)).toBeLessThanOrEqual(half.z)
    }
  })

  it('refuses a platform smaller than one cap', () => {
    expect(boardOf(platform(vec3(0, 0, 0), vec3(0.2, 0.25, 0.2)), P)).toBeNull()
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
    expect(points.size).toBe(130)
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

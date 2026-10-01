import { vec3 } from '@mp/core'
import { THREE } from '@mp/render-three'
import { describe, expect, it } from 'vitest'

import { advancePress, boardGrid, boardOf, capsFor, capsUnder, carry, DEFAULT_KEY_GEOMETRY, DEFAULT_PRESS, glyphAt, keyGeometryFrom, keyboardGridOf, MAX_SWEEP, facingTurns, paintShader, rideShader, sweepPoints, type KeyboardParams, type Moving, type PressState } from './keycaps'

/**
 * Turning a standing character back into the caps under them (ADR 0069).
 *
 * The placement lays caps out and the lookup inverts it, and **two copies of that arithmetic is how a press
 * lands beside the foot instead of under it**. So the test that matters is the round trip: place every cap,
 * then stand on each one and expect to get that cap back.
 *
 * Headless. There is no renderer here and none is needed — the maths is the part that goes wrong.
 */

const P: KeyboardParams = { pitch: 0.6, fill: 0.88, height: 0.3, maxKeys: 20_000, glyphs: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', seed: 1, facing: 0 }
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

  it('refuses a platform smaller than one cap', () => {
    expect(boardOf(platform(vec3(0, 0, 0), vec3(0.2, 0.25, 0.2)), P)).toBeNull()
  })

  it('keeps every cap inside the platform', () => {
    const half = vec3(4, 0.25, 3)
    const { points } = placed(platform(vec3(0, 1, 0), half))
    for (const p of points.values()) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(half.x)
      expect(Math.abs(p.z)).toBeLessThanOrEqual(half.z)
    }
  })

  it('sits caps on the face, not half sunk into it', () => {
    const half = vec3(4, 0.25, 3)
    const { points } = placed(platform(vec3(0, 1, 0), half))
    // The geometry runs y 0…1 from its own base, so a cap's origin belongs exactly on the top face.
    for (const p of points.values()) expect(p.y).toBeCloseTo(1 + half.y, 9)
  })
})

/**
 * The grid the **editor** previews (ADR 0120).
 *
 * The point of these is that `boardGrid` and `boardOf` cannot drift: the editor draws from the first and the
 * game tiles from the second, so a difference between them is a preview that lies about where the keys go.
 */
describe('the grid a face carries', () => {
  it('agrees with the board the game tiles, cell for cell', () => {
    for (const half of [vec3(4, 0.25, 3), vec3(2.5, 0.1, 2.5), vec3(0.45, 1, 7.3)]) {
      const board = boardOf(platform(vec3(0, 1, 0), half), P)
      const grid = boardGrid(vec3(half.x * 2, half.y * 2, half.z * 2), P)
      expect(grid, `${half.x} x ${half.z}`).not.toBeNull()
      expect({ cols: grid!.cols, rows: grid!.rows, startX: grid!.startX, startZ: grid!.startZ, pitch: grid!.pitch }).toEqual({
        cols: board!.cols,
        rows: board!.rows,
        startX: board!.startX,
        startZ: board!.startZ,
        pitch: board!.pitch,
      })
    }
  })

  it('takes a full extent, not a half extent', () => {
    // 4.2 m wide on a 0.6 pitch is 7 columns; reading it as a half extent would have said 3.
    expect(boardGrid(vec3(4.2, 0.5, 0.6), P)!.cols).toBe(7)
  })

  it('reports the cell footprint, which is smaller than the pitch', () => {
    expect(boardGrid(vec3(4.2, 0.5, 0.6), P)!.size).toBeCloseTo(0.6 * 0.88, 9)
  })

  it('has no grid for a face too small for one whole cell', () => {
    expect(boardGrid(vec3(0.4, 0.5, 4), P)).toBeNull()
    expect(boardGrid(vec3(4, 0.5, 0.4), P)).toBeNull()
  })

  /** A pitch of zero would divide by nothing and tile forever. */
  it('has no grid without a pitch', () => {
    expect(boardGrid(vec3(4, 0.5, 4), { ...P, pitch: 0 })).toBeNull()
  })
})

/**
 * The key budget (ADR 0142). The level that froze every editor: one platform typed 800 000 m long, which
 * tiled as tens of millions of caps.
 */
describe('the key budget', () => {
  const ONE: KeyboardParams = { ...P, pitch: 1, maxKeys: 100 }

  it('tiles a board of exactly the budget, and none a cap over it', () => {
    expect(boardGrid(vec3(10, 0.5, 10), ONE)?.cols).toBe(10)
    expect(boardGrid(vec3(11, 0.5, 10), ONE)).toBeNull()
  })

  it('refuses the platform that froze the editor', () => {
    expect(boardGrid(vec3(33, 0.3, 800_000), { ...P, pitch: 1 })).toBeNull()
  })

  it('refuses a size that is not a number', () => {
    expect(boardGrid(vec3(NaN, 0.5, 4), P)).toBeNull()
    expect(boardGrid(vec3(Infinity, 0.5, 4), P)).toBeNull()
  })

  /** The game tiles through `boardOf`, the editor previews through `keyboardGridOf`: both must stop. */
  it('stops the game and the preview alike', () => {
    expect(boardOf(platform(vec3(0, 1, 0), vec3(5.5, 0.25, 5)), ONE)).toBeNull()
    const kb = [{ id: 'k0', type: 'Keyboard', params: {} }]
    expect(keyboardGridOf(kb, vec3(11, 0.5, 10), { keyPitch: 1, keyBudget: 100 })).toBeNull()
    expect(keyboardGridOf(kb, vec3(11, 0.5, 10), { keyPitch: 1, keyBudget: 110 })?.cols).toBe(11)
  })

  it('is 20 000 when the game has not set one', () => {
    expect(keyGeometryFrom({}).maxKeys).toBe(20_000)
  })
})

describe('what the editor asks the game', () => {
  const kb = (enabled?: boolean) => [{ id: 'k0', type: 'Keyboard', params: {}, ...(enabled === undefined ? {} : { enabled }) }]

  it('gives a grid for a node carrying a Keyboard', () => {
    expect(keyboardGridOf(kb(), vec3(4.5, 0.5, 4.5), { keyPitch: 0.9 })?.cols).toBe(5)
  })

  it('gives nothing for a node without one', () => {
    expect(keyboardGridOf([{ id: 'm0', type: 'Sequence', params: {} }], vec3(4.5, 0.5, 4.5), {})).toBeNull()
  })

  /** A switched-off component generates no caps, so it must preview none either. */
  it('gives nothing for a switched-off Keyboard', () => {
    expect(keyboardGridOf(kb(false), vec3(4.5, 0.5, 4.5), {})).toBeNull()
  })

  it('reads the live pitch, so the preview follows the Game row', () => {
    const size = vec3(6, 0.5, 6)
    expect(keyboardGridOf(kb(), size, { keyPitch: 1 })?.cols).toBe(6)
    expect(keyboardGridOf(kb(), size, { keyPitch: 2 })?.cols).toBe(3)
  })

  it('falls back to the declared defaults for anything unset', () => {
    expect(keyGeometryFrom({})).toEqual(DEFAULT_KEY_GEOMETRY)
    expect(keyGeometryFrom(undefined)).toEqual(DEFAULT_KEY_GEOMETRY)
    expect(keyGeometryFrom({ keyPitch: 'wide' })).toEqual(DEFAULT_KEY_GEOMETRY)
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

/**
 * A board a sequence carries (ADR 0154): its caps are built where it was at load, and follow it by one transform
 * a frame — on the GPU for the drawing, back through the inverse for the footfalls.
 */
describe('a board a sequence carries', () => {
  const shownAt = (position: ReturnType<typeof vec3>, extra: Partial<Parameters<typeof carry>[0]> = {}): Parameters<typeof carry>[0] => ({
    position,
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    drawScale: vec3(1, 1, 1),
    visible: true,
    fades: false,
    opacity: 1,
    ...extra,
  })
  /** A board built at (0, 1, 0), carried by the visual `now`. */
  const carried = (now: Parameters<typeof carry>[0]) => {
    const item = platform(vec3(0, 1, 0))
    const { board, caps, points } = placed(item)
    const restInverse = new THREE.Matrix4().compose(board.origin, board.quat, new THREE.Vector3(1, 1, 1)).invert()
    const delta = new THREE.Matrix4()
    const moving: Moving = { toRest: new THREE.Matrix4(), hidden: false }
    moving.hidden = !carry(now, restInverse, delta, moving.toRest)
    board.moving = moving
    return { board, caps, points, delta }
  }

  it('carries a cap from where it was built to where the board is: moved, turned and stretched', () => {
    const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0))
    const { delta } = carried(shownAt(vec3(10, 3, 0), { rotation: { x: turn.x, y: turn.y, z: turn.z, w: turn.w }, drawScale: vec3(2, 1, 1) }))
    // One metre along the board's x from its centre, stretched to two, turned a quarter to −z, moved to (10, 3, 0).
    const cap = new THREE.Vector3(1, 1, 0).applyMatrix4(delta)
    expect([cap.x, cap.y, cap.z].map((n) => Math.round(n * 1e6) / 1e6)).toEqual([10, 3, -2])
  })

  it('presses the caps where the board is now, and none where it was', () => {
    const { board, caps, points } = carried(shownAt(vec3(10, 1, 0)))
    for (const [key, at] of points) {
      expect(capsUnder([board], caps, vec3(at.x + 10, at.y + 0.3, at.z), FOOT)).toContain(key)
      expect(capsUnder([board], caps, vec3(at.x, at.y + 0.3, at.z), FOOT)).toEqual([])
    }
  })

  it('draws and presses nothing while switched off or faded to nothing, as the platform itself', () => {
    for (const now of [shownAt(vec3(0, 1, 0), { visible: false }), shownAt(vec3(0, 1, 0), { fades: true, opacity: 0 })]) {
      const { board, caps, points, delta } = carried(now)
      expect(board.moving!.hidden).toBe(true)
      expect(new THREE.Vector3(3, 4, 5).applyMatrix4(delta).length(), 'every cap folded to a point').toBe(0)
      const [, at] = [...points][0]!
      expect(capsUnder([board], caps, vec3(at.x, at.y + 0.3, at.z), FOOT)).toEqual([])
    }
  })
})

/** The riding meshes' shader: three's own standard material, with `instanceMatrix` carried by the board's row. */
describe('the riding shader', () => {
  const standard = (): { vertexShader: string; fragmentShader: string } => ({ vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader })

  it('carries instanceMatrix before every chunk that places a cap by it', () => {
    const shader = standard()
    rideShader(shader)
    const define = shader.vertexShader.indexOf('#define instanceMatrix boardInstance')
    expect(define).toBeGreaterThan(shader.vertexShader.indexOf('void main() {'))
    // Position, normal and the world position the shadows it receives are taken from.
    for (const chunk of ['defaultnormal_vertex', 'project_vertex', 'worldpos_vertex']) {
      expect(THREE.ShaderChunk[chunk as keyof typeof THREE.ShaderChunk], `${chunk} places by instanceMatrix`).toContain('instanceMatrix')
      expect(shader.vertexShader.indexOf(`#include <${chunk}>`), `${chunk} after the substitution`).toBeGreaterThan(define)
    }
  })

  it('fades the colour by the board’s opacity', () => {
    const shader = standard()
    rideShader(shader)
    expect(shader.fragmentShader).toContain('#include <color_fragment>\n\tdiffuseColor.a *= vBoardOpacity;')
    expect(shader.fragmentShader.startsWith('varying float vBoardOpacity;')).toBe(true)
  })

  it('refuses a shader without the hooks rather than drawing caps that do not follow', () => {
    expect(() => rideShader({ vertexShader: 'void main(){}', fragmentShader: '' })).toThrow(/riding patch/)
  })
})

/** Each key's own colours (ADR 0182): the letter texture a stencil, mixed between two per-cap colours. */
describe('the paint shader', () => {
  const standard = (): { vertexShader: string; fragmentShader: string } => ({ vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader })

  it('mixes each cap’s two colours by the stencil, in place of the plain map', () => {
    const shader = standard()
    paintShader(shader)
    expect(shader.vertexShader).toContain('attribute vec3 capColor;')
    expect(shader.vertexShader).toContain('vCapColor = capColor;')
    expect(shader.fragmentShader).toContain('diffuseColor.rgb *= mix(vCapColor, vInkColor, texture2D(map, vMapUv).r);')
    expect(shader.fragmentShader).not.toContain('#include <map_fragment>')
  })

  it('goes with the riding patch on a carried board', () => {
    const shader = standard()
    paintShader(shader)
    expect(() => rideShader(shader)).not.toThrow()
    expect(shader.vertexShader).toContain('vInkColor = inkColor;')
    expect(shader.vertexShader).toContain('#define instanceMatrix boardInstance')
  })

  it('refuses a shader without the hooks', () => {
    expect(() => paintShader({ vertexShader: 'void main(){}', fragmentShader: '' })).toThrow(/paint patch/)
  })
})

/** Which way the letters face (ADR 0182): the cap turned a quarter at a time about its board's up. */
describe('the letters’ facing', () => {
  it('reads the field’s four ways, and anything else as forward', () => {
    expect(['forward', 'right', 'back', 'left', 'sideways', undefined].map(facingTurns)).toEqual([0, 1, 2, 3, 0, 0])
  })

  it('turns a cap so its letter’s top, +Z on the cap, points along the board’s red +X for right', () => {
    const board = boardOf(platform(vec3(0, 1, 0), vec3(2, 0.25, 2)), P)!
    const top = (facing: number): THREE.Vector3 => {
      const cap = capsFor(board, vec3(2, 0.25, 2), { ...P, facing })[0]!
      const quat = new THREE.Quaternion()
      cap.matrix.decompose(new THREE.Vector3(), quat, new THREE.Vector3())
      return new THREE.Vector3(0, 0, 1).applyQuaternion(quat)
    }
    const near = (v: THREE.Vector3, x: number, z: number): void => {
      expect(v.x).toBeCloseTo(x, 6)
      expect(v.z).toBeCloseTo(z, 6)
    }
    near(top(0), 0, 1)
    near(top(1), 1, 0)
    near(top(2), 0, -1)
    near(top(3), -1, 0)
  })
})

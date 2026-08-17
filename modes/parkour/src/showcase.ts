import { eulerToQuat, rotateVec3, vec3, type Vec3 } from '@mp/core'
import {
  beam,
  curvedBeam,
  curvedBeamExit,
  checkpointPad,
  gapJump,
  goalPad,
  hazardPad,
  ledge,
  movingPlatform,
  padChain,
  platform,
  ramp,
  rotatingBar,
  spawnPad,
  spiralStaircase,
  staircase,
  type Level,
  type PrefabInstance,
} from '@mp/content'

/**
 * The obstacle courses run **outside** the 64 m ground slab, so stepping off is a real fall to the
 * kill plane rather than a hop onto grass. Their tops sit flush with the ground (y = 0, so a piece
 * of thickness 0.5 is centred at −0.25) — you walk straight on with no step up.
 *
 * Each obstacle is preceded by a checkpoint pad that doubles as its entry platform, so a failure
 * costs one attempt instead of the walk back. Checkpoint *order* is instance order (the mode only
 * ever advances your saved index), so the beam course is listed before the pad course.
 */
const FLUSH_Y = -0.25

/** A checkpoint that is also the platform you stand on to start the next obstacle. */
const gate = (x: number, z: number): PrefabInstance => ({
  prefab: checkpointPad({ width: 3, depth: 3 }),
  transform: { position: vec3(x, FLUSH_Y, z) },
})

/** Beams run along z here, so each instance is turned a quarter turn about +y. */
const alongZ = { rotation: vec3(0, Math.PI / 2, 0) }

/**
 * Beam course — footing area, walking only. Widths step down 1.2 → 0.8 → 0.4 m, which is ±0.85 →
 * ±0.65 → ±0.45 m of margin. Pieces abut exactly: this course is about holding a line, so there is
 * nothing to jump. Runs +z from the slab edge at z = 32.
 */
const beamCourse: PrefabInstance[] = [
  { prefab: platform({ width: 10, depth: 6 }), transform: { position: vec3(0, FLUSH_Y, 33) } }, // entry, overlaps the slab
  gate(0, 37.5),
  { prefab: beam({ width: 1.2, length: 14 }), transform: { position: vec3(0, FLUSH_Y, 46), ...alongZ } },
  gate(0, 54.5),
  { prefab: beam({ width: 0.8, length: 14 }), transform: { position: vec3(0, FLUSH_Y, 63), ...alongZ } },
  gate(0, 71.5),
  { prefab: beam({ width: 0.4, length: 14 }), transform: { position: vec3(0, FLUSH_Y, 80), ...alongZ } },
  { prefab: platform({ width: 5, depth: 5, style: 'goal' }), transform: { position: vec3(0, FLUSH_Y, 89.5) } },
]

/**
 * Pad course — footing continuity, jump to jump. Gaps are edge-to-edge, against a measured maximum
 * of 3.5 m on the level and ≈0.35 m less per metre climbed. Runs +x from the slab edge at x = 32.
 * The zig-zag's real jump is the diagonal, hypot(2.2, 2.0) ≈ 3.0 m, which is why its gap is shorter
 * than the straight runs'. gym.test.ts asserts every one of these is actually clearable.
 */
const padCourse: PrefabInstance[] = [
  { prefab: platform({ width: 8, depth: 8 }), transform: { position: vec3(31, FLUSH_Y, 0) } }, // entry, overlaps the slab
  gate(37, 0),
  // generous: wide pads, short hops
  { prefab: padChain({ pads: 4, padSize: 1.6, gap: 1.5 }), transform: { position: vec3(41, FLUSH_Y, 0) } },
  gate(55, 0),
  // standard: mid pads, mid gaps
  { prefab: padChain({ pads: 4, padSize: 1.2, gap: 2.5 }), transform: { position: vec3(59, FLUSH_Y, 0) } },
  gate(75, 0),
  // long: near the edge of the envelope, small targets
  { prefab: padChain({ pads: 4, padSize: 1, gap: 3.2 }), transform: { position: vec3(79, FLUSH_Y, 0) } },
  gate(96, 0),
  // zig-zag: the jump is never straight ahead
  { prefab: padChain({ pads: 5, padSize: 1.2, gap: 2.2, lateral: 2 }), transform: { position: vec3(100, FLUSH_Y, 0) } },
  gate(118, 0),
  // ascending: the climb eats reach, so the gap is shorter than it looks
  { prefab: padChain({ pads: 5, padSize: 1.4, gap: 2.2, rise: 1 }), transform: { position: vec3(122, FLUSH_Y, 0) } },
  // Last pad's far edge is x = 137.1 at top y = 4; this pad's near edge is 2.4 m past it, level.
  { prefab: platform({ width: 5, depth: 5, style: 'goal' }), transform: { position: vec3(142, FLUSH_Y + 4, 0) } },
]

/**
 * Curve course — footing area again, but the line keeps moving. A straight beam only asks you to
 * hold one direction, which is why it works as an introduction and nothing more; an arc asks you to
 * keep changing direction and to swing the camera with you.
 *
 * Laid out by walking a cursor along the arcs' own exit points, so each piece starts exactly where
 * the previous one ended. Runs +x from the slab edge at x = 32, on the z = 20 line.
 */
const curveCourse: PrefabInstance[] = (() => {
  const out: PrefabInstance[] = []
  let at = vec3(40, FLUSH_Y, 20) // entry to the first arc
  let heading = 0 // radians of turn accumulated from +x

  /** Append an arc from the cursor, then advance the cursor to its exit. */
  const arc = (o: Parameters<typeof curvedBeam>[0]): void => {
    const rotation = vec3(0, -heading, 0)
    out.push({ prefab: curvedBeam(o), transform: { position: { ...at }, rotation } })
    const exit = curvedBeamExit(o)
    const world: Vec3 = rotateVec3(eulerToQuat(rotation), exit.position)
    at = vec3(at.x + world.x, at.y, at.z + world.z)
    heading += exit.headingRad
  }

  /** A landing pad + checkpoint at the cursor, nudged along the current heading. */
  const gateHere = (ahead: number): void => {
    const step = rotateVec3(eulerToQuat(vec3(0, -heading, 0)), vec3(ahead, 0, 0))
    at = vec3(at.x + step.x, at.y, at.z + step.z)
    out.push({ prefab: checkpointPad({ width: 3, depth: 3 }), transform: { position: { ...at } } })
    const step2 = rotateVec3(eulerToQuat(vec3(0, -heading, 0)), vec3(ahead, 0, 0))
    at = vec3(at.x + step2.x, at.y, at.z + step2.z)
  }

  out.push({ prefab: platform({ width: 10, depth: 6 }), transform: { position: vec3(33, FLUSH_Y, 20) } }) // overlaps the slab
  out.push({ prefab: checkpointPad({ width: 3, depth: 3 }), transform: { position: vec3(38, FLUSH_Y, 20) } })

  arc({ radius: 12, sweepDeg: 90, width: 1.2 }) // gentle: a long, wide sweep to learn the turn
  gateHere(1.5)
  arc({ radius: 6, sweepDeg: -120, width: 0.8 }) // tight, and reverses the turn direction
  gateHere(1.5)
  arc({ radius: 5, sweepDeg: 90, width: 0.6 }) // S-bend, first half
  arc({ radius: 5, sweepDeg: -90, width: 0.6 }) // …and back the other way, no rest between
  gateHere(1.5)
  arc({ radius: 4, sweepDeg: 180, width: 0.8 }) // hairpin

  const end = rotateVec3(eulerToQuat(vec3(0, -heading, 0)), vec3(3, 0, 0))
  out.push({
    prefab: platform({ width: 5, depth: 5, style: 'goal' }),
    transform: { position: vec3(at.x + end.x, FLUSH_Y, at.z + end.z) },
  })
  return out
})()

/**
 * The test gym — NOT designed content (that's Kodjo's). Two jobs:
 *
 * 1. Kit sampler (rows at z ≈ 0 … 16): every kit piece + both generators, so the polished
 *    renderer and clock-driven behaviors are visible in one place.
 * 2. Platform-carry bench (rows at z = -20 and z = -28): the cases that only work if the
 *    character rides the surface underfoot — horizontal travel along both axes, a turntable
 *    (off-centre = orbit), and a fast mover whose inherited velocity is the *only* way to
 *    clear the last gap.
 * 3. Beam course (+z past the slab edge), pad course (+x at z = 0) and curve course (+x at z = 20):
 *    the obstacle stages, over real void, laid out easiest-first so the curve can be felt.
 */
export const showcase: Level = {
  id: 'kit-sampler',
  config: { fallBehavior: 'respawn-checkpoint', fallY: -5 },
  instances: [
    // ground
    { prefab: platform({ width: 64, depth: 64, thickness: 1, style: 'ground' }), transform: { position: vec3(0, -0.5, 0) } },

    // static footing & traversal (a row along +x)
    { prefab: platform(), transform: { position: vec3(-18, 0.75, 0) } },
    { prefab: ledge(), transform: { position: vec3(-11, 0.65, 0) } },
    { prefab: ramp(), transform: { position: vec3(-4, 1, 0) } },
    { prefab: gapJump(), transform: { position: vec3(5, 0.75, 0) } },

    // clock-driven (grounded by small platforms so the motion reads)
    { prefab: platform({ width: 4, depth: 4 }), transform: { position: vec3(13, 0.75, 0) } },
    { prefab: movingPlatform(), transform: { position: vec3(13, 2.5, 0) } },
    { prefab: platform({ width: 4, depth: 4 }), transform: { position: vec3(20, 0.75, 0) } },
    { prefab: rotatingBar(), transform: { position: vec3(20, 2, 0) } },

    // generators (a second row)
    { prefab: staircase(), transform: { position: vec3(-20, 0.75, 12) } },
    { prefab: spiralStaircase(), transform: { position: vec3(4, 0.75, 16) } },

    // marker pads (a row along -z)
    { prefab: spawnPad(), transform: { position: vec3(-6, 0.75, -10) } },
    { prefab: checkpointPad(), transform: { position: vec3(1, 0.75, -10) } },
    { prefab: goalPad(), transform: { position: vec3(8, 0.75, -10) } },
    { prefab: hazardPad(), transform: { position: vec3(15, 2.6, -10) } },

    // ---- carry bench, row A (z = -20): ride it, don't slip off -------------------------
    // Board from the ground (platform tops sit 1 m up — one jump).
    { prefab: platform({ width: 4, depth: 4 }), transform: { position: vec3(-18, 0.75, -20) } },
    // Travels 8 m along +x and back over 6 s (peak ≈ 4.2 m/s — faster than a walk, so
    // standing still on it is unmistakable). Stand still: you should go with it.
    { prefab: movingPlatform({ width: 4, depth: 4, axis: vec3(1, 0, 0), distance: 8, periodMs: 6000 }), transform: { position: vec3(-13, 0.75, -20) } },
    // Step off onto solid ground mid-bench (carry must stop the moment you leave).
    { prefab: platform({ width: 4, depth: 4 }), transform: { position: vec3(-2, 0.75, -20) } },
    // Same again across +z, to catch an axis-specific mistake.
    { prefab: movingPlatform({ width: 4, depth: 4, axis: vec3(0, 0, 1), distance: 6, periodMs: 5000 }), transform: { position: vec3(4, 0.75, -20) } },
    // Turntable: one turn per 8 s. On the axis nothing happens; at the rim (r ≈ 3.5 m) you
    // are swept ≈ 2.7 m/s. Tests the rotational half of carry — and whether facing should
    // turn with it (open question).
    {
      prefab: platform({ width: 8, depth: 8, thickness: 0.4, style: 'moving' }),
      transform: { position: vec3(14, 0.75, -20) },
      behavior: { kind: 'rotate', axis: vec3(0, 1, 0), periodMs: 8000 },
    },

    // ---- carry bench, row B (z = -28): jump momentum ----------------------------------
    { prefab: platform({ width: 4, depth: 4 }), transform: { position: vec3(-14, 0.75, -28) } },
    // 12 m of travel in 4 s → peak ≈ 9.4 m/s, double the run speed. Ride to the far end and
    // jump: the inherited velocity is what gets you across.
    { prefab: movingPlatform({ width: 4, depth: 4, axis: vec3(1, 0, 0), distance: 12, periodMs: 4000 }), transform: { position: vec3(-10, 0.75, -28) } },
    // The mover's far edge is x = 4. This pad's near edge is 4.5 m past it — beyond the 3.5 m
    // a plain jump covers, and inside the ≈6 m you get riding to the far end and jumping with
    // the platform's speed. Release the stick in the air: holding forward steers you back down
    // toward walking pace and you fall short.
    { prefab: platform({ width: 5, depth: 5 }), transform: { position: vec3(11, 0.75, -28) } },

    ...beamCourse,
    ...padCourse,
    ...curveCourse,
  ],
}

/** The courses in walk order, for the seam checks in `gym.test.ts`. */
export const courses = { beam: beamCourse, pads: padCourse, curves: curveCourse } as const

import { vec3 } from '@mp/core'
import {
  checkpointPad,
  gapJump,
  goalPad,
  hazardPad,
  ledge,
  movingPlatform,
  platform,
  ramp,
  rotatingBar,
  spawnPad,
  spiralStaircase,
  staircase,
  type Level,
} from '@mp/content'

/**
 * The test gym — NOT designed content (that's Kodjo's). Two jobs:
 *
 * 1. Kit sampler (rows at z ≈ 0 … 16): every kit piece + both generators, so the polished
 *    renderer and clock-driven behaviors are visible in one place.
 * 2. Platform-carry bench (rows at z = -20 and z = -28): the cases that only work if the
 *    character rides the surface underfoot — horizontal travel along both axes, a turntable
 *    (off-centre = orbit), and a fast mover whose inherited velocity is the *only* way to
 *    clear the last gap.
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
    // Sits 7 m past the mover's far end (x = 2) — a standing jump reaches ≈ 5.4 m, so this
    // is only clearable with the platform's speed. If you can't land it, momentum is broken.
    { prefab: platform({ width: 5, depth: 5 }), transform: { position: vec3(9, 0.75, -28) } },
  ],
}

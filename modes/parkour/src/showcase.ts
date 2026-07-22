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
 * Throwaway kit sampler (content pipeline C2/C3 validation — NOT the real level; that's
 * Kodjo's design). Lays every kit piece + both generators out on a ground plane so the
 * polished renderer and clock-driven behaviors are visible in one place: ramps tilt, the
 * moving platform oscillates, the bar spins, stairs/spiral are generated, markers glow.
 * Delete once the viewer (C4) can pick pieces directly.
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
  ],
}

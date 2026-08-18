import { vec3 } from '@mp/core'
import {
  beam,
  checkpointPad,
  curvedBeam,
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
  validateLevel,
  type Level,
  type Prefab,
} from '@mp/content'

import level1 from '../../../content/levels/level1.json'

/**
 * The viewer's catalog: individual kit pieces/generators (each dropped on a small ground
 * pad for inspection) and full levels. The picker chooses one; the viewer instantiates it.
 */
export interface Entry {
  name: string
  group: 'element' | 'level'
  level: Level
}

// One prefab on a small ground pad, centred for inspection.
const solo = (name: string, prefab: Prefab, y = 0.75): Entry => ({
  name,
  group: 'element',
  level: {
    id: name,
    config: { fallBehavior: 'physical-fall', fallY: -20 },
    instances: [
      { prefab: platform({ width: 16, depth: 16, thickness: 1, style: 'ground' }), transform: { position: vec3(0, -0.5, 0) } },
      { prefab, transform: { position: vec3(0, y, 0) } },
    ],
  },
})

// A rich sampler exercising every kit piece + both generators + all marker/trigger pads.
const sampler: Level = {
  id: 'kit-sampler',
  config: { fallBehavior: 'respawn-checkpoint', fallY: -5 },
  instances: [
    { prefab: platform({ width: 64, depth: 64, thickness: 1, style: 'ground' }), transform: { position: vec3(0, -0.5, 0) } },
    { prefab: platform(), transform: { position: vec3(-18, 0.75, 0) } },
    { prefab: ledge(), transform: { position: vec3(-11, 0.65, 0) } },
    { prefab: ramp(), transform: { position: vec3(-4, 1, 0) } },
    { prefab: gapJump(), transform: { position: vec3(5, 0.75, 0) } },
    { prefab: platform({ width: 4, depth: 4 }), transform: { position: vec3(13, 0.75, 0) } },
    { prefab: movingPlatform(), transform: { position: vec3(13, 2.5, 0) } },
    { prefab: platform({ width: 4, depth: 4 }), transform: { position: vec3(20, 0.75, 0) } },
    { prefab: rotatingBar(), transform: { position: vec3(20, 2, 0) } },
    { prefab: staircase(), transform: { position: vec3(-20, 0.75, 12) } },
    { prefab: spiralStaircase(), transform: { position: vec3(4, 0.75, 16) } },
    { prefab: spawnPad(), transform: { position: vec3(-6, 0.75, -10) } },
    { prefab: checkpointPad(), transform: { position: vec3(1, 0.75, -10) } },
    { prefab: goalPad(), transform: { position: vec3(8, 0.75, -10) } },
    { prefab: hazardPad(), transform: { position: vec3(15, 0.1, -10) } },
  ],
}

export const ENTRIES: Entry[] = [
  solo('platform', platform()),
  solo('ledge', ledge()),
  solo('beam', beam()),
  solo('ramp', ramp()),
  solo('gap jump', gapJump()),
  solo('pad chain', padChain()),
  solo('curved beam', curvedBeam()),
  solo('moving platform', movingPlatform(), 2),
  solo('rotating bar', rotatingBar(), 2),
  solo('staircase', staircase()),
  solo('spiral staircase', spiralStaircase()),
  solo('spawn pad', spawnPad()),
  solo('checkpoint pad', checkpointPad()),
  solo('goal pad', goalPad()),
  solo('hazard pad', hazardPad()),
  { name: 'kit sampler', group: 'level', level: sampler },
  { name: 'level1', group: 'level', level: validateLevel(level1) },
]

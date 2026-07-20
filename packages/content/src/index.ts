/**
 * @mp/content — data-driven content pipeline. Schema + validation for prefabs and
 * levels; the loader (Rapier colliders + visual list + behaviors) and the greybox kit
 * build on these types. Headless (no rendering) — the loader is imported by the game,
 * bots, and the viewer. See ADR (content pipeline).
 */
export const CONTENT_VERSION = '0.0.0' as const

export type {
  Transform,
  ColliderDesc,
  Visual,
  Piece,
  Marker,
  Behavior,
  Prefab,
  PrefabInstance,
  LevelConfig,
  Level,
} from './types'
export { validateLevel, LevelError } from './validate'
export type { LoadedLevel, WorldMarker, VisualItem } from './loader'
export { instantiateLevel } from './loader'

export { KIT_STYLE, platform, ledge, ramp, gapJump, movingPlatform, rotatingBar, spawnPad, checkpointPad, goalPad, hazardPad } from './kit'
export type {
  PlatformOpts,
  RampOpts,
  GapJumpOpts,
  MovingPlatformOpts,
  RotatingBarOpts,
  PadOpts,
} from './kit'
export { staircase, spiralStaircase } from './generators'
export type { StaircaseOpts, SpiralStaircaseOpts } from './generators'

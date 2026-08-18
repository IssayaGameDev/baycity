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
  TriggerKind,
} from './types'
export { validateLevel, LevelError } from './validate'
export { resolvePrefab, instancesOf, freeTableId, walkInstances } from './resolve'
export { ASSET_KINDS, assetsOfKind, buildDatabase, entriesFrom, entryFor, kindForPath, materialDependencies, META_SUFFIX, nameForPath, visualMaterial, visualModel, visualStyle } from './assets'
export type { AssetDatabase, AssetEntry, AssetKind, AssetMeta, MaterialAsset, MaterialValue } from './assets'
export type { InstanceVisit } from './resolve'
export type { LoadedLevel, WorldMarker, WorldTrigger, VisualItem } from './loader'
export { instantiateLevel } from './loader'

export { KIT_STYLE, platform, ledge, beam, ramp, gapJump, movingPlatform, rotatingBar, spawnPad, checkpointPad, goalPad, hazardPad } from './kit'
export type {
  PlatformOpts,
  BeamOpts,
  RampOpts,
  GapJumpOpts,
  MovingPlatformOpts,
  RotatingBarOpts,
  PadOpts,
} from './kit'
export { staircase, spiralStaircase, padChain, curvedBeam, curvedBeamExit } from './generators'
export type { StaircaseOpts, SpiralStaircaseOpts, PadChainOpts, CurvedBeamOpts } from './generators'

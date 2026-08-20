/**
 * @mp/content — data-driven content pipeline. Schema + validation for prefabs and levels; the loader
 * (Rapier colliders + visual list + keyframe tracks) and the asset layer build on these types. Headless
 * (no rendering) — the loader is imported by the game, bots, the viewer and the editor. ADR 0014.
 */
export const CONTENT_VERSION = '0.0.0' as const

export type {
  Transform,
  ColliderDesc,
  Visual,
  Piece,
  PieceOverride,
  Marker,
  Behavior,
  Easing,
  Keyframe,
  LoopMode,
  Prefab,
  PrefabInstance,
  LevelConfig,
  Level,
  TriggerKind,
} from './types'
export { validateLevel, LevelError } from './validate'
export { resolvePrefab, effectivePieces, overriddenFields, instancesOf, freeTableId, walkInstances } from './resolve'
export { ASSET_KINDS, assetsOfKind, buildDatabase, entriesFrom, entryFor, kindForPath, materialDependencies, META_SUFFIX, nameForPath, visualMaterial, visualModel } from './assets'
export type { AssetDatabase, AssetEntry, AssetKind, AssetMeta, MaterialAsset, MaterialValue } from './assets'
export type { InstanceVisit } from './resolve'
export type { LoadedLevel, WorldMarker, WorldTrigger, VisualItem } from './loader'
export { instantiateLevel } from './loader'
export { easeAt, isAnimated, moveTrack, poseAt, spinTrack, trackDuration, trackTime } from './track'
export type { Pose } from './track'

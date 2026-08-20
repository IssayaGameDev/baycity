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
  Trigger,
  TriggerKind,
} from './types'
export type { ComponentData, Node, NodeLevel, NodeOverride } from './types'
export {
  COLLIDER,
  MATERIAL_OVERRIDE,
  SPAWN,
  TRACK,
  VISUAL,
  bakeOverrides,
  componentsOfType,
  effectiveNode,
  firstOfType,
  numberParam,
  stringParam,
  vec3Param,
  walkNodes,
} from './nodes'
export type { Resolved, TypeInfo } from './nodes'
export { validateNodeLevel } from './nodeValidate'
export type { ParamChecker } from './nodeValidate'
export { validateLevel, LevelError } from './validate'
export { resolvePrefab, effectivePieces, overriddenFields, instancesOf, freeTableId, freeTableKey, walkInstances } from './resolve'
export { ASSET_KINDS, assetsOfKind, buildDatabase, entriesFrom, entryFor, kindForPath, materialDependencies, META_SUFFIX, nameForPath, visualMaterial, visualModel } from './assets'
export type { AssetDatabase, AssetEntry, AssetKind, AssetMeta, MaterialAsset, MaterialValue } from './assets'
export type { InstanceVisit } from './resolve'
export type { BasePhase, LoadedLevel, WorldMarker, WorldTrigger, VisualItem } from './loader'
export { instantiateLegacyLevel } from './loader'
export { instantiateNodeLevel } from './nodeLoader'
export type { LoadedNodeLevel, WorldNode } from './nodeLoader'
export { easeAt, isAnimated, moveTrack, poseAt, spinTrack, trackDuration, trackTime } from './track'
export type { Pose } from './track'

/**
 * @mp/content — the data-driven content pipeline. Schema and validation for levels and prefabs, the loader
 * (Rapier colliders + a visual list + keyframe tracks), and the asset layer. Headless (no rendering) — the
 * loader is imported by the game, the bots, the viewer and the editor. ADR 0014, ADR 0035.
 *
 * Never imports `@mp/components`: where it needs a component's declaration it takes a registry as an argument
 * (`TypeInfo`, `ParamChecker`), which keeps the dependency one-way.
 */
export const CONTENT_VERSION = '0.0.0' as const

export type { ColliderDesc, ComponentData, Level, LevelConfig, ModeRef, SunConfig, AmbientConfig, EnvironmentConfig, PostFXConfig, SkyConfig, Node, NodeOverride, Transform } from './types'
export {
  COLLIDER,
  LIGHT,
  MATERIAL_OVERRIDE,
  MESH,
  MOVER,
  RENDERER,
  SPINNER,
  SPAWN,
  bakeOverrides,
  boolParam,
  componentsOfType,
  effectiveNode,
  firstOfType,
  freeTableKey,
  numberParam,
  stringParam,
  vec3Param,
  walkNodes,
} from './nodes'
export type { Resolved, TypeInfo } from './nodes'
export { LevelError, validateLevel, validateNodeTree, validateConfig, checkTransform, checkComponents, checkOverrides } from './validate'
export type { ParamChecker, TreeContext } from './validate'
export { applyOp, applyBatch, invertOp, touchedRefs, refKey, isInherited, OpError } from './ops'
export type { Op, OpBody, OpKind, NodeRef, OwnRef, InheritedRef } from './ops'
export { instantiateLevel } from './loader'
export { hydratePrefabs, stripHydrated, prefabRefsIn, unlinkPrefab, unlinkedNode, type UnlinkDeps } from './prefabs'
export { fingerprintLevel, fingerprintGeometry, firstDifference } from './fingerprint'
export { matchEntry, migrateLevelRefs, newRefReport } from './migratePrefabRefs'
export type { Match, PrefabFile, RefReport } from './migratePrefabRefs'
export type { PrefabSource } from './prefabs'
export { BUILTIN_MODELS, BUILTIN_LABELS, isBuiltinModel, unitColliderFor, scaleCollider, builtinShape, PRIMITIVE_ORDER, PRIMITIVE_PRESETS, PRIMITIVE_LABELS } from './primitives'
export type { BuiltinModel, PrimitiveKind, PrimitivePreset } from './primitives'
export { migrateNode, migrateLevel, migratePrefabTree, newReport } from './migratePrimitives'
export type { MigrationReport } from './migratePrimitives'
export type { BasePhase, LoadedLevel, NodeDrive, VisualItem, WorldLight, WorldMarker, WorldNode } from './loader'
export {
  ASSET_KINDS,
  META_SUFFIX,
  assetsOfKind,
  buildDatabase,
  entriesFrom,
  entryFor,
  kindForPath,
  materialDependencies,
  nameForPath,
} from './assets'
export type { AssetDatabase, AssetEntry, AssetKind, AssetMeta, MaterialAsset, MaterialValue } from './assets'
export { AXES, AXIS_NAMES, MOTIONLESS, motionOffset, motionsOf, moveFraction, movesAtAll, spinRadians } from './motion'
export type { Motion, MotionOffset } from './motion'

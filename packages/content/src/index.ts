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
  RENDERER,
  SEQUENCE,
  SPAWN,
  bakeOverrides,
  childrenFor,
  boolParam,
  componentsOfType,
  effectiveNode,
  firstOfType,
  freeTableKey,
  modelOf,
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
export { AT_REST_POSE, EASES, SELF, TOP_FRAME, UNMOVED, channelsOf, combineSequences, compileSequence, easeAt, sampleSequence, sequenceTime } from './sequence'
export {
  diffStages,
  readStages,
  retargetSequenceOverride,
  retargetSequenceParams,
  retargetStages,
  sequenceOf,
  sequenceOverrideProblem,
  stagesFor,
  stagesProblem,
  stepProblem,
} from './sequenceData'
export type { SequenceOverride, StepPatch } from './sequenceData'
export type {
  CompiledSequence,
  Ease,
  NodeFrame,
  Sequence,
  SequenceAxes,
  SequenceChannels,
  SequenceClock,
  SequenceClocks,
  SequenceLoop,
  SequenceOffset,
  SequencePart,
  SequencePose,
  SequenceProblem,
  Span,
  Stage,
  Step,
  StepKind,
  Timing,
} from './sequence'
export { hydratePrefabs, stripHydrated, prefabRefsIn, retargetRef, unlinkPrefab, unlinkedNode, type UnlinkDeps } from './prefabs'
export { OVERRIDE_FIELDS, OVERRIDE_FIELD_NAMES, addedIdsOf, childListsOf, forEachNode, idsUnder, overrideFieldEmpty, overrideFieldsSet } from './tree'
export type { OverrideField } from './tree'
export { fingerprintLevel, fingerprintGeometry, firstDifference } from './fingerprint'
export { matchEntry, migrateLevelRefs, newRefReport } from './migratePrefabRefs'
export {
  ASSETS_DIR,
  GAME_FILE,
  LEVELS_DIR,
  LEVEL_SUFFIX,
  gameFile,
  inLibrary,
  isGameName,
  libraryDir,
  libraryOf,
  mayUse,
  isSegment,
  levelFile,
  levelRefForFile,
  parseQualified,
  qualify,
} from './layout'
export type { LevelRef } from './layout'
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
  contentTypeFor,
  entriesFrom,
  entryFor,
  isDataAsset,
  kindForPath,
  materialDependencies,
  nameForPath,
} from './assets'
export type { AssetDatabase, AssetEntry, AssetKind, AssetMeta, DataAsset, MaterialAsset, MaterialValue } from './assets'
export { LiveAssetError, applyAssetOps, diffAssetOps, gameDocId, gameOfDocId, isAssetOp, isLiveAssetPath, LIVE_ASSET_KINDS, mergeAssetOps, validateLiveAsset } from './liveAssets'
export type { AssetOp, LiveKind } from './liveAssets'
export { assetsUsedBy, levelsUsing, usersOf } from './usage'
export { DEFAULT_LEVEL, PLAY_CONTENT_DIR, levelIndexFile, levelIndexOf, levelNeeds, levelNeedsFile, levelOfNeedsFile } from './levelNeeds'
export type { ContentCatalog, LevelIndex, LevelNeeds, NeededAsset } from './levelNeeds'

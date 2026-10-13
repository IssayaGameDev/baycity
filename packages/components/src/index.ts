/**
 * @mp/components — the component system's machinery and its built-in definitions.
 *
 * A node holds a **list** of components; each is a declared set of parameters, editable in the Inspector
 * and serialized into content. See `PLAN-component-system.md`.
 *
 * Depends on `@mp/content` (for `ColliderDesc` and `Keyframe`), never the reverse: content owns the schema
 * and takes a `Registry` as an argument where it needs to check parameters. Two-way would be a cycle.
 */
export const COMPONENTS_VERSION = '0.0.0' as const

export { ComponentError, defaultsOf, readParams, visibleParams } from './params'
export type {
  AssetSpec,
  BoolSpec,
  ColliderSpec,
  ComponentRef,
  ComponentRefSpec,
  EnumSpec,
  ListSpec,
  NodeRefSpec,
  NumberSpec,
  ParamDecls,
  Params,
  ParamSpec,
  ParamWhen,
  RawParams,
  ColorSpec,
  StagesSpec,
  StringSpec,
  ValueOf,
  Vec3Spec,
} from './params'
export { defineComponent } from './define'
export { dataMenuPath, defineDataType, newDataAsset, readData } from './data'
export type { DataTypeDef } from './data'
export type { ComponentDef, ComponentSpec } from './define'
export { characterAccess, createComponentRuntime, hasHooks } from './runtime'
export type { PlayerView } from './runtime'
export type { CharacterAccess, ComponentRuntime, Ctx, Effects, ErasedHooks, FoundComponent, Hit, Self } from './runtime'
export { createRegistry } from './registry'
export type { AnyComponentDef, Registry } from './registry'
export { ENGINE_COMPONENTS } from './engine/index'
export { Collider } from './engine/collider'
export { MaterialOverride } from './engine/materialOverride'
export { Renderer } from './engine/renderer'
export { Spawn } from './engine/spawn'
export { isSharedComponent, SHARED_COMPONENT_TYPES, SHARED_COMPONENTS, sharedComponents } from './shared/index'
export { Bumper } from './shared/bumper'
export { Hazard } from './shared/hazard'
export { Sequence } from './shared/sequence'
export { PLAYER_COMPONENTS } from './player/index'
export { Death } from './player/death'
export { DEFAULT_REGISTRY } from './defaults'
export { assetParamIds, componentOn, hasComponent } from './read'

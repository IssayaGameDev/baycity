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
  EnumSpec,
  NodeRefSpec,
  NumberSpec,
  ParamDecls,
  Params,
  ParamSpec,
  ParamWhen,
  RawParams,
  ColorSpec,
  StringSpec,
  ValueOf,
  Vec3Spec,
} from './params'
export { defineComponent } from './define'
export type { ComponentDef, ComponentSpec } from './define'
export { characterAccess, createComponentRuntime, hasHooks } from './runtime'
export type { PlayerView } from './runtime'
export type { CharacterAccess, ComponentRuntime, Ctx, Effects, ErasedHooks, Hit, Self } from './runtime'
export { createRegistry } from './registry'
export type { AnyComponentDef, Registry } from './registry'
export { Collider, ENGINE_COMPONENTS, MaterialOverride, Mesh, Renderer, Spawn } from './engine'
export { Bumper, Checkpoint, Death, GAMEPLAY_COMPONENTS, Goal, Hazard, Mover, PLAYER_COMPONENTS, Spinner } from './gameplay'
export { DEFAULT_REGISTRY } from './defaults'
export { assetParamIds, componentOn, hasComponent } from './read'
export { isSharedComponent, SHARED_COMPONENT_TYPES, sharedComponents } from './shared'

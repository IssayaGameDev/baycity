import type { ParamDecls, Params } from './params'
import type { Ctx, ErasedHooks, Hit, Self } from './runtime'

/**
 * A component definition: a name, its declared parameters, and optional lifecycle hooks.
 *
 * The hooks are stored **erased** (`ErasedHooks`), because a registry holds definitions of many different
 * parameter and state types and a hook is contravariant in the `self` it takes. `defineComponent` is the one
 * place that knows a definition's `D` and `S` agree with its own hooks, so it is the one place that casts.
 */
export interface ComponentDef<D extends ParamDecls = ParamDecls> {
  /** Registry key, and what lands in JSON. Capitalised like Unity's own (`Collider`, `Visual`). */
  readonly type: string
  readonly params: D
  /** Inspector heading. Falls back to `type`. */
  readonly label?: string
  /**
   * At most one per node — the add menu offers it greyed out once present.
   *
   * Set only where a second copy is *meaningless*, never as a taste call: two `Visual`s draw two meshes at
   * one transform, two `Spawn`s name one point twice. Colliders and gameplay rules are repeatable on
   * purpose, which is half the reason for a list instead of a field.
   */
  readonly singleton?: boolean
  /** What the runner calls. Absent means this component is data only, and the runner skips it entirely. */
  readonly hooks?: ErasedHooks
}

/**
 * A component as it is written: declarations plus hooks, typed against each other.
 *
 * `init` returns the instance's runtime state and takes no `self`, because there is no state yet when it
 * runs. Everything after it sees `self.state` typed as whatever `init` returned.
 */
export interface ComponentSpec<D extends ParamDecls, S> {
  readonly type: string
  readonly params: D
  readonly label?: string
  readonly singleton?: boolean
  readonly init?: (params: Params<D>, ctx: Ctx) => S
  /** Once, when the level is instantiated. Unity's Awake and Start, merged. */
  readonly onAttach?: (self: Self<D, S>, ctx: Ctx) => void
  /** Every sim tick, fixed step. Unity's FixedUpdate. There is deliberately no per-frame hook. */
  readonly onFixedUpdate?: (self: Self<D, S>, ctx: Ctx) => void
  /** A collider on this node was touched. Unity's OnCollision*, delivered to the node, not to the collider. */
  readonly onContact?: (self: Self<D, S>, ctx: Ctx, hit: Hit) => void
  /** Teardown. */
  readonly onDetach?: (self: Self<D, S>, ctx: Ctx) => void
}

/**
 * Identity, plus the hook erasure.
 *
 * `const` on the type parameter keeps `options: ['loop', 'once']` a literal union instead of widening it to
 * `string[]`, so `self.params.loop` narrows inside the component's own code.
 */
export const defineComponent = <const D extends ParamDecls, S = undefined>(spec: ComponentSpec<D, S>): ComponentDef<D> => {
  const hooks: ErasedHooks | undefined =
    spec.init === undefined && spec.onAttach === undefined && spec.onFixedUpdate === undefined && spec.onContact === undefined && spec.onDetach === undefined
      ? undefined
      : // The one cast in the component system. Safe because `spec`'s hooks were checked against this very
        // `D` and `S` at the call site, and the runner only ever hands a hook the instance built from the
        // same definition.
        (spec as unknown as ErasedHooks)
  return {
    type: spec.type,
    params: spec.params,
    ...(spec.label !== undefined ? { label: spec.label } : {}),
    ...(spec.singleton !== undefined ? { singleton: spec.singleton } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
  }
}

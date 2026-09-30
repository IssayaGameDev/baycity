import type { ParamDecls, Params } from './params'
import type { InputCommand } from '@mp/core'

import { HOOK_NAMES, type Ctx, type ErasedHooks, type Hit, type Self } from './runtime'

/**
 * A component definition: a name, its declared parameters, and optional lifecycle hooks.
 *
 * The hooks are stored **erased** (`ErasedHooks`), because a registry holds definitions of many different
 * parameter and state types and a hook is contravariant in the `self` it takes. `defineComponent` is the one
 * place that knows a definition's `D` and `S` agree with its own hooks, so it is the one place that casts.
 */
export interface ComponentDef<D extends ParamDecls = ParamDecls> {
  /** Registry key, and what lands in JSON. Capitalised like Unity's own (`Collider`, `Renderer`). */
  readonly type: string
  readonly params: D
  /** Inspector heading. Falls back to `type`. */
  readonly label?: string
  /**
   * Its folder in the Add Component menu — Unity's `AddComponentMenu` path (ADR 0178): `Physics`, `Rendering`,
   * `Gameplay`, `Animation`. Absent on a game's own component, which goes in a folder named after its game.
   */
  readonly menu?: string
  /**
   * At most one per node — the add menu offers it greyed out once present.
   *
   * Set only where a second copy is *meaningless*, never as a taste call: two `Renderer`s draw one node
   * twice, two `Spawn`s name one point twice. Colliders and gameplay rules are repeatable on
   * purpose, which is half the reason for a list instead of a field.
   */
  readonly singleton?: boolean
  /**
   * This component moves the node it sits on, so `self.offset` is live and the node is posed every tick.
   *
   * **Declared, not inferred.** The loader has to know before it builds anything: a node nothing moves gets a
   * *fixed* physics body and sits outside the per-tick pose pass, and neither is changeable afterwards. A
   * component that writes `self.offset` without declaring this finds it `undefined`, which is the honest
   * failure — the alternative is a silent no-op.
   *
   * The cost is real, so it is opt-in: a kinematic body and a frame evaluated every tick, on that node and
   * every node under it.
   */
  readonly moves?: boolean
  /**
   * Whether this belongs on a **level node** or on the **player** (ADR 0059). Defaults to `'node'`.
   *
   * A player component is declared by the game (`ModeDescriptor.player`) and never authored in a level, so
   * offering it in the editor's Add Component menu would only let somebody put a death reaction on a
   * staircase. Nothing enforces it at load — a hand-edited level naming one is not a file that fails to
   * load — it decides what a tool offers.
   */
  readonly attachesTo?: 'node' | 'player'
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
  /** See `ComponentDef.menu`. */
  readonly menu?: string
  readonly singleton?: boolean
  /** See `ComponentDef.moves`. */
  readonly moves?: boolean
  /** See `ComponentDef.attachesTo`. */
  readonly attachesTo?: 'node' | 'player'
  readonly init?: (params: Params<D>, ctx: Ctx) => S
  /** Once, when the level is instantiated. Unity's Awake and Start, merged. */
  readonly onAttach?: (self: Self<D, S>, ctx: Ctx) => void
  /** Every sim tick, fixed step. Unity's FixedUpdate. There is deliberately no per-frame hook. */
  readonly onFixedUpdate?: (self: Self<D, S>, ctx: Ctx) => void
  /**
   * The **movement slot** (ADR 0061): every sim tick, but *between* the host's two physics half-steps rather
   * than before them, and handed the tick's input.
   *
   * This is where a game's locomotion lives. It is a separate hook from `onFixedUpdate` because it is a
   * separate moment: the character has to resolve against where the platforms are now, not where they were.
   */
  readonly onLocomote?: (self: Self<D, S>, ctx: Ctx, cmd: InputCommand) => void
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
  // Every hook name, from the one list the runner also reads. Spelling them out here again is how a new hook
  // ships silently broken: a component with only that hook looks like data and the runner skips it entirely.
  const hooks: ErasedHooks | undefined =
    HOOK_NAMES.every((name) => spec[name] === undefined)
      ? undefined
      : // The one cast in the component system. Safe because `spec`'s hooks were checked against this very
        // `D` and `S` at the call site, and the runner only ever hands a hook the instance built from the
        // same definition.
        (spec as unknown as ErasedHooks)
  return {
    type: spec.type,
    params: spec.params,
    ...(spec.label !== undefined ? { label: spec.label } : {}),
    ...(spec.menu !== undefined ? { menu: spec.menu } : {}),
    ...(spec.singleton !== undefined ? { singleton: spec.singleton } : {}),
    ...(spec.moves !== undefined ? { moves: spec.moves } : {}),
    ...(spec.attachesTo !== undefined ? { attachesTo: spec.attachesTo } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
  }
}

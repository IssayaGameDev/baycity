import type { LoadedNodeLevel, WorldNode } from '@mp/content'
import type { AnyComponentDef, Registry } from './registry'
import { readParams, type ParamDecls, type Params } from './params'
import type { ComponentDef } from './define'

/**
 * Running components (PLAN-component-system, stage C2).
 *
 * A component's hooks are **pure functions of (its state, the synced tick, what it was handed)**. That is the
 * whole netcode story: motion is a function of time (ADR 0013/0021), and a hook that accumulates state is
 * fine as long as every client accumulates the same thing. So the context below deliberately withholds the
 * wall clock, `Math.random`, the network and the DOM, and offers a synced clock and a seeded random instead.
 * Determinism, not synchronization.
 *
 * The three classes of component, and where the line is:
 *
 * - **pure** — no state, or state that is a function of `tick`. Free.
 * - **local** — state that affects only this client's own character or view. Also free, and this is where
 *   every rule that exists today lives: a checkpoint, a hazard and a bumper all react to *my* contact and
 *   change *my* character, so nobody else has to agree.
 * - **shared** — state every client must agree on (a door that stays open, a button, a pushable crate). Needs
 *   an owner and a sync channel: a netcode milestone, not a component. `Ctx` gives no way to reach it, so the
 *   boundary is enforced by this API rather than by a rule in a document. That is stage C5, and Kodjo's call.
 *
 * `Track` has no hook on purpose. It is clock-driven and the loader's frame tree already evaluates it as
 * `pose = f(t)`, which is strictly better than an accumulating hook: a late joiner needs no catch-up, and a
 * static subtree costs nothing. Moving it here would trade that for nothing.
 */

/** What the local character can be asked to do. Motion only; anything about the *run* goes through `Effects`. */
export interface CharacterAccess {
  /**
   * Ask for an upward speed on the next step, which `stepCharacter` consumes (ADR 0032).
   *
   * **The strongest request in a tick wins.** Several bumpers touched at once is the case this settles, and it
   * is the reading that cannot surprise anybody — it is also exactly what the mode's `Math.max` did before.
   */
  launch: (speed: number) => void
}

/**
 * What a level can ask of a run. A mode with no such rule supplies a no-op and the component does nothing.
 *
 * Only the two rules that exist. `Goal` is a component with no hook because the mode has no goal rule —
 * nothing ends a run yet, and inventing one here would be a design decision wearing an implementation's
 * clothes.
 */
export interface Effects {
  /** The local player died. The mode decides what that means (respawn, ragdoll, both). */
  kill: () => void
  /** The local player reached this node. The mode decides whether that is progress worth saving. */
  progress: (node: WorldNode) => void
}

/** What a component instance sees of itself. */
export interface Self<D extends ParamDecls, S> {
  readonly params: Params<D>
  /** Per-instance runtime state from `init`. Mutable, and **never serialized**. */
  state: S
  /** The node this component sits on. */
  readonly node: WorldNode
  /** Another component on this same node, typed. Unity's `GetComponent`. */
  readonly get: <O extends ParamDecls>(def: ComponentDef<O>) => Params<O> | undefined
  /**
   * The node a `nodeRef` parameter points at, or `undefined` (stage C4).
   *
   * Resolved in this node's own reference scope first, so a reference authored inside a prefab finds *this*
   * placement's copy rather than the first placement's. Pass the parameter value straight in:
   * `self.find(self.params.target)`.
   */
  readonly find: (ref: string | null) => WorldNode | undefined
}

/**
 * A contact with one of this node's colliders.
 *
 * **No contact normal.** `CharacterBody.collisions()` does not report one, so "launch along the surface you
 * hit" is unavailable until the physics layer exposes it. Known gap, and nothing authored needs it.
 */
export interface Hit {
  readonly colliderHandle: number
  readonly node: WorldNode
}

/** What a hook is handed about the world. One object, reused across the tick. */
export interface Ctx {
  /** Sim tick from the synced clock. The only notion of "now" a component gets. */
  readonly tick: number
  /** Fixed step, in seconds. */
  readonly dt: number
  /** Synced level time, in ms — the same value the loader poses tracks against. */
  readonly timeMs: number
  /**
   * Deterministic pseudo-random in [0, 1). Seeded from the tick, the instance and the call count, so two
   * clients running the same code at the same tick get the same sequence. `Math.random()` would not.
   */
  readonly random: () => number
  readonly character: CharacterAccess
  readonly effects: Effects
}

/** Hooks with their parameter and state types erased — what the runner can hold in a heterogeneous list. */
export interface ErasedHooks {
  readonly init?: (params: Params<ParamDecls>, ctx: Ctx) => unknown
  readonly onAttach?: (self: Self<ParamDecls, never>, ctx: Ctx) => void
  readonly onFixedUpdate?: (self: Self<ParamDecls, never>, ctx: Ctx) => void
  readonly onContact?: (self: Self<ParamDecls, never>, ctx: Ctx, hit: Hit) => void
  readonly onDetach?: (self: Self<ParamDecls, never>, ctx: Ctx) => void
}

const HOOK_NAMES = ['init', 'onAttach', 'onFixedUpdate', 'onContact', 'onDetach'] as const

/** True when a definition has anything for the runner to call. */
export const hasHooks = (def: AnyComponentDef): boolean =>
  def.hooks !== undefined && HOOK_NAMES.some((k) => def.hooks?.[k] !== undefined)

/** One live component. */
interface Instance {
  readonly def: AnyComponentDef
  readonly self: Self<ParamDecls, never>
}

export interface ComponentRuntime {
  /** Run `onAttach` once, in tree order. Called before the first step. */
  attach: (tick: number, timeMs: number, dt: number) => void
  /** Run every `onFixedUpdate`, in tree order then component order. Once per fixed tick. */
  fixedUpdate: (tick: number, timeMs: number, dt: number) => void
  /**
   * Run `onContact` for the nodes owning these collider handles. Call it with what
   * `CharacterBody.collisions()` returned, after the step that produced them.
   */
  contact: (handles: readonly number[]) => void
  /** Run `onDetach`, in reverse tree order. */
  detach: () => void
  /** How many live components there are — what a test asserts instead of reaching inside. */
  count: () => number
}

/**
 * Deterministic pseudo-random from three integers. A hash rather than a seeded generator with hidden state,
 * so the same (tick, instance, call) always gives the same number no matter what ran in between.
 */
const hashRandom = (a: number, b: number, c: number): number => {
  let h = Math.imul(a ^ 0x9e3779b1, 0x85ebca6b) ^ Math.imul(b + 0x165667b1, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}

/**
 * Build the live components for a loaded level.
 *
 * **Order is authored data**: the loader's depth-first node order, then each node's component order. Unity
 * leaves its default execution order effectively undefined and everybody has been bitten by it; being
 * explicit costs nothing and is what makes the determinism test meaningful.
 */
export const createComponentRuntime = (
  loaded: LoadedNodeLevel,
  registry: Registry,
  io: { readonly character: CharacterAccess; readonly effects: Effects },
): ComponentRuntime => {
  const instances: Instance[] = []
  const byNode = new Map<WorldNode, Instance[]>()

  // Per-tick mutable context. One object rather than one per instance per tick: a hook holds no reference to
  // it beyond its own call, and allocating thousands of identical objects a second is waste.
  let calls = 0
  let instanceOf = 0
  const ctx: Ctx = {
    tick: 0,
    dt: 0,
    timeMs: 0,
    random: () => hashRandom(ctx.tick, instanceOf, calls++),
    character: io.character,
    effects: io.effects,
  }
  const mutable = ctx as { tick: number; dt: number; timeMs: number }
  const setClock = (tick: number, timeMs: number, dt: number): void => {
    mutable.tick = tick
    mutable.timeMs = timeMs
    mutable.dt = dt
  }

  for (const node of loaded.allNodes) {
    const here: Instance[] = []
    for (const c of node.components) {
      if (c.enabled === false) continue
      const def = registry.get(c.type)
      if (def === undefined || !hasHooks(def)) continue
      const params = readParams(def.params, c.params, `${node.id}.${c.type}`)
      const self: Self<ParamDecls, never> = {
        params,
        state: undefined as never,
        node,
        get: (other) => {
          const found = node.components.find((x) => x.type === other.type && x.enabled !== false)
          return found === undefined ? undefined : readParams(other.params, found.params, other.type)
        },
        find: (ref) => (ref === null || ref === '' ? undefined : loaded.findNode(node, ref)),
      }
      const instance: Instance = { def, self }
      instances.push(instance)
      here.push(instance)
    }
    if (here.length > 0) byNode.set(node, here)
  }

  /** Run one hook for one instance, with the seeded random keyed to it. */
  const run = (i: number, fn: ((self: Self<ParamDecls, never>, ctx: Ctx) => void) | undefined): void => {
    if (fn === undefined) return
    instanceOf = i
    calls = 0
    fn(instances[i]!.self, ctx)
  }

  return {
    attach: (tick, timeMs, dt) => {
      setClock(tick, timeMs, dt)
      instances.forEach((instance, i) => {
        instanceOf = i
        calls = 0
        const init = instance.def.hooks?.init
        if (init !== undefined) (instance.self as { state: unknown }).state = init(instance.self.params, ctx)
        run(i, instance.def.hooks?.onAttach)
      })
    },
    fixedUpdate: (tick, timeMs, dt) => {
      setClock(tick, timeMs, dt)
      instances.forEach((instance, i) => run(i, instance.def.hooks?.onFixedUpdate))
    },
    contact: (handles) => {
      for (const handle of handles) {
        const node = loaded.nodeOf(handle)
        if (node === undefined) continue
        const here = byNode.get(node)
        if (here === undefined) continue
        const hit: Hit = { colliderHandle: handle, node }
        for (const instance of here) {
          const fn = instance.def.hooks?.onContact
          if (fn === undefined) continue
          instanceOf = instances.indexOf(instance)
          calls = 0
          fn(instance.self, ctx, hit)
        }
      }
    },
    detach: () => {
      for (let i = instances.length - 1; i >= 0; i--) run(i, instances[i]!.def.hooks?.onDetach)
    },
    count: () => instances.length,
  }
}

/**
 * A `CharacterAccess` over a character whose `launch` is a number field the step consumes.
 *
 * Takes the max across a tick, which is the "strongest bumper wins" rule, and keeps the field's
 * consume-on-step contract intact — the step zeroes it, so this only ever raises it.
 */
export const characterAccess = (state: { launch: number }): CharacterAccess => ({
  launch: (speed) => {
    if (speed > state.launch) state.launch = speed
  },
})

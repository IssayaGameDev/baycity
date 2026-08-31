import type { Vec3 } from '@mp/core'
import type { InputCommand } from '@mp/core'
import type { ComponentData, NodeDrive, LoadedLevel, WorldNode } from '@mp/content'
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

/**
 * What the local character can be asked, and asked to do. Motion only; anything about the *run* goes through
 * `Effects`.
 *
 * This was one method — `launch` — which was enough for a trampoline and nothing else (ADR 0032). A component
 * that lives *on the player* has to be able to see where it is and move it in a direction, so it is now the
 * read surface plus one general push (ADR 0059).
 *
 * **Accessors, not fields.** The state underneath mutates every tick, so a snapshot object would be stale the
 * moment a component held onto it.
 */
export interface CharacterAccess {
  /**
   * Ask for an upward speed on the next step, which `stepCharacter` consumes (ADR 0032).
   *
   * **The strongest request in a tick wins.** Several bumpers touched at once is the case this settles, and it
   * is the reading that cannot surprise anybody — it is also exactly what the mode's `Math.max` did before.
   */
  launch: (speed: number) => void
  /** Where the character is right now — the capsule's centre, in world space. */
  position: () => Vec3
  /**
   * Its own locomotion velocity (m/s).
   *
   * Not what the world is adding: a platform carrying you, a sweeping bar shoving you and a wall taking your
   * momentum are all in `carry` and none of them are here.
   */
  velocity: () => Vec3
  /** What the world moved the character by that its own locomotion did not ask for (m/s). */
  carry: () => Vec3
  /** Is there ground under it. False through a jump, a fall, and the coyote window. */
  grounded: () => boolean
  /**
   * Add a velocity (m/s) on the next step, then consumed — `launch` generalised to three axes.
   *
   * **Accumulates within a tick**, rather than the strongest winning, because two pushes from different
   * directions have a meaningful sum where two competing *heights* do not. Write it every tick to pull
   * continuously; stop writing it to stop.
   */
  push: (v: Vec3) => void
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
  /**
   * Move this node: a **live, mutable offset** from its authored transform, in local space (ADR 0058).
   *
   * `undefined` unless this component's definition declares `moves`. Write into it — `self.offset.position.y
   * += ctx.dt` — and the frame tree picks it up on the same tick, carrying the node's colliders, its visual,
   * its light and everything parented under it.
   *
   * An offset rather than a pose, so zero means "as authored", a driven node survives being duplicated or
   * reparented, and a component can nudge a node a `Track` is already moving — the two simply add.
   *
   * `rotation` is Euler **radians**, like `Transform.rotation`.
   *
   * Before this, nothing a component could reach was writable: `WorldNode` is readonly and `Track` is
   * evaluated by the loader as `pose = f(t)`, so "a door that opens when touched" was not expressible in any
   * game (ADR 0058).
   */
  readonly offset: NodeDrive | undefined
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
  readonly onLocomote?: (self: Self<ParamDecls, never>, ctx: Ctx, cmd: InputCommand) => void
  readonly onContact?: (self: Self<ParamDecls, never>, ctx: Ctx, hit: Hit) => void
  readonly onDetach?: (self: Self<ParamDecls, never>, ctx: Ctx) => void
}

export const HOOK_NAMES = ['init', 'onAttach', 'onFixedUpdate', 'onLocomote', 'onContact', 'onDetach'] as const

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
   * Run every `onLocomote` — the **movement slot** (ADR 0061).
   *
   * Its own call rather than part of `fixedUpdate` because it is a different *moment*. The host's tick is
   * two-phase: the clock-driven pieces move, the physics world steps, the character resolves against where
   * they are **now**, and the world steps again. Locomotion has to land between those two steps, and
   * `fixedUpdate` runs before all of it.
   *
   * So this is not a convenience — putting locomotion in the general sweep resolves the character against
   * last tick's platforms, which is the platform-carry jitter ADR 0012 and the two-phase step exist to avoid.
   */
  locomote: (tick: number, timeMs: number, dt: number, cmd: InputCommand) => void
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
/**
 * Components that live on **the player** rather than on a level node (ADR 0059).
 *
 * A level authors the world; it does not author who is playing. So these come from the game's
 * `ModeDescriptor` and are attached at runtime, which is the whole difference between a pad you touch and an
 * ability you have. Before this the character was a capsule plus `stepCharacter` and nothing else, so an
 * ability the player *has* had nowhere at all to live.
 *
 * Validated against the same registry as everything else, so a game cannot give its player a component it did
 * not declare.
 */
export interface PlayerEntity {
  /** Node id, for `self.node.id` and for a `nodeRef` to name. Conventionally `'player'`. */
  readonly id: string
  readonly components: readonly ComponentData[]
  /**
   * Definitions built for **this session**, tried before the registry (ADR 0061).
   *
   * The registry is built once at module load, and a player component's real work usually needs things that do
   * not exist until a level is joined — the character above all. So a game builds its own definitions with
   * those closed over and hands them in here, and the platform never has to learn what they were.
   *
   * The registry still holds a definition of the same type: that is the one a tool validates parameters
   * against, and it is built with nothing bound. Only the *closure* differs, which is why the two cannot
   * meaningfully drift.
   */
  readonly defs?: readonly AnyComponentDef[]
}

export const createComponentRuntime = (
  loaded: LoadedLevel,
  registry: Registry,
  io: {
    readonly character: CharacterAccess
    readonly effects: Effects
    /**
     * The local player's own components, attached after every level node's.
     *
     * After, deliberately: the level is the world and the player reacts to it, so within one tick a mover has
     * already moved and a rule has already fired by the time an ability runs.
     */
    readonly player?: PlayerEntity
  },
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

  /**
   * The player as a node, so a component on it sees the same `Self` as one on a platform.
   *
   * Three things about it are deliberately different, and all three are documented on `Self`: it owns no
   * colliders, so `onContact` never fires on it (a hazard the player touches is delivered to the *hazard*);
   * `position` is where it spawned rather than where it is, because a `WorldNode`'s position is load-time
   * data and the live answer is `ctx.character.position()`; and `self.offset` is `undefined` even for a
   * component that declares `moves`, since the character is a controller resolved against the world rather
   * than a frame posed by the loader — it moves by asking `ctx.character`, not by writing an offset.
   */
  const playerNode: WorldNode | undefined =
    io.player === undefined
      ? undefined
      : { id: io.player.id, name: io.player.id, components: io.player.components, position: { x: 0, y: 0, z: 0 }, colliderHandles: [], scope: 0 }

  /** By type, so the lookup above is one map hit rather than a scan per component. */
  const sessionDefs = new Map<string, AnyComponentDef>((io.player?.defs ?? []).map((d) => [d.type, d]))

  const sources: readonly { node: WorldNode; components: readonly ComponentData[] }[] = [
    ...loaded.allNodes.map((node) => ({ node, components: node.components })),
    ...(playerNode === undefined ? [] : [{ node: playerNode, components: playerNode.components }]),
  ]

  for (const { node, components } of sources) {
    const here: Instance[] = []
    for (const c of components) {
      if (c.enabled === false) continue
      // A session definition wins over the registry's, and only for the player — see `PlayerEntity.defs`.
      const def = (node === playerNode ? sessionDefs.get(c.type) : undefined) ?? registry.get(c.type)
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
        // Only for a component that asked. Handing it to every component would mean every node with any
        // hook at all became kinematic and got posed every tick, which is a cost nothing asked for.
        offset: def.moves === true ? loaded.driveOf(node) : undefined,
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
    locomote: (tick, timeMs, dt, cmd) => {
      setClock(tick, timeMs, dt)
      instances.forEach((instance, i) => {
        const fn = instance.def.hooks?.onLocomote
        if (fn === undefined) return
        instanceOf = i
        calls = 0
        fn(instance.self, ctx, cmd)
      })
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
 * The shape of a character this can be built over. Structural on purpose: `@mp/character` owns
 * `CharacterState` and satisfies this, but nothing here imports it, so the component system stays usable by a
 * test with a plain object and cannot end up in a cycle with the controller.
 */
export interface CharacterLike {
  launch: number
  impulse: Vec3
  vx: number
  vy: number
  vz: number
  carry: Vec3
  grounded: boolean
  body: { translation: () => Vec3 }
}

/**
 * A `CharacterAccess` over a character whose pending requests are fields the step consumes.
 *
 * `launch` takes the max across a tick — the "strongest bumper wins" rule — and keeps the field's
 * consume-on-step contract intact, since the step zeroes it and this only ever raises it. `push` **adds**
 * instead, for the reason on the interface: two shoves have a sum, two heights do not.
 */
export const characterAccess = (state: CharacterLike): CharacterAccess => ({
  launch: (speed) => {
    if (speed > state.launch) state.launch = speed
  },
  position: () => state.body.translation(),
  velocity: () => ({ x: state.vx, y: state.vy, z: state.vz }),
  carry: () => state.carry,
  grounded: () => state.grounded,
  push: (v) => {
    // In place, because the step zeroes the same object rather than replacing it, and because two components
    // pushing in one tick must both land.
    state.impulse.x += v.x
    state.impulse.y += v.y
    state.impulse.z += v.z
  },
})

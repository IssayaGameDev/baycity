import type { Vec3 } from '@mp/core'

/**
 * Data-driven content schema (ADR pending). A **level** is a set of **prefab**
 * instances; a prefab is reusable pieces + markers + an optional clock-driven
 * behavior. Content is a shared resource any game mode can load. Kept deliberately
 * small; extended (glTF visuals, more behaviors) as needed.
 */

/**
 * Position + optional rotation (euler radians, XYZ) + optional scale (per-axis, default 1).
 * Scale is baked into shape dimensions at load — like Unity baking lossy scale into a PhysX
 * shape (there is no scale in a Rapier collider pose). Non-uniform scale on a ball/capsule is
 * approximated (uniform-ish), same limitation as Unity; boxes are exact.
 */
export interface Transform {
  position: Vec3
  rotation?: Vec3
  scale?: Vec3
}

/**
 * Gameplay collision primitive — crisp and cheap for the kinematic character controller. A ramp is
 * just a `box` with a rotated Transform. Still never a trimesh from an art mesh (ADR 0014): every
 * shape here is authored, convex, and cheap to query.
 *
 * `convex` is the exception to "primitive", added because some authored surfaces genuinely are not
 * boxes: a segment swept along a curve has **non-parallel end faces**, so a chain of boxes can only
 * approximate it and leaves notches at the joins no matter how finely it is divided (ADR 0017).
 * The renderer draws these from the same `points`, so collider and mesh cannot disagree.
 */
export type ColliderDesc =
  | { readonly kind: 'box'; readonly halfExtents: Vec3 }
  | { readonly kind: 'cylinder'; readonly halfHeight: number; readonly radius: number }
  | { readonly kind: 'capsule'; readonly halfHeight: number; readonly radius: number }
  | { readonly kind: 'ball'; readonly radius: number }
  | { readonly kind: 'convex'; readonly points: readonly Vec3[] }

/**
 * The swappable visual layer, and the only place content meets art. Collision never changes with it.
 *
 * - `primitive` draws the collider shape. `material` is a material **asset id**; omitted, the shape draws
 *   in the flat untextured grey that means "nobody has chosen a surface for this yet".
 * - `model` draws a mesh asset instead, by **asset id**. The collider stays authored, so a detailed prop
 *   still collides as the box someone chose. `material` overrides the mesh's own.
 *
 * There used to be a second answer here: `style`, a key into a table of eight hardcoded colours. It is gone
 * (ADR 0028). The greybox palette survives as seven material assets, so the visual language is authored
 * content like everything else rather than a switch statement in the renderer.
 */
export type Visual =
  | { readonly kind: 'primitive'; readonly material?: string }
  | { readonly kind: 'model'; readonly asset: string; readonly material?: string }

/** Every trigger kind, for a picker and for validation. */
export type TriggerKind = 'checkpoint' | 'goal' | 'hazard' | 'bumper'

/**
 * A gameplay rule fired by real contact with a piece's collider — the mode decides what each one means
 * (save a checkpoint, reach the goal, respawn on a hazard, launch off a bumper).
 *
 * A **discriminated union rather than a bare string**, because the moment a rule needed a number the string
 * had nowhere to put it (ADR 0032). The three original kinds carry nothing and still carry nothing; `bumper`
 * carries how hard it throws.
 *
 * Contact, not proximity: the collider is solid and the mode matches handles against what the character
 * controller actually collided with. So a trampoline is something you land on, not a zone you enter.
 */
export type Trigger =
  | { readonly kind: 'checkpoint' }
  | { readonly kind: 'goal' }
  | { readonly kind: 'hazard' }
  | {
      readonly kind: 'bumper'
      /**
       * Upward launch speed in m/s, replacing whatever vertical velocity the character had.
       *
       * Apex is `power² / (2·gravity)`. At the tuned gravity of 55 a jump leaves the ground at
       * `√(2·55·3) ≈ 18.2` m/s for its 3 m, so **anything below 18 throws you lower than your own jump** and is
       * only useful as a soft catch. 26 gives about 6.1 m, roughly twice a jump, which is what a trampoline
       * should feel like.
       */
      readonly power: number
    }

/** One collider + visual at a local transform in a prefab. `visual` defaults to a
 * greybox primitive matching the collider when omitted. `trigger` marks this piece's
 * collider as a gameplay trigger — contact with it (not proximity) fires the mode's rule.
 * `behavior` drives this piece's own kinematic motion (flat, non-recursive — no nested
 * prefabs); precedence at load is piece → instance → prefab → static. */
export interface Piece {
  collider: ColliderDesc
  transform: Transform
  visual?: Visual
  trigger?: Trigger
  behavior?: Behavior
  /**
   * Author-facing label, like a GameObject's name. Editor-only: the loader ignores it, nothing derives
   * behaviour from it, and it is absent unless somebody typed one — a prefab of three boxes reads as
   * "left rail / floor / right rail" in the hierarchy instead of "box / box / box".
   */
  name?: string
  /**
   * Stable identity, for a placement to name this piece when it overrides it (ADR 0033).
   *
   * **Not the array index.** An index re-targets silently the moment a piece is inserted above it, which is the
   * same failure the asset layer avoided with sidecar ids (ADR 0026) — except here the symptom is one
   * instance's override quietly landing on a different piece. Minted on demand: a piece gains an id the first
   * time something needs to refer to it, so nothing has to migrate.
   */
  id?: string
}

/**
 * What one placement changes about one piece of the prefab it references (ADR 0033).
 *
 * Absent field means inherit. That is what makes an override sparse and what makes "revert" mean something: the
 * prefab stays the source of truth and this is the difference.
 *
 * Clearing rather than inheriting needs a value, not an absence, so the two cases stay distinguishable:
 * `material: ''` is "no material here", and `trigger: { kind: 'none' }` is "not a trigger here". Motion needs no
 * sentinel because `Behavior` already has one in `{ kind: 'static' }`.
 */
export interface PieceOverride {
  transform?: Transform
  /** Material asset id, or `''` for explicitly none. */
  material?: string
  /** A trigger, or `{ kind: 'none' }` to remove the prefab's. */
  trigger?: Trigger | { readonly kind: 'none' }
  behavior?: Behavior
  name?: string
}

/** Gameplay markers — positions are data; the mode decides what they mean. `hazard` is a
 * kill/respawn zone (touch → the mode respawns you); fall-kill below `fallY` is separate. */
export type Marker =
  | { readonly kind: 'spawn'; readonly transform: Transform }
  | { readonly kind: 'checkpoint'; readonly transform: Transform; readonly radius: number }
  | { readonly kind: 'goal'; readonly transform: Transform; readonly radius: number }
  | { readonly kind: 'hazard'; readonly transform: Transform; readonly radius: number }

/**
 * How the segment *leaving* a key is timed. Named curves, not bezier handles: easing stays a string in the
 * JSON and a menu item in the editor, which is the whole reason there is no graph editor (ADR 0029).
 *
 * `inOut` is cosine, not quadratic, and that is load-bearing: it makes a 3-key out-and-back reproduce the
 * old `move` behavior *exactly*, so migrating authored content changed nothing anyone can see.
 * `step` holds the key's pose until the next one — an instant jump, not a curve.
 */
export type Easing = 'linear' | 'in' | 'out' | 'inOut' | 'step'

/**
 * One authored pose at `t` milliseconds from the start of a track.
 *
 * Both channels are optional and mean "the authored transform's value" when absent, so a track that only
 * translates carries no rotation data at all. A key is a whole pose rather than a per-channel curve point:
 * one row of keys in the timeline, which is the UI this schema exists to serve.
 *
 * `rotation` is euler radians like `Transform.rotation`, and is interpolated **per component** rather than
 * as a quaternion. That is deliberate: slerp between identity and a full turn is degenerate (they are the
 * same orientation), so a spin could not be expressed at all. Component lerp is also what a per-channel
 * animation curve does. The cost is that arbitrary orientations do not take the shortest path.
 */
export interface Keyframe {
  readonly t: number
  readonly position?: Vec3
  readonly rotation?: Vec3
  readonly easing?: Easing
}

/**
 * What happens when a track reaches its end. `loop` restarts, `pingPong` runs back to the start, `once`
 * holds the last pose forever.
 *
 * `once` is honest but rarely what you want: the clock is the *session's*, not the player's, so a
 * once-track has already finished before anybody joins a running room. It is here for a one-shot reveal in
 * a level that starts with the room, and for holding a pose deliberately.
 */
export type LoopMode = 'loop' | 'pingPong' | 'once'

/**
 * Clock-driven motion — a pure function of synced time, so no per-object networking.
 *
 * One kind, `track`: a list of keyed poses. It replaced `move` (an eased out-and-back along an axis) and
 * `rotate` (a continuous spin) in ADR 0029, which are now editor **presets** that write keys. Those two
 * could not express a pause at either end, a path with a corner, or two platforms moving out of phase —
 * every mover sharing a period was locked in step, because motion was `nowMs % periodMs` with no offset.
 *
 * `phaseMs` shifts this track's clock, which is what unlocks a staggered row of pistons. The duration is the
 * last key's `t`, derived rather than stored so the two cannot disagree.
 *
 * **A track replaces the frame's local pose**, per channel, rather than adding to it — Unity's model. A
 * spinning object that is also tilted carries the tilt in its keys. Composition onto the *parent* is
 * unchanged, so a keyed bar under a keyed platform still rides it (ADR 0025).
 */
export type Behavior =
  | { readonly kind: 'static' }
  | {
      readonly kind: 'track'
      readonly keys: readonly Keyframe[]
      readonly loop?: LoopMode
      readonly phaseMs?: number
    }

/** A reusable obstacle: pieces (+ optional local markers) with an optional default behavior. */
export interface Prefab {
  id: string
  pieces: Piece[]
  markers?: Marker[]
  behavior?: Behavior
}

/**
 * A prefab placed in a level. `prefab` is an id (resolved against `Level.prefabs`) or an inline
 * definition.
 *
 * A **reference** is what makes a prefab a prefab: edit the table entry and every instance follows.
 * An inline definition is a one-off with no shared identity — both are valid, and the loader treats
 * them identically once resolved.
 *
 * The rest are per-instance **overrides**, the counterpart to referencing: `behavior` replaces the
 * prefab's default motion, `material` resurfaces *every* piece of this instance. Everything else is
 * shared, which is the point.
 */
export interface PrefabInstance {
  prefab: string | Prefab
  transform: Transform
  behavior?: Behavior
  /** Material asset id applied to every piece of this placement, beating each piece's own. */
  material?: string
  /**
   * Per-piece overrides, keyed by `Piece.id` (ADR 0033). The fine-grained counterpart to `material` above,
   * which is the blunt "resurface all of it" version and still wins over a piece's own.
   *
   * Keyed rather than positional so inserting a piece into the prefab cannot silently re-target them.
   */
  overrides?: Record<string, PieceOverride>
  /**
   * Author-facing label, like a GameObject's name — per *instance*, so two placements of one prefab can
   * be told apart ("first gap" / "last gap"). Editor-only, ignored by the loader, and absent unless
   * typed: the display name falls back to the prefab's id, so clean JSON stays clean.
   */
  name?: string
  /**
   * Nested instances, to arbitrary depth. A child's transform is relative to this instance's — and at
   * runtime to its *animated* pose, so motion composes: a rotating bar parented to a moving platform
   * rides the platform while spinning, with no behaviour that can express that on its own.
   *
   * Prefabs stay flat (a prefab holds pieces, never prefabs). Nesting is a property of *placement*, which
   * is what keeps the composition a tree of transforms rather than a dependency graph between assets.
   */
  children?: PrefabInstance[]
}

/**
 * Per-level (and mode) config knobs. `fallBehavior` makes linear-obby vs obby-tower pure
 * data: `respawn-checkpoint` teleports to the last checkpoint on falling below `fallY`;
 * `physical-fall` lets the player fall (a tower). `gravity` optionally overrides the
 * character's gravity for this level.
 */
export interface LevelConfig {
  fallBehavior: 'respawn-checkpoint' | 'physical-fall'
  fallY: number
  gravity?: number
}

/** A level: a prefab table, placed instances, level-global markers, and config. */
export interface Level {
  id: string
  config: LevelConfig
  prefabs?: Record<string, Prefab>
  instances: PrefabInstance[]
  markers?: Marker[]
}

// ---------------------------------------------------------------------------------------------------
// The component schema (PLAN-component-system, stage C1). Lives beside the shapes above while the
// loader is moved over; `legacy.ts` converts one into the other and both are deleted in stage C1.4.
// ---------------------------------------------------------------------------------------------------

/**
 * One component on a node: a registry type plus its authored parameters.
 *
 * `params` is `unknown`-valued here because the schema layer does not know the declarations —
 * `@mp/components` owns those, and depends on this package rather than the reverse. `validateNodeLevel`
 * takes a registry when it wants them checked.
 */
export interface ComponentData {
  /** Stable, so an override can name this component. Minted on demand, like `Piece.id` before it. */
  id: string
  /** Registry key: `'Collider'`, `'Bumper'`, … */
  type: string
  params: Record<string, unknown>
  /** Absent means enabled. Present and false means the runtime skips it and the editor greys it. */
  enabled?: boolean
}

/**
 * A scene object: a transform, a **list** of components, and children.
 *
 * This one type replaces `Piece` and `PrefabInstance`, which is what makes a piece a real object rather
 * than a half-addressable thing inside one (the whole subject of ADR 0033). It also absorbs `Marker`: a
 * checkpoint marker with a radius is a node with a ball `Collider` and a `Checkpoint`.
 *
 * `prefab` set means this node's components and children come from the shared definition of that name.
 * The placement keeps its own `id`, `name` and `transform` — Unity's model, where the instance root *is*
 * the asset's root wearing the placement's transform.
 */
export interface Node {
  id: string
  name?: string
  transform: Transform
  components: ComponentData[]
  children?: Node[]
  /**
   * Prefab table key. A node inside a prefab may **not** carry one: prefab-in-prefab stays out (as it was
   * under ADR 0023), because a reference graph needs cycle detection that a tree of plain nodes does not.
   */
  prefab?: string
  /** Per-node overrides on this placement, keyed by the *referenced* tree's node ids, at any depth. */
  overrides?: Record<string, NodeOverride>
}

/**
 * What one placement changes about one node of the tree it references.
 *
 * Absent means inherit, which is what makes an override sparse and "revert" meaningful. Unlike
 * `PieceOverride` before it, this can be **structural**: `added` and `removed` are Unity's added and
 * removed components, which a component system needs because "this one placement also bounces" is the
 * ordinary case rather than an exotic one.
 */
export interface NodeOverride {
  transform?: Transform
  name?: string
  /** Component id → the parameters that differ. Sparse: only the changed keys appear. */
  params?: Record<string, Record<string, unknown>>
  added?: ComponentData[]
  /** Component ids of the referenced tree's components this placement does without. */
  removed?: string[]
  /**
   * Component id → enabled, for switching an inherited component off (or back on) on this placement only.
   *
   * Separate from `params` because `enabled` is not a parameter — it sits on `ComponentData` beside them, and
   * folding it in would make a component that happens to declare a parameter called `enabled` collide with it.
   */
  enabled?: Record<string, boolean>
}

/** A level as a node tree. `prefabs` maps a table key to the **root node** of a shared definition. */
export interface NodeLevel {
  id: string
  config: LevelConfig
  prefabs?: Record<string, Node>
  nodes: Node[]
}

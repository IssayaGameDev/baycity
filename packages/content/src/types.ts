import type { Vec3 } from '@mp/core'

/**
 * Data-driven content schema. A **level** is a tree of **nodes**; a node is a transform plus a **list of
 * components**, and may reference a shared prefab (ADR 0035). Content is a shared resource any game mode can
 * load. Kept deliberately small; extended as needed.
 *
 * The piece-and-instance schema this replaced — `Piece`, `PrefabInstance`, `Prefab`, `Marker`, `Trigger`,
 * `Visual` — is gone, along with the loader and converter that proved the migration. Git has them at
 * `a013ebc`, and ADR 0035 records what each field became.
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
 * How the segment *leaving* a key is timed. Named curves, not bezier handles: easing stays a string in the
 * JSON and a menu item in the editor, which is the whole reason there is no graph editor (ADR 0029).
 *
 * `inOut` is cosine, not quadratic, and that is load-bearing: it makes a 3-key out-and-back reproduce the
 * `move` behavior it replaced *exactly*, so migrating authored content changed nothing anyone can see.
 * `step` holds the key's pose until the next one — an instant jump, not a curve.
 */
export type Easing = 'linear' | 'in' | 'out' | 'inOut' | 'step'

/**
 * One authored **offset** from the node's transform, `t` milliseconds from the start of a track.
 *
 * Offsets, not absolute poses (ADR 0050). A key of zero is the rest pose, and a key of `y: 3` means three
 * metres up from wherever the node sits. That is what makes a track independent of where it was authored:
 * duplicate the object, move it, reparent it, and its motion comes with it. Absolute keys welded a track to
 * one spot in one level, which is why they could not be shared.
 *
 * Both channels are optional and contribute nothing when absent, so a track that only translates carries no
 * rotation data at all. A key is a whole pose rather than a per-channel curve point: one row of keys in the
 * timeline, which is the UI this schema exists to serve.
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
 * Not a schema type any more: it is what the loader builds from a `Track` component's parameters (ADR 0035)
 * and hands to `poseAt`. The `keys`/`loop`/`phaseMs` shape is the same either way.
 *
 * `phaseMs` shifts this track's clock, which is what unlocks a staggered row of pistons. The duration is the
 * last key's `t`, derived rather than stored so the two cannot disagree.
 *
 * **A track offsets the node's local pose**, per channel, rather than replacing it (ADR 0050). A spinning
 * object that is also tilted keeps the tilt in its transform, where a person can see and edit it, instead of
 * having it baked into every key. Composition onto the *parent* is unchanged, so a keyed bar under a keyed
 * platform still rides it (ADR 0025).
 */
export type Behavior =
  | { readonly kind: 'static' }
  | {
      readonly kind: 'track'
      readonly keys: readonly Keyframe[]
      readonly loop?: LoopMode
      readonly phaseMs?: number
    }

/**
 * The level's sun (ADR 0048).
 *
 * A **level setting**, not a node, because the sun and the sky are one input: elevation and azimuth drive the
 * key light, its shadow frustum and the sky's own glow together (ADR 0046). Putting it here keeps it beside the
 * sky parameters it is coupled to, instead of making the sky chase a node somebody can drag.
 *
 * There is exactly one, and it is the only light that casts a level-wide shadow. Content lights — including the
 * hemisphere fill — are nodes with a `Light` component (ADR 0047).
 */
export interface SunConfig {
  /** Degrees above the horizon. */
  elevation: number
  /** Degrees about +Y from +X toward +Z, matching three's `equirectUv`. */
  azimuth: number
  intensity: number
  /** sRGB `#rrggbb`. */
  color: string
  /** The level-wide shadow. Off makes the whole level unshadowed, whatever a content light asks for. */
  shadows: boolean
}

/** How hard the sky's own environment map lights the level (`scene.environmentIntensity`). */
export interface AmbientConfig {
  /**
   * At 1 this sky's irradiance on an up-facing surface measures `[0.19, 1.59, 4.03]` — blue twenty-one times
   * red, and stronger than the key light. 0.2 is a cool cast; 0 is off.
   */
  intensity: number
}

/**
 * The sky's appearance (ADR 0046). A designed gradient, not atmospheric scattering.
 *
 * Declared here rather than in the renderer because it is **level data** now, and `@mp/content` is headless and
 * never imports rendering. `@mp/render-three` aliases its `SkyParams` to this and owns the *defaults*, which are
 * a renderer opinion rather than a schema.
 */
export interface SkyConfig {
  /** sRGB hex at the zenith. */
  topColor: string
  /** sRGB hex straight down. The horizon is a point on the way between the two. */
  bottomColor: string
  /** Ramp shape. Above 1 pulls the light end toward the zenith. Cannot break monotonicity. */
  gradientBias: number
  /** Master multiplier on the sky, glow and disc included. */
  gain: number
  /** sRGB hex of the halo around the sun, and of the disc. */
  glowColor: string
  /** Angular tightness of the halo. Higher is tighter. */
  glowSharpness: number
  /** Brightness of the halo. Push it and the sky washes out around the sun. */
  glowStrength: number
  /** Radiance of the solar disc. Large on purpose — it should clip to white. */
  sunDiskIntensity: number
}

/**
 * Everything about how a level is lit and what is behind it (ADR 0048).
 *
 * One block because these three are one subject and are tuned against each other: the sun's angles move the
 * sky's glow (ADR 0046), and `ambient` is the strength of the environment map the sky itself bakes. Splitting
 * them across the config would mean balancing coupled numbers in three places.
 *
 * The hemisphere fill is deliberately **not** here — it is a node with a `Light` component, because unlike
 * these it is something a level can have several of, or none.
 */
export interface EnvironmentConfig {
  sun: SunConfig
  ambient: AmbientConfig
  sky: SkyConfig
}

/**
 * Which game a level belongs to (ADR 0052).
 *
 * A name and nothing else. There was a `params` bag for the game's own level settings, and it went when its
 * only user did: parkour's `fallBehavior`/`fallY` were a **rule** in a setting's clothes, and a rule is a
 * component here — so the kill plane became a `Hazard` on a collider under the level (ADR 0053).
 *
 * A level naming a game this build does not have still loads — a tool can show it, and refusing would make a
 * level unopenable because a sibling app was not installed.
 */
export interface ModeRef {
  name: string
}

export interface LevelConfig {
  /**
   * The game this level is for. Absent means unassigned, which is what a level authored before games were
   * explicit looks like, and what a tool shows as "no mode".
   */
  mode?: ModeRef
  /**
   * Sun, ambient and sky. Absent, or any part of it absent, falls back to the renderer's defaults — so a level
   * authored before this existed still loads and still looks the way it did.
   */
  environment?: Partial<EnvironmentConfig>
}

/**
 * One component on a node: a registry type plus its authored parameters.
 *
 * `params` is `unknown`-valued here because the schema layer does not know the declarations —
 * `@mp/components` owns those, and depends on this package rather than the reverse. `validateLevel`
 * takes a registry when it wants them checked.
 */
export interface ComponentData {
  /** Stable, so an override can name this component. */
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
 * One type for everything, which is what makes a prefab's insides real objects rather than half-addressable
 * things inside one (ADR 0035). It also absorbed the old `Marker`: a checkpoint marker with a radius is a node
 * with a ball `Collider` and a `Checkpoint`.
 *
 * `prefab` set means this node's components and children come from the shared definition of that name. The
 * placement keeps its own `id`, `name` and `transform` — Unity's model, where the instance root *is* the
 * asset's root wearing the placement's transform.
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
 * Absent means inherit, which is what makes an override sparse and "revert" meaningful. It can be
 * **structural**: `added` and `removed` are Unity's added and removed components, which a component system
 * needs because "this one placement also bounces" is the ordinary case rather than an exotic one.
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

/** A level: a node forest, plus a prefab table mapping a key to the **root node** of a shared definition. */
export interface Level {
  id: string
  config: LevelConfig
  prefabs?: Record<string, Node>
  nodes: Node[]
}

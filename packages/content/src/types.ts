import type { Vec3 } from '@mp/core'

import type { SequenceOverride } from './sequenceData'

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
 * The screen-space passes over the finished image (ADR 0048, extended).
 *
 * Level data for the same reason the sun is: these are tuned **against** the lighting, not beside it. Ambient
 * occlusion is what gives greybox forms their depth, and bloom only fires on emissive materials, so a level
 * lit at dusk and one lit at noon do not want the same numbers.
 *
 * They were hardcoded at each of the three call sites instead, and had already drifted: the editor and the
 * viewer asked for `bloomStrength: 0.3` while the game asked for 0.1, so the tools did not show what you
 * would play. That is the drift ADR 0048 removed for the sun, arriving a second time in a different file.
 */
export interface PostFXConfig {
  /** Ground-truth ambient occlusion. Off is a flatter, cheaper image, not a broken one. */
  ao: boolean
  /** Bloom on emissive materials. Nothing without them glows, so this is free on an unlit level. */
  bloom: boolean
  /** How hard the bloom blooms. Ignored while `bloom` is off. */
  bloomStrength: number
}

/**
 * Everything about how a level is lit and what is behind it (ADR 0048).
 *
 * One block because these are one subject and are tuned against each other: the sun's angles move the sky's
 * glow (ADR 0046), `ambient` is the strength of the environment map the sky itself bakes, and `postfx` is
 * the occlusion and bloom read off the result. Splitting them across the config would mean balancing coupled
 * numbers in four places.
 *
 * The hemisphere fill is deliberately **not** here — it is a node with a `Light` component, because unlike
 * these it is something a level can have several of, or none.
 */
export interface EnvironmentConfig {
  sun: SunConfig
  ambient: AmbientConfig
  sky: SkyConfig
  postfx: PostFXConfig
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
   * Sun, ambient, sky and the post-processing over them. Absent, or any part of it absent, falls back to the
   * renderer's defaults — so a level authored before this existed still loads and still looks the way it did.
   */
  environment?: Partial<EnvironmentConfig>
  /**
   * Half-extent, in metres, of the range a peer's position is quantized over on the wire (ADR 0092/0093).
   *
   * Absent means the platform default (`QUANT_BOUND`, 1000 m), which is what every level authored before this
   * existed gets. Set it when a level reaches further than that, or when it is small and wants the precision
   * back: the step is `2 x netBounds / 65535`, so 1000 is 3 cm and 100 is 3 mm.
   *
   * A peer outside it is **clamped and then stops being relayed at all**, because the delta's change check
   * compares quantized values. That is why the editor draws this as a box rather than leaving it a number in
   * a file (ADR 0093).
   */
  netBounds?: number
  /**
   * Whether the game camera sees through what is between it and the character (ADR 0148): `true` holes the
   * obstruction and keeps the distance (ADR 0055); absent or `false`, the obstruction stops the camera
   * (ADR 0020). A level's call, because it depends on how the level is built. Only `true` is written.
   */
  cameraSeeThrough?: boolean
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
  /**
   * Absent means enabled. Present and `false` means this node and **everything under it** is not built at all
   * (ADR 0099) — no collider, no mesh, no light, no component running, in the editor and in the game alike.
   *
   * Unity's `SetActive`, and level data rather than a view setting: it is how half-built content or an
   * alternate route is parked in a level without deleting it.
   *
   * Cascades by omission, not by copying: a child of a disabled node is never reached, so its own `enabled`
   * is irrelevant and switching the parent back on restores whatever the children said.
   */
  enabled?: boolean
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
  /**
   * Switch the node **itself** off (or back on) on this placement only (ADR 0099).
   *
   * Its own field rather than a key in `enabled`, for the same reason `enabled` is separate from `params`:
   * `enabled` is keyed by *component* id, and a node is not a component. One placement of a platform prefab
   * can drop its spikes while every other placement keeps them.
   */
  nodeEnabled?: boolean
  /**
   * Pieces of the referenced tree this placement **does not have** (ADR 0133) — Unity's *removed
   * GameObject*, and the last of its four override kinds to arrive here.
   *
   * Different from `nodeEnabled: false`, which keeps the piece and switches it off: that still shows a row,
   * dimmed, and still says "there is a thing here you have turned off". A removal takes it away. Deleting a
   * piece, cutting one, and dragging one out of a placement all need to say that, and none of them could.
   *
   * By the **prefab's** node id, which is what the placement resolves against; the subtree goes with it, the
   * way removing any node takes its children.
   */
  removedNodes?: string[]
  /**
   * Nodes **this placement** hangs under the piece this record belongs to (ADR 0135).
   *
   * Kept here rather than as children of the placement's own node, which is what ADR 0130 did: that works
   * at the root and nowhere else, because a piece is not a node of this level and has nowhere to put one.
   * Keyed by piece, it works at any depth, and the root becomes the root's case of the same thing.
   *
   * These are ordinary authored nodes — the op layer's `find` walks into them, so every existing op edits
   * one without knowing where it lives.
   */
  addedChildren?: Node[]
  /**
   * The order of this piece's children **in this placement** (ADR 0135): every child id, inherited and
   * added alike, in the order they appear here.
   *
   * Absent means the prefab's order, with anything added after it. Present, it is the whole list — ids that
   * are no longer there are ignored, and children it does not mention keep their place at the end, so a
   * prefab that gains a piece does not invalidate a placement's ordering.
   */
  childOrder?: string[]
  /**
   * `Sequence` component id → how this placement's sequence differs from the prefab's (ADR 0139): changed
   * steps, removed and added steps and stages, and their order. Resolved by `stagesFor`.
   *
   * Beside `params` rather than inside it, for the reason `enabled` is: a params patch replaces a key whole,
   * and a sequence has to keep following its prefab everywhere this placement has not said otherwise.
   */
  sequences?: Record<string, SequenceOverride>
}

/** A level: a node forest, plus a prefab table mapping a key to the **root node** of a shared definition. */
export interface Level {
  id: string
  config: LevelConfig
  prefabs?: Record<string, Node>
  nodes: Node[]
}

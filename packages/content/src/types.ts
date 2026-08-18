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
 * - `primitive` greyboxes the collider shape. `style` picks a palette entry (the greybox visual language);
 *   `material` overrides that with a material **asset id**, which is how a piece stops being greybox
 *   without stopping being an authored primitive.
 * - `model` draws a mesh asset instead, by **asset id**. The collider stays authored, so a detailed prop
 *   still collides as the box someone chose.
 *
 * Was `{ kind: 'gltf', src }` — a path. Ids replaced it (see `assets.ts`) before anything consumed it, so
 * no content had to migrate.
 */
export type Visual =
  | { readonly kind: 'primitive'; readonly style?: string; readonly material?: string }
  | { readonly kind: 'model'; readonly asset: string; readonly material?: string }

/** Gameplay triggers fired by real contact with a piece's collider — the mode decides the
 * rule (save checkpoint / reach goal / respawn on hazard). */
export type TriggerKind = 'checkpoint' | 'goal' | 'hazard'

/** One collider + visual at a local transform in a prefab. `visual` defaults to a
 * greybox primitive matching the collider when omitted. `trigger` marks this piece's
 * collider as a gameplay trigger — contact with it (not proximity) fires the mode's rule.
 * `behavior` drives this piece's own kinematic motion (flat, non-recursive — no nested
 * prefabs); precedence at load is piece → instance → prefab → static. */
export interface Piece {
  collider: ColliderDesc
  transform: Transform
  visual?: Visual
  trigger?: TriggerKind
  behavior?: Behavior
  /**
   * Author-facing label, like a GameObject's name. Editor-only: the loader ignores it, nothing derives
   * behaviour from it, and it is absent unless somebody typed one — a prefab of three boxes reads as
   * "left rail / floor / right rail" in the hierarchy instead of "box / box / box".
   */
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
 * Clock-driven motion — a pure function of synced time, so no per-object networking.
 * `move`: an eased out-and-back from the home (authored) position — travels `distance` metres
 * along `axis`, then returns, over `periodMs`; starts and ends at rest. `rotate`: a continuous
 * spin about `axis` (sign = direction), one turn per `periodMs`.
 */
export type Behavior =
  | { readonly kind: 'static' }
  | { readonly kind: 'move'; readonly axis: Vec3; readonly distance: number; readonly periodMs: number }
  | { readonly kind: 'rotate'; readonly axis: Vec3; readonly periodMs: number }

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
 * prefab's default motion, `style` recolours *every* piece of this instance. Everything else is
 * shared, which is the point.
 */
export interface PrefabInstance {
  prefab: string | Prefab
  transform: Transform
  behavior?: Behavior
  style?: string
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

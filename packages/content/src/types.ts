import type { Vec3 } from '@mp/core'

/**
 * Data-driven content schema (ADR pending). A **level** is a set of **prefab**
 * instances; a prefab is reusable pieces + markers + an optional clock-driven
 * behavior. Content is a shared resource any game mode can load. Kept deliberately
 * small; extended (glTF visuals, more behaviors) as needed.
 */

/** Position + optional rotation (euler radians, XYZ). Size lives in shape dimensions. */
export interface Transform {
  position: Vec3
  rotation?: Vec3
}

/**
 * Gameplay collision primitive — simple and **separate from visuals** (crisp and cheap
 * for the kinematic character controller). A ramp is just a `box` with a rotated
 * Transform. Never a trimesh from the art mesh.
 */
export type ColliderDesc =
  | { readonly kind: 'box'; readonly halfExtents: Vec3 }
  | { readonly kind: 'cylinder'; readonly halfHeight: number; readonly radius: number }
  | { readonly kind: 'capsule'; readonly halfHeight: number; readonly radius: number }
  | { readonly kind: 'ball'; readonly radius: number }

/**
 * The swappable visual layer. `primitive` greyboxes the collider shape (now); `gltf`
 * is a real mesh (later, not built). `style` selects a palette entry (the visual
 * language). Swapping greybox → art never touches collision.
 */
export type Visual =
  | { readonly kind: 'primitive'; readonly style?: string }
  | { readonly kind: 'gltf'; readonly src: string; readonly style?: string }

/** One collider + visual at a local transform in a prefab. `visual` defaults to a
 * greybox primitive matching the collider when omitted. */
export interface Piece {
  collider: ColliderDesc
  transform: Transform
  visual?: Visual
}

/** Gameplay markers — positions are data; the mode decides what they mean. */
export type Marker =
  | { readonly kind: 'spawn'; readonly transform: Transform }
  | { readonly kind: 'checkpoint'; readonly transform: Transform; readonly radius: number }
  | { readonly kind: 'goal'; readonly transform: Transform; readonly radius: number }

/** Clock-driven motion — a pure function of synced time, so no per-object networking. */
export type Behavior =
  | { readonly kind: 'static' }
  | { readonly kind: 'move'; readonly axis: Vec3; readonly amplitude: number; readonly periodMs: number }
  | { readonly kind: 'rotate'; readonly axis: Vec3; readonly periodMs: number }

/** A reusable obstacle: pieces (+ optional local markers) with an optional default behavior. */
export interface Prefab {
  id: string
  pieces: Piece[]
  markers?: Marker[]
  behavior?: Behavior
}

/** A prefab placed in a level. `prefab` is an id (resolved against `Level.prefabs`) or
 * an inline definition; `behavior` overrides the prefab's default. */
export interface PrefabInstance {
  prefab: string | Prefab
  transform: Transform
  behavior?: Behavior
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

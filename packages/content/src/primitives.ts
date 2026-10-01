import { vec3, type Vec3 } from '@mp/core'

import type { ColliderDesc } from './types'

/**
 * Built-in shapes (ADR 0090): a `Mesh` whose `model` is one of these draws a unit shape sized by the node's
 * scale — Unity's cube, sphere and quad, plus the rounded box every platform has always been drawn as. They are ids
 * in the same slot as an uploaded model, so the picker lists them beside the files and the loader tells them
 * apart by prefix.
 *
 * The rule that makes them worth having: **scale is the size.** A node drawing a built-in keeps its colliders
 * at the matching unit shape (the editor enforces it), so the one number a person edits is the scale, and the
 * collision follows because the loader bakes scale into colliders anyway.
 */
export const BUILTIN_MODELS = ['builtin:box', 'builtin:rounded-box', 'builtin:sphere', 'builtin:capsule', 'builtin:quad'] as const
export type BuiltinModel = (typeof BUILTIN_MODELS)[number]

export const BUILTIN_LABELS: Record<BuiltinModel, string> = {
  'builtin:box': 'Box',
  'builtin:rounded-box': 'Rounded box',
  'builtin:sphere': 'Sphere',
  'builtin:capsule': 'Capsule',
  'builtin:quad': 'Quad',
}

export const isBuiltinModel = (id: unknown): id is BuiltinModel => typeof id === 'string' && (BUILTIN_MODELS as readonly string[]).includes(id)

/**
 * How thick a quad collides, at scale 1 (ADR 0189): a centimetre. A quad is a face, Unity's, drawn one-sided
 * toward +Z — a poster, a picture, a sign — and a box this thin is the nearest solid to it.
 */
export const QUAD_HALF_DEPTH = 0.005

/**
 * The collider a built-in shape collides as, at scale 1: a unit box, a ball of diameter 1, a capsule 1 wide and
 * 2 tall, a 1 × 1 quad a centimetre thick.
 */
export const unitColliderFor = (id: BuiltinModel): ColliderDesc => {
  switch (id) {
    case 'builtin:sphere':
      return { kind: 'ball', radius: 0.5 }
    case 'builtin:capsule':
      return { kind: 'capsule', halfHeight: 0.5, radius: 0.5 }
    case 'builtin:quad':
      return { kind: 'box', halfExtents: vec3(0.5, 0.5, QUAD_HALF_DEPTH) }
    default:
      return { kind: 'box', halfExtents: vec3(0.5, 0.5, 0.5) }
  }
}

export const mulVec3 = (a: Vec3, b: Vec3): Vec3 => vec3(a.x * b.x, a.y * b.y, a.z * b.z)

/**
 * Bake a per-axis scale into a collider's dimensions (Unity's lossy-scale → shape bake). Ball and capsule
 * cannot represent non-uniform scale, so they take a uniform-ish approximation; a box and a hull are exact.
 * The loader runs this on every collider, and the renderers run it on a built-in's unit shape, so what is
 * drawn and what is collided with are one computation.
 */
export const scaleCollider = (c: ColliderDesc, s: Vec3): ColliderDesc => {
  switch (c.kind) {
    case 'box':
      return { kind: 'box', halfExtents: mulVec3(c.halfExtents, s) }
    case 'ball':
      return { kind: 'ball', radius: c.radius * ((s.x + s.y + s.z) / 3) }
    case 'capsule':
      return { kind: 'capsule', halfHeight: c.halfHeight * s.y, radius: c.radius * ((s.x + s.z) / 2) }
    case 'cylinder':
      return { kind: 'cylinder', halfHeight: c.halfHeight * s.y, radius: c.radius * ((s.x + s.z) / 2) }
    case 'convex':
      // Exact under any scale, unlike ball/capsule — a scaled convex hull is still that hull.
      return { kind: 'convex', points: c.points.map((p) => mulVec3(p, s)) }
  }
}

/** What a built-in draws at this (world) scale: the unit shape scaled, rounded for the rounded box only. */
export const builtinShape = (id: BuiltinModel, scale: Vec3): { collider: ColliderDesc; rounded: boolean } => ({
  collider: scaleCollider(unitColliderFor(id), scale),
  rounded: id === 'builtin:rounded-box',
})

/** What the editor's Create menu and the prefab palette offer: a built-in and the scale it starts at. */
export interface PrimitivePreset {
  model: BuiltinModel
  scale: Vec3
}
export const PRIMITIVE_ORDER = ['box', 'rounded-box', 'platform', 'wall', 'sphere', 'capsule', 'quad'] as const
export type PrimitiveKind = (typeof PRIMITIVE_ORDER)[number]
export const PRIMITIVE_PRESETS: Record<PrimitiveKind, PrimitivePreset> = {
  box: { model: 'builtin:box', scale: vec3(1, 1, 1) },
  'rounded-box': { model: 'builtin:rounded-box', scale: vec3(1, 1, 1) },
  platform: { model: 'builtin:rounded-box', scale: vec3(3, 0.3, 3) },
  wall: { model: 'builtin:rounded-box', scale: vec3(3, 2, 0.3) },
  sphere: { model: 'builtin:sphere', scale: vec3(1, 1, 1) },
  capsule: { model: 'builtin:capsule', scale: vec3(1, 1, 1) },
  quad: { model: 'builtin:quad', scale: vec3(1, 1, 1) },
}
export const PRIMITIVE_LABELS: Record<PrimitiveKind, string> = { box: 'Box', 'rounded-box': 'Rounded box', platform: 'Platform', wall: 'Wall', sphere: 'Sphere', capsule: 'Capsule', quad: 'Quad' }

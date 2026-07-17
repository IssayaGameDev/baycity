/**
 * @mp/physics — thin wrapper over Rapier3d (WASM, compat/SIMD build).
 * 3D only for now (SEED §2); headless-capable so simulation runs in Node.
 */

export const PHYSICS_BACKEND = 'rapier3d' as const

export type {
  ShapeDesc,
  BodyOptions,
  PhysicsBody,
  PhysicsWorld,
  PhysicsWorldOptions,
  CharacterOptions,
  CharacterBody,
} from './world'
export { initPhysics, createPhysicsWorld } from './world'

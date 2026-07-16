import type { Vec3 } from './math'

/** Stable per-entity identifier. Serialized as uint16 on the wire (M2). */
export type EntityId = number & { readonly __brand: 'EntityId' }

export const entityId = (n: number): EntityId => n as EntityId

/**
 * Minimal replicated entity state for the walking skeleton: id + position.
 * Rotation and further components arrive with physics (M3+).
 */
export interface EntityState {
  readonly id: EntityId
  readonly position: Vec3
}

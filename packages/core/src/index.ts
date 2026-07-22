/**
 * @mp/core — stack foundation: fixed-timestep loop, entity model, math,
 * transport interface. Imports no sibling package (SEED §6, law 1).
 */

export const CORE_VERSION = '0.0.0' as const

export type { Vec3, Quat } from './math'
export { vec3, lerp, clamp, lerpVec3, quat, eulerToQuat, axisAngleToQuat, mulQuat, rotateVec3, slerpQuat } from './math'

export type { EntityId, EntityState } from './entity'
export { entityId } from './entity'

export type { Stepper, LoopHandle } from './loop'
export { createStepper, startFixedLoop } from './loop'

export type { Bytes, Connection, ServerTransport, ClientTransport } from './transport'

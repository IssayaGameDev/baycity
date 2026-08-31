/**
 * @mp/core — stack foundation: fixed-timestep loop, entity model, math,
 * transport interface. Imports no sibling package (SEED §6, law 1).
 */

export const CORE_VERSION = '0.0.0' as const

export type { Vec3, Quat } from './math'
export { vec3, lerp, clamp, lerpVec3, quat, eulerToQuat, axisAngleToQuat, conjQuat, mulQuat, rotateVec3, slerpQuat, yawOf } from './math'

export type { InputCommand } from './input'

export type { EntityId, EntityState } from './entity'
export { entityId } from './entity'

export type { Stepper, LoopHandle } from './loop'
export { createStepper, startFixedLoop } from './loop'

export { TICK_DT, TICK_RATE_HZ } from './tick'

export type { SimClock, SimClockOptions } from './simClock'
export { createSimClock } from './simClock'

export type { Bytes, Connection, ServerTransport, ClientTransport } from './transport'

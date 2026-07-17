import { entityId, type EntityId, type Vec3 } from '@mp/core'

import { MSG_FIRE, MSG_HIT, PROTOCOL_VERSION, readHeader } from './messages'

/**
 * Lag-compensated hit claim (client → server). `fireTimeMs` is the server time
 * the shooter was rendering — the server rewinds to it before testing (SEED §3).
 */
export interface Fire {
  fireTimeMs: number // u32
  origin: Vec3 // f32 x3
  direction: Vec3 // f32 x3 (normalised)
}

/** Broadcast hit result (server → client). */
export interface Hit {
  shooterId: EntityId // u16
  targetId: EntityId // u16
}

const LE = true

export const encodeFire = (f: Fire): ArrayBuffer => {
  const buffer = new ArrayBuffer(30) // 2 + 4 + 12 + 12
  const view = new DataView(buffer)
  view.setUint8(0, PROTOCOL_VERSION)
  view.setUint8(1, MSG_FIRE)
  view.setUint32(2, f.fireTimeMs >>> 0, LE)
  view.setFloat32(6, f.origin.x, LE)
  view.setFloat32(10, f.origin.y, LE)
  view.setFloat32(14, f.origin.z, LE)
  view.setFloat32(18, f.direction.x, LE)
  view.setFloat32(22, f.direction.y, LE)
  view.setFloat32(26, f.direction.z, LE)
  return buffer
}

export const decodeFire = (buffer: ArrayBuffer): Fire => {
  readHeader(buffer, MSG_FIRE)
  const view = new DataView(buffer)
  return {
    fireTimeMs: view.getUint32(2, LE),
    origin: { x: view.getFloat32(6, LE), y: view.getFloat32(10, LE), z: view.getFloat32(14, LE) },
    direction: { x: view.getFloat32(18, LE), y: view.getFloat32(22, LE), z: view.getFloat32(26, LE) },
  }
}

export const encodeHit = (h: Hit): ArrayBuffer => {
  const buffer = new ArrayBuffer(6)
  const view = new DataView(buffer)
  view.setUint8(0, PROTOCOL_VERSION)
  view.setUint8(1, MSG_HIT)
  view.setUint16(2, h.shooterId, LE)
  view.setUint16(4, h.targetId, LE)
  return buffer
}

export const decodeHit = (buffer: ArrayBuffer): Hit => {
  readHeader(buffer, MSG_HIT)
  const view = new DataView(buffer)
  return { shooterId: entityId(view.getUint16(2, LE)), targetId: entityId(view.getUint16(4, LE)) }
}

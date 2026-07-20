/** Minimal math for the stack. Plain data + functions (no classes). */

export interface Vec3 {
  x: number
  y: number
  z: number
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z })

/** Linear interpolation. `t` is not clamped — callers clamp when needed. */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** Clamp `v` into the inclusive range [min, max]. */
export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v

/** Component-wise linear interpolation between two vectors. */
export const lerpVec3 = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  z: lerp(a.z, b.z, t),
})

/** Unit quaternion (x,y,z,w). Runtime orientation; content authors in euler and converts. */
export interface Quat {
  x: number
  y: number
  z: number
  w: number
}

export const quat = (x = 0, y = 0, z = 0, w = 1): Quat => ({ x, y, z, w })

/**
 * Euler angles (radians, intrinsic XYZ order — matches Three.js' default) → unit quaternion.
 * Shared by the physics wrapper (collider orientation) and the renderer so both agree.
 */
export const eulerToQuat = (e: Vec3): Quat => {
  const cx = Math.cos(e.x / 2)
  const sx = Math.sin(e.x / 2)
  const cy = Math.cos(e.y / 2)
  const sy = Math.sin(e.y / 2)
  const cz = Math.cos(e.z / 2)
  const sz = Math.sin(e.z / 2)
  return {
    x: sx * cy * cz + cx * sy * sz,
    y: cx * sy * cz - sx * cy * sz,
    z: cx * cy * sz + sx * sy * cz,
    w: cx * cy * cz - sx * sy * sz,
  }
}

/** Unit quaternion for a rotation of `angle` radians about `axis` (need not be normalized). */
export const axisAngleToQuat = (axis: Vec3, angle: number): Quat => {
  const len = Math.hypot(axis.x, axis.y, axis.z) || 1
  const s = Math.sin(angle / 2)
  return { x: (axis.x / len) * s, y: (axis.y / len) * s, z: (axis.z / len) * s, w: Math.cos(angle / 2) }
}

/** Hamilton product `a·b` — the rotation that applies `b` first, then `a`. */
export const mulQuat = (a: Quat, b: Quat): Quat => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
})

/** Rotate vector `v` by unit quaternion `q` (v + 2·q.w·t + 2·q.xyz×t, t = q.xyz×v). */
export const rotateVec3 = (q: Quat, v: Vec3): Vec3 => {
  const tx = 2 * (q.y * v.z - q.z * v.y)
  const ty = 2 * (q.z * v.x - q.x * v.z)
  const tz = 2 * (q.x * v.y - q.y * v.x)
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  }
}

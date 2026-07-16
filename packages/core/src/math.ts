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

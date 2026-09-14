/**
 * Position quantization (SEED §5): map a world coordinate to a u16 per axis
 * (~16-bit). One range for every level; per-level bounds on the wire are ADR 0092's
 * stated next step, and this value is the default they will fall back to.
 */

/**
 * Half-extent of the quantization range (world units); values clamp to ±this.
 *
 * ±1000 m over u16 is a 3.05 cm step (ADR 0092). Coarser than the ±40 it replaces, and affordable
 * because a peer's position is *cosmetic*: the server runs no physics and each client owns its own
 * body (ADR 0011), so nothing collides against a relayed position. Clamping, by contrast, is not
 * cosmetic — past the bound a peer stops moving on every screen but their own, and the delta's
 * change check compares quantized values, so the server stops relaying them at all.
 */
export const QUANT_BOUND = 1000
const QUANT_MAX = 65535

export const quantizeAxis = (v: number): number => {
  const t = (v + QUANT_BOUND) / (2 * QUANT_BOUND)
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.round(clamped * QUANT_MAX)
}

export const dequantizeAxis = (q: number): number => (q / QUANT_MAX) * (2 * QUANT_BOUND) - QUANT_BOUND

const TAU = Math.PI * 2
const BYTE_MAX = 255

/**
 * Facing to a byte: 256 steps over the turn, so 1.4°. The consumer smooths facing anyway (the
 * animator's own `yawHalfLife`), and a blocky character has no detail that a 1.4° step could disturb.
 * Any angle in or out of range is wrapped, so callers never have to normalize first.
 */
export const quantizeYaw = (yaw: number): number => {
  const turns = (((yaw / TAU) % 1) + 1) % 1
  return Math.round(turns * 256) % 256
}

/** Back to radians in [−π, π] — the range `Math.atan2` produces, which is what callers compare against. */
export const dequantizeYaw = (q: number): number => {
  const a = (q / 256) * TAU
  return a > Math.PI ? a - TAU : a
}

/** Top of the speed scale (m/s). Above the character controller's fastest setting, with headroom. */
export const SPEED_BOUND = 16

/** Locomotion speed to a byte: 0.063 m/s steps over 0–16 m/s. */
export const quantizeSpeed = (v: number): number => {
  const t = v / SPEED_BOUND
  return Math.round((t < 0 ? 0 : t > 1 ? 1 : t) * BYTE_MAX)
}

export const dequantizeSpeed = (q: number): number => (q / BYTE_MAX) * SPEED_BOUND

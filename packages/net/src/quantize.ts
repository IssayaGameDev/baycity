/**
 * Position quantization (SEED §5): map a world coordinate to a u16 per axis
 * (~16-bit). Plumbing that's present but tuned with a single default range —
 * per-game bounds/precision are a later concern.
 */

/** Half-extent of the quantization range (world units); values clamp to ±this. */
export const QUANT_BOUND = 40
const QUANT_MAX = 65535

export const quantizeAxis = (v: number): number => {
  const t = (v + QUANT_BOUND) / (2 * QUANT_BOUND)
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.round(clamped * QUANT_MAX)
}

export const dequantizeAxis = (q: number): number => (q / QUANT_MAX) * (2 * QUANT_BOUND) - QUANT_BOUND

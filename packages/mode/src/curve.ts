/**
 * A designed curve: control points, and a rule for the space between and beyond them (ADR 0088).
 *
 * The shape an incremental game's numbers take is exponential — a level that costs quadrillions by the mid game
 * — and the person shaping it thinks in "each level costs 1.15× the last", not in formulas. So a curve is a
 * handful of points on a graph, edited on a log axis where an exponential is a straight line, and the segments
 * between points interpolate either **linearly** or by **constant ratio** per unit of x. Beyond the last point
 * the curve either **holds** its last value or **extends** the last segment forever.
 *
 * Pure. Points are kept sorted by x; equal x collapses to the later point.
 */
export interface CurvePoint {
  x: number
  y: number
}

export type Interpolation = 'linear' | 'ratio'
export type Beyond = 'hold' | 'extend'

export interface CurveShape {
  interpolation: Interpolation
  beyond: Beyond
}

/** A usable list: finite numbers, sorted by x, one point per x. `null` when `raw` is not a curve at all. */
export const normalizePoints = (raw: unknown): CurvePoint[] | null => {
  if (!Array.isArray(raw)) return null
  const pts: CurvePoint[] = []
  for (const p of raw) {
    if (typeof p !== 'object' || p === null) return null
    const { x, y } = p as { x?: unknown; y?: unknown }
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null
    pts.push({ x, y })
  }
  pts.sort((a, b) => a.x - b.x)
  const out: CurvePoint[] = []
  for (const p of pts) {
    if (out.length > 0 && out[out.length - 1]!.x === p.x) out[out.length - 1] = p
    else out.push(p)
  }
  return out.length === 0 ? null : out
}

/** Ratio interpolation needs y > 0; anything at or below is lifted to this so the curve stays finite. */
export const RATIO_FLOOR = 1e-9

const between = (a: CurvePoint, b: CurvePoint, x: number, mode: Interpolation): number => {
  const t = (x - a.x) / (b.x - a.x)
  if (mode === 'linear') return a.y + (b.y - a.y) * t
  const y0 = Math.max(RATIO_FLOOR, a.y)
  const y1 = Math.max(RATIO_FLOOR, b.y)
  return y0 * (y1 / y0) ** t
}

/**
 * The curve's value at `x`. Before the first point: the first point's y. Between points: by `interpolation`.
 * After the last: `hold` repeats the last y, `extend` continues the last segment (its slope, or its per-unit
 * ratio); a one-point curve is constant either way.
 */
export const sampleCurve = (points: readonly CurvePoint[], x: number, shape: CurveShape): number => {
  const n = points.length
  if (n === 0) return 0
  const first = points[0]!
  const last = points[n - 1]!
  if (x <= first.x) return first.y
  if (x >= last.x) {
    if (shape.beyond === 'hold' || n === 1) return last.y
    return between(points[n - 2]!, last, x, shape.interpolation)
  }
  // Binary search for the segment.
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (points[mid]!.x <= x) lo = mid
    else hi = mid
  }
  return between(points[lo]!, points[hi]!, x, shape.interpolation)
}

/** The per-unit growth factor of the last segment under `ratio`, for a readout ("×1.15 / level"). `1` when flat. */
export const lastRatio = (points: readonly CurvePoint[]): number => {
  const n = points.length
  if (n < 2) return 1
  const a = points[n - 2]!
  const b = points[n - 1]!
  return (Math.max(RATIO_FLOOR, b.y) / Math.max(RATIO_FLOOR, a.y)) ** (1 / (b.x - a.x))
}

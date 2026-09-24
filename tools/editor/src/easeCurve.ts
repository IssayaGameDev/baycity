import { easeAt, type Ease } from '@mp/content'

/**
 * An ease drawn as its curve (ADR 0147): time along, progress up — on a step's line, on the ease button, and in
 * the picker's grid. Drawn from `easeAt` itself, so a picture can never disagree with what the game does.
 *
 * The box always holds 0 and 1, and grows to hold an overshoot, so `back` and `elastic` show theirs instead of
 * being clipped flat.
 */

/** The ease families the picker shows as rows, each with an in, an out and an in-out. `linear` stands alone. */
export const EASE_FAMILIES = ['sine', 'quad', 'cubic', 'quart', 'quint', 'expo', 'circ', 'back', 'elastic', 'bounce'] as const
export const EASE_MODES = ['in', 'out', 'in-out'] as const

/** The ease one row and column of the picker names. Every one of them is in `EASES`. */
export const easeOf = (family: (typeof EASE_FAMILIES)[number], mode: (typeof EASE_MODES)[number]): Ease => `${mode}-${family}` as Ease

/** `in-out-sine` → `Sine in-out`, and `Linear`: how a person names it. */
export const easeName = (e: Ease): string => {
  if (e === 'linear') return 'Linear'
  const at = e.lastIndexOf('-')
  const family = e.slice(at + 1)
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${e.slice(0, at)}`
}

/** The curve as an SVG path in a `width` × `height` box, `pad` in from every edge. */
export const easeCurvePath = (ease: Ease, width: number, height: number, pad = 1.5, samples = 48): string => {
  const ys = Array.from({ length: samples + 1 }, (_, i) => easeAt(ease, i / samples))
  const lo = Math.min(0, ...ys)
  const hi = Math.max(1, ...ys)
  const x = (i: number): number => pad + (i / samples) * (width - 2 * pad)
  const y = (v: number): number => height - pad - ((v - lo) / (hi - lo)) * (height - 2 * pad)
  return ys.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(' ')
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** The curve as an element, stroked in the text colour. */
export const easeCurve = (ease: Ease, width: number, height: number, className = 'ease-c'): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  svg.setAttribute('class', className)
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', easeCurvePath(ease, width, height))
  svg.append(path)
  return svg
}

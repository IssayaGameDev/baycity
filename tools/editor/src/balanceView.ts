/**
 * How the Balance tab reads a moment against its target (ADR 0225, Kodjo's call): on target within 10 % of it, early or
 * late outside; a target the simulator never reached is missed. Pure, so the window only draws.
 */

/** How far from its target a moment may come and still be on it, as a fraction of the target. */
export const ON_TARGET = 0.1

/** `none`: no target set; `missed`: a target, never reached. */
export type Verdict = 'none' | 'on' | 'early' | 'late' | 'missed'

export const verdictOf = (targetS: number | null, simulatedS: number | null): Verdict => {
  if (targetS === null) return 'none'
  if (simulatedS === null) return 'missed'
  if (Math.abs(simulatedS - targetS) <= ON_TARGET * targetS) return 'on'
  return simulatedS < targetS ? 'early' : 'late'
}

/** Seconds as the tab shows a time: `48s`, `4m05`, `1h05`. */
export const clockOf = (s: number): string => {
  const whole = Math.round(s)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const sec = whole % 60
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : m > 0 ? `${m}m${String(sec).padStart(2, '0')}` : `${sec}s`
}

/** What the last column says: by how much, which way; nothing without a target. */
export const differenceOf = (targetS: number | null, simulatedS: number | null): string => {
  const v = verdictOf(targetS, simulatedS)
  if (v === 'none') return ''
  if (v === 'missed') return 'not reached'
  const off = clockOf(Math.abs(simulatedS! - targetS!))
  return v === 'on' ? (off === '0s' ? 'on target' : `on target (${off} ${simulatedS! < targetS! ? 'early' : 'late'})`) : `${off} ${v}`
}

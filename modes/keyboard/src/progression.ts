/**
 * Experience, Level and Max Speed — the incremental loop, as arithmetic (ADR 0071, curves ADR 0088).
 *
 * Three values, and **only one of them is a speed**:
 *
 * - **Experience** is the currency. It goes up per step, times whatever multipliers are running, and it is what
 *   the counter on screen shows.
 * - **Level** is *derived* from Experience. It cannot be bought; it is the conversion, and in the game being
 *   cloned it is what gates the worlds.
 * - **Max Speed** is derived from Level, and *that* is the velocity — the cap on how fast the character moves.
 *
 * The game being cloned calls the currency "Speed", which is what made an earlier version of this treat a
 * player at 345,510 as moving at 345,510. They were moving at 100 studs a second. Calling it Experience keeps
 * the word "speed" for the only thing that is one.
 *
 * The shape of each conversion is a **designed curve** — control points Kodjo places in the editor, stored in
 * `content/keyboard/game.json` (ADR 0087/0088) — not a formula with parameters. Three of them:
 *
 * - `levelCost`: XP needed to go from Level L to L+1. Exponential, so edited on a log axis with constant-ratio
 *   segments; extends forever, because Level 500 must not be free.
 * - `speed`: Max Speed at Level, studs/s. Linear segments; extends.
 * - `cadence`: steps per minute at Level (`components/steps.ts`). Linear segments; holds past the last point.
 *
 * Headless and pure, so the curves can be checked against real save data rather than eyeballed in play.
 */
import { readSettings, sampleCurve, type CurvePoint, type CurveSetting, type SettingDecl } from '@mp/mode'

export interface ProgressCurve {
  levelCost: CurvePoint[]
  speed: CurvePoint[]
  cadence: CurvePoint[]
}

/** One stud, in metres. A unit, not a balance value: the character's world is metric, the game's numbers are studs. */
export const METRES_PER_STUD = 0.28

/** What a step pays before any multiplier. Always one; the multipliers are the game (ADR 0082). */
export const BASE_PER_STEP = 1

const LEVEL_COST_SHAPE = { interpolation: 'ratio', beyond: 'extend' } as const
const SPEED_SHAPE = { interpolation: 'linear', beyond: 'extend' } as const
const CADENCE_SHAPE = { interpolation: 'linear', beyond: 'hold' } as const

/**
 * The three curves, as the editor edits them (ADR 0088). The defaults are the fits that came before them:
 * Level 1 costs 100 and each level 1.15× the last (Kodjo's Level 45 save), speed 10 + 2 per Level (two readings),
 * cadence Kodjo's eight readings (ADR 0081). The data behind them is thin; that is what the editor is for.
 */
export const CURVE_SETTINGS = {
  levelCost: {
    kind: 'curve',
    label: 'Level cost',
    hint: 'XP to go from a Level to the next. Ratio segments, extends: Level 500 costs what the trend says',
    xLabel: 'Level',
    yLabel: 'XP to next Level',
    ...LEVEL_COST_SHAPE,
    logY: true,
    yMin: 1,
    default: [
      { x: 0, y: 100 },
      { x: 100, y: 100 * 1.15 ** 100 },
    ],
  },
  speed: {
    kind: 'curve',
    label: 'Max Speed',
    hint: 'studs/s at a Level, before the world multiplier',
    xLabel: 'Level',
    yLabel: 'studs/s',
    ...SPEED_SHAPE,
    yMin: 0,
    default: [
      { x: 0, y: 10 },
      { x: 100, y: 210 },
    ],
  },
  cadence: {
    kind: 'curve',
    label: 'Step cadence',
    hint: 'steps per minute of held input at a Level; holds past the last point',
    xLabel: 'Level',
    yLabel: 'steps/min',
    ...CADENCE_SHAPE,
    yMin: 1,
    default: [
      { x: 0, y: 240 },
      { x: 20, y: 240 },
      { x: 30, y: 270 },
      { x: 50, y: 420 },
      { x: 85, y: 540 },
      { x: 170, y: 600 },
    ],
  },
} satisfies Record<keyof ProgressCurve, CurveSetting & SettingDecl>

export const DEFAULT_CURVE: ProgressCurve = readSettings(CURVE_SETTINGS, undefined)

/** The curves a game's data file holds: its `settings` block over the defaults. */
export const curveFrom = (settings: unknown): ProgressCurve => readSettings(CURVE_SETTINGS, settings)

/** XP to go from `level` to `level + 1`. */
export const levelCostAt = (level: number, curve: ProgressCurve = DEFAULT_CURVE): number =>
  Math.max(0, sampleCurve(curve.levelCost, Math.max(0, level), LEVEL_COST_SHAPE))

/**
 * Cumulative costs, per curve, grown on demand and remembered: `levelAt` runs every frame and a Level in the
 * hundreds must not mean hundreds of curve samples each time. Keyed by the point array itself, so a curve the
 * editor replaces gets a fresh table and an unchanged one keeps its own.
 */
const tables = new WeakMap<readonly CurvePoint[], number[]>()
const cumulative = (curve: ProgressCurve, upTo: number): number[] => {
  let t = tables.get(curve.levelCost)
  if (t === undefined) {
    t = [0]
    tables.set(curve.levelCost, t)
  }
  while (t.length <= upTo) t.push(t[t.length - 1]! + levelCostAt(t.length - 1, curve))
  return t
}

/** The total Experience at which `level` is reached. */
export const experienceForLevel = (level: number, curve: ProgressCurve = DEFAULT_CURVE): number => {
  if (level <= 0) return 0
  const L = Math.floor(level)
  return cumulative(curve, L)[L]!
}

/** Levels never grow past this in a lookup: the sum has hit Infinity or the loop would never end. */
const MAX_LEVEL = 100_000

export const levelAt = (
  experience: number,
  curve: ProgressCurve = DEFAULT_CURVE,
): { level: number; into: number; next: number } => {
  if (!(experience > 0)) return { level: 0, into: 0, next: levelCostAt(0, curve) }
  // Grow the table until it passes the experience, then binary search it.
  let t = cumulative(curve, 1)
  while (t[t.length - 1]! <= experience && t.length <= MAX_LEVEL && Number.isFinite(t[t.length - 1]!)) t = cumulative(curve, t.length * 2)
  let lo = 0
  let hi = t.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (t[mid]! <= experience) lo = mid
    else hi = mid
  }
  const level = t[hi]! <= experience ? hi : lo
  const reached = t[level]!
  return { level, into: Math.max(0, experience - reached), next: levelCostAt(level, curve) }
}

export const maxSpeedAt = (level: number, curve: ProgressCurve = DEFAULT_CURVE): number =>
  Math.max(0, sampleCurve(curve.speed, Math.max(0, level), SPEED_SHAPE))

export const stepsPerMinute = (level: number, curve: ProgressCurve = DEFAULT_CURVE): number =>
  Math.max(0, sampleCurve(curve.cadence, Math.max(0, level), CADENCE_SHAPE))

export const maxSpeedMps = (level: number, curve: ProgressCurve = DEFAULT_CURVE): number => maxSpeedAt(level, curve) * METRES_PER_STUD

/**
 * The counter's number, the way the genre writes it: two decimals under 100, one above, and the short scale up
 * to decillions — trails reach ×3 million and totals go far past quadrillions.
 */
export const abbreviate = (n: number): string => {
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '0'
  const units: readonly [number, string][] = [
    [1e33, 'Dc'],
    [1e30, 'No'],
    [1e27, 'Oc'],
    [1e24, 'Sp'],
    [1e21, 'Sx'],
    [1e18, 'Qi'],
    [1e15, 'Qa'],
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]
  for (const [size, suffix] of units)
    if (n >= size) {
      const scaled = n / size
      return `${scaled < 100 ? scaled.toFixed(2) : scaled.toFixed(1)}${suffix}`
    }
  return Math.floor(n).toString()
}

const KEY = 'keyboard.experience'

export const loadExperience = (): number => {
  try {
    const raw = localStorage.getItem(KEY)
    const n = raw === null ? 0 : Number.parseFloat(raw)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

export const saveExperience = (experience: number): void => {
  try {
    localStorage.setItem(KEY, String(Math.floor(experience)))
  } catch {
    // A session that cannot save still plays.
  }
}

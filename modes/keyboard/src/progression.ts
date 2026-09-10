/**
 * Experience, Level and Max Speed — the incremental loop, as arithmetic (ADR 0071).
 *
 * Three values, and **only one of them is a speed**:
 *
 * - **Experience** is the currency. It goes up by one per keycap struck, times whatever multipliers are
 *   running, and it is what the counter on screen shows.
 * - **Level** is *derived* from Experience. It cannot be bought; it is the conversion, and in the game being
 *   cloned it is what gates the worlds.
 * - **Max Speed** is derived from Level, and *that* is the velocity — the cap on how fast the character moves.
 *
 * The game being cloned calls the currency "Speed", which is what made an earlier version of this treat a
 * player at 345,510 as moving at 345,510. They were moving at 100 studs a second. Calling it Experience keeps
 * the word "speed" for the only thing that is one.
 *
 * Headless and pure, so the curve can be checked against real save data rather than eyeballed in play.
 */

export interface ProgressCurve {
  /** Experience gained per keycap struck, before multipliers. The genre's "+1". */
  perKey: number
  /**
   * What level 1 costs, in Experience.
   *
   * Fitted to Kodjo's save of the real game: 345,510 at Level 45 with 33,840 banked toward a 46,850 level.
   * Levels 1–45 therefore cost ~311,670 between them while level 46 alone costs 46,850 — steeply escalating,
   * and a geometric fit puts the first level near 100.
   */
  firstLevel: number
  /**
   * How much more each level costs than the last.
   *
   * ~1.15 from the same fit. It is the whole pacing dial: 1.1 makes Level 400 reachable in an afternoon and
   * 1.2 makes it a wall.
   */
  levelGrowth: number
  /** Max Speed at level 0, in studs/s. */
  baseMaxSpeed: number
  /**
   * Studs/s of Max Speed per level.
   *
   * 2 exactly, from two readings of Kodjo's save: level 45 gives 100 and level 46 gives 102.
   */
  maxSpeedPerLevel: number
  /**
   * Metres per stud.
   *
   * Roblox's own scale, so the speed on screen means what it means in the game being cloned. Movement is in
   * metres because the physics is.
   */
  metresPerStud: number
}

export const DEFAULT_CURVE: ProgressCurve = {
  perKey: 1,
  firstLevel: 100,
  levelGrowth: 1.15,
  baseMaxSpeed: 10,
  maxSpeedPerLevel: 2,
  metresPerStud: 0.28,
}

/**
 * What level 1 → `level` costs in total, i.e. the Experience at which `level` is reached.
 *
 * A geometric series in closed form rather than a loop: Level 400 is a real target in this genre, and summing
 * four hundred terms every frame to draw a progress bar would be four hundred terms too many.
 */
export const experienceForLevel = (level: number, curve: ProgressCurve = DEFAULT_CURVE): number => {
  if (level <= 0) return 0
  const r = curve.levelGrowth
  // r === 1 would divide by zero, and a flat cost is a legitimate thing to set the slider to.
  if (Math.abs(r - 1) < 1e-9) return curve.firstLevel * level
  return curve.firstLevel * ((r ** level - 1) / (r - 1))
}

/**
 * The level a given Experience has bought, and how far into the next one it is.
 *
 * Inverted in closed form for the same reason: `level = log(1 + xp(r-1)/first) / log(r)`, then floored. The
 * remainder is the progress bar, which is the thing a player actually watches.
 *
 * **Nudged before flooring.** The logarithm and the exponent it inverts do not agree to the last bit, so
 * exactly on a boundary the ratio comes back as 3.9999999 and floors to 3 — the player would see the previous
 * level with a completely full bar at the instant they bought the next one. The nudge is far smaller than a
 * level and far larger than the error.
 */
export const levelAt = (
  experience: number,
  curve: ProgressCurve = DEFAULT_CURVE,
): { level: number; into: number; next: number } => {
  if (experience <= 0) return { level: 0, into: 0, next: curve.firstLevel }
  const r = curve.levelGrowth
  const exact =
    Math.abs(r - 1) < 1e-9
      ? experience / curve.firstLevel
      : Math.log1p((experience * (r - 1)) / curve.firstLevel) / Math.log(r)
  const level = Math.floor(exact + BOUNDARY_NUDGE)
  const reached = experienceForLevel(level, curve)
  // Clamped at zero for the same reason the nudge exists: `reached` can come back a hair above `experience`.
  return { level, into: Math.max(0, experience - reached), next: experienceForLevel(level + 1, curve) - reached }
}

/** Smaller than any level and larger than the round-trip error between `log` and `**`. */
const BOUNDARY_NUDGE = 1e-9

/** The velocity cap a level grants, in studs/s. The one number here that really is a speed. */
export const maxSpeedAt = (level: number, curve: ProgressCurve = DEFAULT_CURVE): number =>
  curve.baseMaxSpeed + curve.maxSpeedPerLevel * level

/** The same, in metres per second — what the character controller actually wants. */
export const maxSpeedMps = (level: number, curve: ProgressCurve = DEFAULT_CURVE): number =>
  maxSpeedAt(level, curve) * curve.metresPerStud

/**
 * `345510` as `345.51K`.
 *
 * Its own function because a counter that reads `345510` and a counter that reads `345.51K` are different
 * feelings, and the whole point of an incremental game is the counter.
 */
export const abbreviate = (n: number): string => {
  const units: readonly [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]
  for (const [size, suffix] of units)
    if (n >= size) {
      const scaled = n / size
      // Two decimals under 100, one above: `345.51K` but `1.2M`, which is how the genre writes it.
      return `${scaled < 100 ? scaled.toFixed(2) : scaled.toFixed(1)}${suffix}`
    }
  return Math.floor(n).toString()
}

/**
 * Experience across reloads, in this game's own `localStorage` key.
 *
 * Not `PlayerProgress` (`@mp/game-client`), which holds a checkpoint index and belongs to the platform's save
 * shape. Experience is **this game's stat**, so it lives in this game — the same reasoning that put the rope in
 * `modes/swing` rather than a field on `ModeDescriptor` (ADR 0065).
 *
 * Best-effort both ways: a locked-down browser throws on either call, and a game that loads at zero beats one
 * that will not load.
 */
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

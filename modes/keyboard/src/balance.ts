import { experienceForLevel, levelAt, maxSpeedAt, stepsPerMinute, type ProgressCurve } from './progression'

/**
 * The balance simulator (ADR 0087): one imagined player, holding forward, run through the curve.
 *
 * Pure and deterministic. Every number in it is one the game already uses — `levelAt`, `maxSpeedAt`,
 * `stepsPerMinute`, the `StepPad` rule, the `WinsPad` payout — so the table it prints is what the game would
 * do, not a second model of it. What it adds is the one thing the game cannot show: **time**. How long to
 * Level 10, when the ×2 pad becomes affordable, how many stages an hour. Kodjo reads the table, changes a
 * setting in the editor, reads it again.
 *
 * The model is deliberately simple: the player always holds a direction (`hold` fraction of the time), runs
 * each stage at Max Speed along `lengthStuds`, and takes the best pad Wins allow the moment they allow it. No
 * falling, no treadmills, no jumping. It is a ceiling on progress, which is the useful thing to know.
 */
export interface StagePlan {
  /** Path length spawn → Wins pad, in studs, as run. Cycled: after the last stage the first comes again. */
  lengthStuds: number
  /** What its `WinsPad` pays. */
  wins: number
}

export interface PadPlan {
  perStep: number
  requiresWins: number
}

export interface SimInput {
  curve: ProgressCurve
  stages: readonly StagePlan[]
  pads: readonly PadPlan[]
  /** Seconds to simulate. */
  horizonS: number
  /** Fraction of the time a direction is held. 1 = a bot, ~0.85 = a person. */
  hold?: number
  /** Where the player starts. Default: fresh. */
  start?: { experience: number; wins: number }
  /** Simulation step, seconds. Default 0.1. */
  dt?: number
}

export interface SimSample {
  t: number
  experience: number
  level: number
  /** studs/s */
  speed: number
  wins: number
  perStep: number
  stagesDone: number
}

export interface SimResult {
  /** Seconds at which each Level was first reached; index = level. `levelAt[0] = 0`. */
  levelAt: number[]
  /** Seconds at which each pad (by input index) first became affordable, or `null` within the horizon. */
  padAt: (number | null)[]
  /** Seconds at which each stage completion happened. */
  stageAt: number[]
  /** One sample per `everyS` seconds (60 by default), plus the final state. */
  samples: SimSample[]
  final: SimSample
}

/** The `StepPad` rule: the best pad these Wins qualify for, else the curve's base. */
export const perStepFor = (wins: number, pads: readonly PadPlan[], base: number): number =>
  pads.reduce((best, p) => (wins >= p.requiresWins && p.perStep > best ? p.perStep : best), base)

export const simulate = (input: SimInput, everyS = 60): SimResult => {
  const { curve, stages, pads } = input
  const dt = input.dt ?? 0.1
  const hold = Math.min(1, Math.max(0, input.hold ?? 1))
  if (stages.length === 0) throw new Error('simulate: at least one stage')

  let step = 0
  let t = 0
  let experience = input.start?.experience ?? 0
  let wins = input.start?.wins ?? 0
  let stage = 0
  let distance = 0
  let stagesDone = 0
  // Where the player already stands at t = 0: their starting Level, and the pads their Wins already allow.
  const levelAtS: number[] = Array.from({ length: levelAt(experience, curve).level + 1 }, () => 0)
  const padAt: (number | null)[] = pads.map((p) => (wins >= p.requiresWins ? 0 : null))
  const stageAt: number[] = []
  const samples: SimSample[] = []
  let nextSample = 0

  const sample = (): SimSample => {
    const level = levelAt(experience, curve).level
    return { t, experience, level, speed: maxSpeedAt(level, curve), wins, perStep: perStepFor(wins, pads, curve.perKey), stagesDone }
  }

  while (t < input.horizonS - 1e-9) {
    if (t >= nextSample - 1e-9) {
      samples.push(sample())
      nextSample += everyS
    }
    const level = levelAt(experience, curve).level
    const speed = maxSpeedAt(level, curve)
    const perStep = perStepFor(wins, pads, curve.perKey)
    experience += (stepsPerMinute(level, curve) / 60) * dt * hold * perStep
    distance += speed * dt * hold
    // Counted, not summed: 3000 additions of 0.1 drift off the round minutes the samples sit on.
    step++
    t = step * dt

    const current = stages[stage]!
    if (distance >= current.lengthStuds) {
      wins += current.wins
      stagesDone++
      stageAt.push(t)
      distance = 0
      stage = (stage + 1) % stages.length
    }
    const now = levelAt(experience, curve).level
    while (levelAtS.length <= now) levelAtS.push(t)
    for (let i = 0; i < pads.length; i++) if (padAt[i] === null && wins >= pads[i]!.requiresWins) padAt[i] = t
  }

  const final = sample()
  samples.push(final)
  return { levelAt: levelAtS, padAt, stageAt, samples, final }
}

const clock = (s: number): string => {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : m > 0 ? `${m}m${String(sec).padStart(2, '0')}` : `${sec}s`
}

const short = (n: number): string => {
  for (const [size, suffix] of [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ] as const)
    if (n >= size) return `${(n / size).toFixed(n / size < 100 ? 2 : 1)}${suffix}`
  return Math.floor(n).toString()
}

const pad = (s: string, w: number): string => s.padStart(w)

/** The table: milestones first, then the timeline. Plain text, for a terminal or a doc. */
export const formatReport = (input: SimInput, r: SimResult): string => {
  const out: string[] = []
  const c = input.curve
  out.push(`curve: perKey ${c.perKey}, level 1 = ${c.firstLevel} XP ×${c.levelGrowth}/level, speed ${c.baseMaxSpeed} + ${c.maxSpeedPerLevel}/level studs/s, cadence ${c.stepsFloor}→${c.stepsCap} steps/min (τ ${c.stepsTau})`)
  out.push(`stages: ${input.stages.map((s) => `${s.lengthStuds} studs → ${s.wins} Wins`).join(' · ')}; hold ${(input.hold ?? 1) * 100}%; ${clock(input.horizonS)}`)
  out.push('')
  out.push('Level milestones')
  const marks = [1, 2, 5, 10, 15, 20, 30, 40, 50, 75, 100, 150, 200, 300]
  for (const L of marks) {
    const at = r.levelAt[L]
    if (at === undefined) continue
    out.push(`  L${pad(String(L), 3)}  ${pad(clock(at), 7)}   ${pad(short(experienceForLevel(L, c)), 8)} XP   ${pad(maxSpeedAt(L, c).toFixed(0), 4)} studs/s   ${pad(stepsPerMinute(L, c).toFixed(0), 4)} steps/min`)
  }
  out.push(`  reached L${r.final.level} in ${clock(input.horizonS)}`)
  out.push('')
  out.push('Pads')
  input.pads.forEach((p, i) => {
    const at = r.padAt[i]
    out.push(`  +${pad(String(p.perStep), 4)}/step  needs ${pad(short(p.requiresWins), 6)} Wins   ${at === null || at === undefined ? 'not within the horizon' : `at ${clock(at)}`}`)
  })
  out.push('')
  out.push(`Stages: ${r.stageAt.length} completed; first at ${r.stageAt[0] === undefined ? '—' : clock(r.stageAt[0])}, last ${r.stageAt.at(-1) === undefined ? '—' : clock(r.stageAt.at(-1)!)}`)
  out.push('')
  out.push(`${pad('time', 7)} ${pad('XP', 9)} ${pad('level', 5)} ${pad('studs/s', 7)} ${pad('Wins', 7)} ${pad('/step', 6)} ${pad('stages', 6)}`)
  for (const s of r.samples) {
    out.push(`${pad(clock(s.t), 7)} ${pad(short(s.experience), 9)} ${pad(String(s.level), 5)} ${pad(s.speed.toFixed(0), 7)} ${pad(short(s.wins), 7)} ${pad(String(s.perStep), 6)} ${pad(String(s.stagesDone), 6)}`)
  }
  return out.join('\n')
}

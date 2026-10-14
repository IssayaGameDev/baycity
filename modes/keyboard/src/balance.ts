import type { PadTier } from './padTable'
import { BASE_PER_STEP, levelAt, maxSpeedAt, rebirthLevelAt, rebirthMultiplierAt, stepsPerMinute, type ProgressCurve } from './progression'

/**
 * The balance simulator (ADR 0087, 0088; rebuilt on the World, ADR 0223): one imagined player through the whole game,
 * from the numbers the designer sets and nothing else — the curves and the pad table (the game's settings) and each
 * world's `World` (its level). It adds time: when each stage is first cleared, when each pad and rebirth comes.
 *
 * The player, as Kodjo's game plays:
 *
 * - **Steps** accrue the whole time a direction is held (`hold`), at the cadence curve, each paying the best pad its
 *   Wins have reached (pads stick, ADR 0082) × the world's base XP × the rebirth multiplier.
 * - **A stage is a speed gate**: its row's Level, as Max Speed × the world's speed multiplier. Below it, it cannot be
 *   passed. A run takes `floor + (run − floor) × gate ÷ speed` — exactly the row's run time at the gate, never under
 *   its floor (a timer, a door) however fast.
 * - **A run fails** with the row's chance; a failed one costs `failCost` of a run (half, on average a fall comes
 *   midway) and the trip back. Every clear pays the row's Wins and sends the player to the spawn, and back to a
 *   stage by teleport: `overheadSeconds`.
 * - **It pushes forward** whenever the next stage is passable — clearing it reaches the one after; otherwise it
 *   **farms the reached stage paying the most Wins a minute** (Kodjo's call).
 * - **It rebirths** the moment the Level allows, between runs; **moves to the next world** (by its Level to enter)
 *   once that world has stages, starting it from its first stage.
 *
 * Only what the game has: no trails or auras. A sharp player — no idling, no wasted runs — so the times are a floor
 * on a real one's. For comparing one set of numbers against another.
 */

/** One stage, as its World row says (`fail` as a fraction). */
export interface SimStage {
  readonly level: number
  readonly wins: number
  readonly runSeconds: number
  readonly floorSeconds: number
  readonly failChance: number
}

/** One world, as its level's `World` says. */
export interface SimWorld {
  readonly name: string
  readonly baseXp: number
  readonly speedMultiplier: number
  readonly levelToEnter: number
  /** How many of the pad table's tiers its spawn holds. */
  readonly padTiers: number
  readonly stages: readonly SimStage[]
}

export interface SimInput {
  readonly curve: ProgressCurve
  readonly pads: readonly PadTier[]
  readonly worlds: readonly SimWorld[]
  /** Seconds to simulate. */
  readonly horizonS: number
  /** Fraction of the time a direction is held. 1 = a bot, ~0.85 = a person. */
  readonly hold?: number
  /** What a failed run costs, as a fraction of a run. Default ½. */
  readonly failCost?: number
  /** Seconds from a cash-out or a fall back to running a stage: the spawn, the teleport. Default 3. */
  readonly overheadSeconds?: number
  /** Simulation step, seconds. Default 0.25. */
  readonly dt?: number
}

export interface SimSample {
  t: number
  experience: number
  level: number
  /** studs/s, the world's multiplier applied. */
  speed: number
  wins: number
  /** The whole per-step product. */
  perStep: number
  world: string
  /** The stage being run, 1-based; 0 none. */
  running: number
  /** Stages cleared at least once in this world. */
  cleared: number
  rebirths: number
}

export interface SimEvent {
  t: number
  what: string
}

export interface SimResult {
  /** Seconds at which each Level was first reached in the current run; index = level. Reset by a rebirth. */
  levelAt: number[]
  /** When each stage was first cleared, by `<world>/<stage number>`. */
  clearedAt: Map<string, number>
  /** Everything notable, in order: a stage cleared, a switch of stage farmed, a pad, a rebirth, a world. */
  events: SimEvent[]
  /** One sample per `everyS` seconds, plus the final state. */
  samples: SimSample[]
  final: SimSample
}

/** A stage's gate, in studs/s: the Max Speed of its Level, times the world's multiplier. */
export const gateSpeed = (stage: SimStage, world: Pick<SimWorld, 'speedMultiplier'>, curve: ProgressCurve): number =>
  maxSpeedAt(stage.level, curve) * world.speedMultiplier

/** One run at `speed` (≥ the gate): the row's run time at the gate, shrinking with speed, never under its floor. */
export const runSeconds = (stage: SimStage, gate: number, speed: number): number =>
  stage.floorSeconds + Math.max(0, stage.runSeconds - stage.floorSeconds) * (speed <= 0 ? 1 : Math.min(1, gate / speed))

/**
 * Seconds a clear takes on average: the run and the trip back, plus — for the failed runs before it, `p ÷ (1 − p)` of
 * them — `failCost` of a run and the trip back each. A chance is held under 95 %.
 */
export const clearSeconds = (stage: SimStage, gate: number, speed: number, failCost: number, overheadSeconds: number): number => {
  const p = Math.min(0.95, Math.max(0, stage.failChance))
  const run = runSeconds(stage, gate, speed)
  return run + overheadSeconds + (p / (1 - p)) * (failCost * run + overheadSeconds)
}

/** The best pad these Wins have reached among a world's first `tiers`; the base without one. */
export const padFor = (wins: number, pads: readonly PadTier[], tiers: number): number =>
  pads.slice(0, Math.max(0, tiers)).reduce((best, p) => (wins >= p.requiresWins && p.perStep > best ? p.perStep : best), BASE_PER_STEP)

/** A run under way: its stage's index, seconds left, and whether it is the frontier being pushed. */
interface Run {
  at: number
  left: number
  pushing: boolean
}

export const simulate = (input: SimInput, everyS = 60): SimResult => {
  const { curve, pads } = input
  const dt = input.dt ?? 0.25
  const hold = Math.min(1, Math.max(0, input.hold ?? 1))
  const failCost = Math.max(0, input.failCost ?? 0.5)
  const overhead = Math.max(0, input.overheadSeconds ?? 3)
  const worlds = [...input.worlds].sort((a, b) => a.levelToEnter - b.levelToEnter)
  if (worlds.length === 0 || worlds[0]!.stages.length === 0) throw new Error('simulate: a first world with stages is needed')

  let step = 0
  let t = 0
  let experience = 0
  let wins = 0
  let rebirths = 0
  let reborn = 1
  let worldIx = 0
  /** Stages of this world cleared at least once, in order: the next is the frontier. */
  let cleared = 0
  /** The pad taken: the best ever reached, kept. */
  let pad = BASE_PER_STEP
  /** The run under way: its stage's index, seconds left, and whether it is the frontier being pushed. */
  let run: Run | null = null
  let farmed = -1

  const levelAtS: number[] = [0]
  const clearedAt = new Map<string, number>()
  const events: SimEvent[] = []
  const samples: SimSample[] = []
  let nextSample = 0

  const world = (): SimWorld => worlds[worldIx]!
  const level = (): number => levelAt(experience, curve).level
  const speedNow = (): number => maxSpeedAt(level(), curve) * world().speedMultiplier
  const perStep = (): number => pad * world().baseXp * reborn
  const note = (what: string): void => void events.push({ t, what })
  const sample = (): SimSample => ({
    t,
    experience,
    level: level(),
    speed: speedNow(),
    wins,
    perStep: perStep(),
    world: world().name,
    running: run === null ? 0 : run.at + 1,
    cleared,
    rebirths,
  })

  /** What to run next: the frontier when passable, else the reached stage paying the most Wins a minute; `null` for none. */
  const choose = (): Run | null => {
    const w = world()
    const speed = speedNow()
    const passable = (i: number): boolean => i < w.stages.length && speed >= gateSpeed(w.stages[i]!, w, curve)
    const seconds = (i: number): number => clearSeconds(w.stages[i]!, gateSpeed(w.stages[i]!, w, curve), speed, failCost, overhead)
    if (cleared < w.stages.length && passable(cleared)) return { at: cleared, left: seconds(cleared), pushing: true }
    let best = -1
    let rate = 0
    for (let i = 0; i < Math.min(cleared, w.stages.length); i++) {
      if (!passable(i)) continue
      const perMinute = (w.stages[i]!.wins / seconds(i)) * 60
      if (perMinute > rate) {
        best = i
        rate = perMinute
      }
    }
    if (best < 0) return null
    if (best !== farmed) {
      farmed = best
      note(`farming stage ${best + 1} of ${w.name}: ${short(rate)} Wins/min`)
    }
    return { at: best, left: seconds(best), pushing: false }
  }

  /** Between runs: a rebirth the Level allows, then the next world its Level opens. */
  const between = (): void => {
    const L = level()
    if (L >= rebirthLevelAt(rebirths + 1, curve)) {
      rebirths++
      reborn = rebirthMultiplierAt(rebirths, curve)
      note(`rebirth ${rebirths} at Level ${L}: ×${short(reborn)} XP from now on, XP and Level reset`)
      experience = 0
      levelAtS.length = 1
      farmed = -1
    }
    const next = worlds[worldIx + 1]
    if (next !== undefined && next.stages.length > 0 && level() >= next.levelToEnter) {
      worldIx++
      cleared = 0
      farmed = -1
      note(`entered ${next.name} at Level ${level()}`)
    }
  }

  while (t < input.horizonS - 1e-9) {
    if (t >= nextSample - 1e-9) {
      samples.push(sample())
      nextSample += everyS
    }
    if (run === null) run = choose()

    // Earn: every held step, wherever it is taken.
    experience += (stepsPerMinute(level(), curve) / 60) * dt * hold * perStep()
    step++
    t = step * dt

    if (run !== null) {
      run.left -= dt
      if (run.left <= 0) {
        const w = world()
        wins += w.stages[run.at]!.wins
        if (run.pushing) {
          cleared++
          clearedAt.set(`${w.name}/${run.at + 1}`, t)
          note(`stage ${run.at + 1} of ${w.name} cleared (Level ${level()}, ${short(wins)} Wins)`)
        }
        run = null
        between()
      }
    }

    const reached = padFor(wins, pads, world().padTiers)
    if (reached > pad) {
      pad = reached
      note(`pad +${short(pad)}/step taken (${short(pads.find((p) => p.perStep === pad)?.requiresWins ?? 0)} Wins)`)
    }
    const now = level()
    while (levelAtS.length <= now) levelAtS.push(t)
  }

  const final = sample()
  samples.push(final)
  return { levelAt: levelAtS, clearedAt, events, samples, final }
}

const clock = (s: number): string => {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : m > 0 ? `${m}m${String(sec).padStart(2, '0')}` : `${sec}s`
}

const short = (n: number): string => {
  if (!Number.isFinite(n)) return '∞'
  for (const [size, suffix] of [
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
  ] as const)
    if (n >= size) return `${(n / size).toFixed(n / size < 100 ? 2 : 1)}${suffix}`
  return n >= 100 ? Math.floor(n).toString() : n.toFixed(n === Math.floor(n) ? 0 : 2)
}

const pad = (s: string, w: number): string => s.padStart(w)

/** The report: what it read, the Level milestones, every stage, the events, the timeline. Plain text. */
export const formatReport = (input: SimInput, r: SimResult): string => {
  const out: string[] = []
  const c = input.curve
  out.push(`level cost: ${c.levelCost.map((p) => `L${p.x}=${short(p.y)}`).join(' → ')}; speed: ${c.speed.map((p) => `L${p.x}=${p.y}`).join(' → ')} studs/s; cadence: ${c.cadence.map((p) => `L${p.x}=${p.y}`).join(' → ')} steps/min`)
  out.push(`rebirth: ${c.rebirthLevel.map((p) => `#${p.x} at L${p.y}`).join(', ')} for ${c.rebirthMultiplier.map((p) => `#${p.x} ×${short(p.y)}`).join(', ')}; pads: ${input.pads.map((p) => `+${short(p.perStep)}@${short(p.requiresWins)}`).join(' ')}`)
  out.push(`${input.worlds.map((w) => `${w.name}: ${w.stages.length} stages, ${w.padTiers} pads, base ×${w.baseXp} XP, ×${w.speedMultiplier} speed, from Level ${w.levelToEnter}`).join(' · ')}`)
  out.push(`player: hold ${Math.round((input.hold ?? 1) * 100)}%, a failed run costs ${Math.round((input.failCost ?? 0.5) * 100)}% of a run, ${input.overheadSeconds ?? 3}s back to a stage; ${clock(input.horizonS)}`)
  out.push('')
  out.push('Level milestones (current run)')
  for (const L of [1, 2, 5, 10, 15, 20, 30, 40, 50, 75, 100, 120, 150, 200, 300, 400]) {
    const at = r.levelAt[L]
    if (at === undefined) continue
    out.push(`  L${pad(String(L), 3)}  ${pad(clock(at), 7)}   ${pad(maxSpeedAt(L, c).toFixed(0), 4)} studs/s   ${pad(stepsPerMinute(L, c).toFixed(0), 4)} steps/min`)
  }
  for (const w of input.worlds) {
    out.push('')
    out.push(`${w.name} — stage: Level, gate studs/s, Wins, run/floor s, fail %, first cleared`)
    w.stages.forEach((s, i) => {
      const at = r.clearedAt.get(`${w.name}/${i + 1}`)
      out.push(
        `  ${pad(String(i + 1), 2)}  L${pad(String(s.level), 3)} ${pad(gateSpeed(s, w, c).toFixed(0), 5)} ${pad(short(s.wins), 7)}  ${pad(`${s.runSeconds}/${s.floorSeconds}`, 7)} ${pad(String(Math.round(s.failChance * 100)), 3)}%  ${at === undefined ? '—' : clock(at)}`,
      )
    })
  }
  out.push('')
  out.push('Events')
  for (const e of r.events) out.push(`  ${pad(clock(e.t), 7)}  ${e.what}`)
  out.push('')
  out.push(`${pad('time', 7)} ${pad('XP', 9)} ${pad('level', 5)} ${pad('studs/s', 7)} ${pad('Wins', 8)} ${pad('/step', 9)} ${pad('world', 14)} ${pad('run', 4)} ${pad('clear', 5)} ${pad('rebirth', 7)}`)
  for (const s of r.samples) {
    out.push(
      `${pad(clock(s.t), 7)} ${pad(short(s.experience), 9)} ${pad(String(s.level), 5)} ${pad(s.speed.toFixed(0), 7)} ${pad(short(s.wins), 8)} ${pad(short(s.perStep), 9)} ${pad(s.world, 14)} ${pad(String(s.running), 4)} ${pad(String(s.cleared), 5)} ${pad(String(s.rebirths), 7)}`,
    )
  }
  return out.join('\n')
}

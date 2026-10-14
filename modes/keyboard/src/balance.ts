import { BASE_PER_STEP, levelAt, maxSpeedAt, rebirthLevelAt, rebirthMultiplierAt, stepsPerMinute, type ProgressCurve } from './progression'

/**
 * The balance simulator (ADR 0087, rebuilt on gates ADR 0088): one imagined player run through the whole loop.
 *
 * Pure and deterministic, and it uses the game's own conversions — `levelAt`, `maxSpeedAt`, `stepsPerMinute`,
 * the `StepPad` rule — never a second model of them. What it adds is **time**: when Level 30 comes, when stage 10
 * opens, when the ×25 pad is affordable, when the first rebirth happens.
 *
 * The model, as Kodjo described the game (`docs/games/keyboard/world-1.md`):
 *
 * - A **stage is a speed gate**: it needs `speed`, pays `wins` once per clear, and returns you to spawn. The
 *   player always runs the furthest stage of the current world their speed passes, and clears it in
 *   `clearSeconds` at the gate speed, shrinking towards `fastClearSeconds` as speed grows past it. Length is
 *   not a balance value.
 * - Steps accrue the whole time a direction is held (`hold`), at the cadence curve, each paying
 *   `1 × pad × world × rebirth × trail × aura`.
 * - **Wins** are spent greedily: the best affordable trail and aura are bought as soon as they can be. Pads
 *   are thresholds, free to take, and **a pad once taken stays** (ADR 0082) even after Wins are spent below it.
 * - **Rebirth** the moment its Level is reached: XP and Level reset, and the multiplier is the curves' for that
 *   rebirth (`rebirthLevel`, `rebirthMultiplier`, ADR 0221) — the game's own, from the same settings.
 * - **Worlds** open at a Level; the player moves to the highest open one and stays there.
 *
 * It is a ceiling: a player who knows every route, never idles, never dies below the gate. Its use is comparing
 * one set of curves against another, not predicting a clock.
 */
export interface GateStage {
  stage: number
  /** studs/s the obstacle needs. */
  speed: number
  /** Wins one clear pays. */
  wins: number
}

export interface WorldPlan {
  name: string
  /** Level at which the world opens; World 1 is 0. */
  levelRequired: number
  /** Per-step XP × and Max Speed × in this world. */
  xpMultiplier: number
  speedMultiplier: number
  stages: readonly GateStage[]
}

export interface PadPlan {
  perStep: number
  requiresWins: number
}

/** A trail or an aura: bought once with Wins, the best owned is the one equipped. */
export interface ShopItem {
  name: string
  wins: number
  multiplier: number
}

export interface Scenario {
  worlds: readonly WorldPlan[]
  pads: readonly PadPlan[]
  trails: readonly ShopItem[]
  auras: readonly ShopItem[]
  /** Seconds a stage takes at exactly its gate speed, and at speeds far above it. */
  clearSeconds: number
  fastClearSeconds: number
}

export interface SimInput {
  curve: ProgressCurve
  scenario: Scenario
  /** Seconds to simulate. */
  horizonS: number
  /** Fraction of the time a direction is held. 1 = a bot, ~0.85 = a person. */
  hold?: number
  /** Simulation step, seconds. Default 0.25. */
  dt?: number
}

export interface SimSample {
  t: number
  experience: number
  level: number
  /** studs/s, world multiplier applied. */
  speed: number
  wins: number
  /** The whole per-step product. */
  perStep: number
  world: string
  stage: number
  rebirths: number
}

export interface SimEvent {
  t: number
  what: string
}

export interface SimResult {
  /** Seconds at which each Level was first reached in the current run; index = level. Reset by a rebirth. */
  levelAt: number[]
  /** First time each stage (by world and stage number) became passable. */
  stageOpenAt: Map<string, number>
  /** Everything notable, in order: stage opened, pad taken, purchase, rebirth, world entered. */
  events: SimEvent[]
  /** One sample per `everyS` seconds, plus the final state. */
  samples: SimSample[]
  final: SimSample
}

/** The `StepPad` rule: the best pad these Wins qualify for, else the base. */
export const perStepFor = (wins: number, pads: readonly PadPlan[], base: number): number =>
  pads.reduce((best, p) => (wins >= p.requiresWins && p.perStep > best ? p.perStep : best), base)

/** Seconds to clear a gate at `speed`: `clearSeconds` at the gate, `fastClearSeconds` from twice the gate up, linear between. */
export const clearTime = (gate: number, speed: number, clearSeconds: number, fastClearSeconds: number): number => {
  if (gate <= 0) return fastClearSeconds
  const over = Math.min(1, Math.max(0, speed / gate - 1))
  return clearSeconds + (fastClearSeconds - clearSeconds) * over
}

export const simulate = (input: SimInput, everyS = 60): SimResult => {
  const { curve, scenario } = input
  const dt = input.dt ?? 0.25
  const hold = Math.min(1, Math.max(0, input.hold ?? 1))
  const worlds = [...scenario.worlds].sort((a, b) => a.levelRequired - b.levelRequired)
  if (worlds.length === 0 || worlds.every((w) => w.stages.length === 0)) throw new Error('simulate: a world with stages is needed')

  let step = 0
  let t = 0
  let experience = 0
  let wins = 0
  let rebirths = 0
  let rebirthMult = 1
  const owned = { trail: 1, aura: 1 }
  const bought = new Set<string>()
  let worldIx = 0
  let stageIx = 0
  let progressS = 0 // seconds into the current clear
  let padPerStep = BASE_PER_STEP // the pad taken: the best ever qualified for, kept when Wins are spent

  const levelAtS: number[] = [0]
  const stageOpenAt = new Map<string, number>()
  const seenEmpty = new Set<string>()
  const events: SimEvent[] = []
  const samples: SimSample[] = []
  let nextSample = 0

  const world = (): WorldPlan => worlds[worldIx]!
  const level = (): number => levelAt(experience, curve).level
  const speedNow = (L: number): number => maxSpeedAt(L, curve) * world().speedMultiplier
  const perStepNow = (): number => padPerStep * world().xpMultiplier * rebirthMult * owned.trail * owned.aura

  const sample = (): SimSample => {
    const L = level()
    return { t, experience, level: L, speed: speedNow(L), wins, perStep: perStepNow(), world: world().name, stage: world().stages[stageIx]?.stage ?? 0, rebirths }
  }
  const note = (what: string): void => {
    events.push({ t, what })
  }

  /** The furthest stage of the current world the speed passes; stage 1 when none does. */
  const bestStage = (speed: number): number => {
    const stages = world().stages
    let best = 0
    for (let i = 0; i < stages.length; i++) if (stages[i]!.speed <= speed) best = i
    return best
  }

  const shop = (kind: 'trail' | 'aura', items: readonly ShopItem[]): void => {
    // Best affordable not yet owned. Buying a worse one than equipped is pointless, so only upgrades.
    const candidates = items.filter((i) => !bought.has(`${kind}:${i.name}`) && i.wins <= wins && i.multiplier > owned[kind]).sort((a, b) => b.multiplier - a.multiplier)
    const pick = candidates[0]
    if (pick === undefined) return
    wins -= pick.wins
    bought.add(`${kind}:${pick.name}`)
    owned[kind] = pick.multiplier
    note(`${kind} ${pick.name} bought (×${pick.multiplier}) for ${pick.wins} Wins`)
  }

  while (t < input.horizonS - 1e-9) {
    if (t >= nextSample - 1e-9) {
      samples.push(sample())
      nextSample += everyS
    }
    const L = level()
    const speed = speedNow(L)

    // World: move up when open. A world with no stages defined yet cannot be played, so it is noted and skipped.
    while (worldIx + 1 < worlds.length && worlds[worldIx + 1]!.levelRequired <= L) {
      const next = worlds[worldIx + 1]!
      if (next.stages.length === 0) {
        if (!seenEmpty.has(next.name)) {
          seenEmpty.add(next.name)
          note(`${next.name} open at Level ${L} — no stages defined, staying in ${world().name}`)
        }
        break
      }
      worldIx++
      stageIx = 0
      progressS = 0
      note(`entered ${world().name} at Level ${L}`)
    }

    // Stage: the furthest passable; a newly opened one is an event.
    const target = bestStage(speed)
    if (target !== stageIx) {
      stageIx = target
      progressS = 0
    }
    const current = world().stages[stageIx]!
    const key = `${world().name}/${current.stage}`
    if (!stageOpenAt.has(key)) {
      stageOpenAt.set(key, t)
      note(`stage ${current.stage} of ${world().name} passable (needs ${current.speed} studs/s, Level ${L})`)
    }

    // Earn.
    experience += (stepsPerMinute(L, curve) / 60) * dt * hold * perStepNow()
    progressS += dt * hold
    step++
    t = step * dt

    // Clear.
    if (progressS >= clearTime(current.speed, speed, scenario.clearSeconds, scenario.fastClearSeconds)) {
      wins += current.wins
      progressS = 0
    }

    // Spend: pads are thresholds and stick; trails and auras cost.
    const best = perStepFor(wins, scenario.pads, padPerStep)
    if (best > padPerStep) {
      padPerStep = best
      note(`pad +${best}/step taken (${scenario.pads.find((p) => p.perStep === best)?.requiresWins ?? 0} Wins)`)
    }
    shop('trail', scenario.trails)
    shop('aura', scenario.auras)

    // Level milestones, then rebirth.
    const now = level()
    while (levelAtS.length <= now) levelAtS.push(t)
    if (now >= rebirthLevelAt(rebirths + 1, curve)) {
      rebirths++
      rebirthMult = rebirthMultiplierAt(rebirths, curve)
      note(`rebirth ${rebirths} at Level ${now}: ×${rebirthMult} from now on, XP and Level reset`)
      experience = 0
      levelAtS.length = 1
    }
  }

  const final = sample()
  samples.push(final)
  return { levelAt: levelAtS, stageOpenAt, events, samples, final }
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

/** The report: what the curves say, the events, then the timeline. Plain text. */
export const formatReport = (input: SimInput, r: SimResult): string => {
  const out: string[] = []
  const c = input.curve
  out.push(`level cost: ${c.levelCost.map((p) => `L${p.x}=${short(p.y)}`).join(' → ')}; speed: ${c.speed.map((p) => `L${p.x}=${p.y}`).join(' → ')} studs/s; cadence: ${c.cadence.map((p) => `L${p.x}=${p.y}`).join(' → ')} steps/min`)
  out.push(`${input.scenario.worlds.map((w) => `${w.name}: ${w.stages.length} stages, ×${w.xpMultiplier} XP, ×${w.speedMultiplier} speed, from Level ${w.levelRequired}`).join(' · ')}; hold ${Math.round((input.hold ?? 1) * 100)}%; ${clock(input.horizonS)}`)
  out.push('')
  out.push('Level milestones (current run)')
  for (const L of [1, 2, 5, 10, 15, 20, 30, 40, 50, 75, 100, 120, 150, 200, 300, 400]) {
    const at = r.levelAt[L]
    if (at === undefined) continue
    out.push(`  L${pad(String(L), 3)}  ${pad(clock(at), 7)}   ${pad(maxSpeedAt(L, c).toFixed(0), 4)} studs/s   ${pad(stepsPerMinute(L, c).toFixed(0), 4)} steps/min`)
  }
  out.push('')
  out.push('Events')
  for (const e of r.events) out.push(`  ${pad(clock(e.t), 7)}  ${e.what}`)
  out.push('')
  out.push(`${pad('time', 7)} ${pad('XP', 9)} ${pad('level', 5)} ${pad('studs/s', 7)} ${pad('Wins', 8)} ${pad('/step', 9)} ${pad('world', 8)} ${pad('stage', 5)} ${pad('rebirth', 7)}`)
  for (const s of r.samples) {
    out.push(
      `${pad(clock(s.t), 7)} ${pad(short(s.experience), 9)} ${pad(String(s.level), 5)} ${pad(s.speed.toFixed(0), 7)} ${pad(short(s.wins), 8)} ${pad(short(s.perStep), 9)} ${pad(s.world, 8)} ${pad(String(s.stage), 5)} ${pad(String(s.rebirths), 7)}`,
    )
  }
  return out.join('\n')
}

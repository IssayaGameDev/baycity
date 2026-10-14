import { defaultsOf, readParams } from '@mp/components'
import { readSettings, type CurvePoint, type NumberSetting, type TableRows } from '@mp/mode'

import { simulate, type SimWorld } from './balance'
import { STAGE_ROW, World } from './components/world'
import type { PadTier } from './padTable'
import { curveFrom, type ProgressCurve } from './progression'

/**
 * World 1's balance from a few rules (ADR 0226, Kodjo's model): the rules in, every number out — the Max Speed, Level
 * cost and rebirth curves, the pad table, and the World's stage rows — written by the Balance tab's Apply.
 *
 * - **The pace**: a stage k is first within reach at `a × k(k+1)/2` minutes — each wait a step longer than the last —
 *   with `a` such that the next world opens at the world's length; a stage's Level is the last one's spread evenly.
 * - **Wins**: stage 1 pays the first, each stage the growth times the last.
 * - **Pads**: a new pad every few stages from the first, each paying the growth times the last; one unlocks once the
 *   player holds what they held on its stage's first clear plus the grind's payouts of that stage.
 * - **Rebirths**: one every few stages, at that stage's Level, each the growth times the last.
 * - **Level cost**: each Level the growth more than the last, from the cost that brings the next world in on time —
 *   the one number found by simulating (`simulate`, the Balance tab's own player).
 *
 * Trails are not in the game, so not in the model. Step cadence is left as it is set.
 */

export const MODEL_RULES = {
  modelMinutes: { label: 'World length, min', default: 45, min: 1, step: 1, hint: 'from the start until the next world opens' },
  modelStages: { label: 'Stages', default: 15, min: 1, step: 1 },
  modelLastLevel: { label: 'Last stage’s Level', default: 95, min: 1, step: 1, hint: 'the stages’ Levels are spread evenly up to it' },
  modelNextLevel: { label: 'Next world opens at Level', default: 100, min: 1, step: 1 },
  modelSpeed0: { label: 'Speed at Level 0', default: 10, min: 0, step: 1 },
  modelSpeed100: { label: 'Speed at Level 100', default: 200, min: 0, step: 1 },
  modelCostGrowth: { label: 'Each Level costs more, %', default: 12.5, min: 0.1, step: 0.5 },
  modelFirstWins: { label: 'Stage 1 pays, Wins', default: 1, min: 1, step: 1 },
  modelWinsGrowth: { label: 'Each stage pays, × the last', default: 2, min: 1, step: 0.1 },
  modelPads: { label: 'Step pads', default: 8, min: 1, step: 1, hint: 'the first is free' },
  modelPadEvery: { label: 'A new pad every, stages', default: 2, min: 1, step: 1 },
  modelPadGrowth: { label: 'Each pad pays, × the last', default: 2, min: 1, step: 0.1 },
  modelGrind: { label: 'Grind, payouts', default: 1, min: 0, step: 1, hint: 'how many more payouts of its stage a pad waits for after the stage’s first clear' },
  modelRebirthEvery: { label: 'A rebirth every, stages', default: 4, min: 1, step: 1 },
  modelRebirthGrowth: { label: 'Each rebirth, × the last', default: 2, min: 1, step: 0.1 },
} satisfies Record<string, NumberSetting>

export type ModelRules = { readonly [K in keyof typeof MODEL_RULES]: number }

/** What the model writes. */
export interface ModelOut {
  readonly settings: { speed: CurvePoint[]; levelCost: CurvePoint[]; rebirthLevel: CurvePoint[]; rebirthMultiplier: CurvePoint[]; pads: TableRows }
  /** The World's stage rows, each linked obstacle and run kept. */
  readonly stages: Record<string, unknown>[]
  readonly notes: string[]
}

/** The player the model is simulated for: the Balance tab's. */
export interface ModelPlayer {
  readonly hold: number
  readonly failCost: number
  readonly overheadSeconds: number
}

const sig = (n: number, digits: number): number => {
  if (n <= 0 || !Number.isFinite(n)) return n
  const p = 10 ** (Math.floor(Math.log10(n)) - digits + 1)
  return Math.round(n / p) * p
}
/** Up to two significant figures: a price a person reads, never under what it rounds. */
const priceOf = (n: number): number => {
  if (n <= 10) return Math.ceil(n)
  const p = 10 ** (Math.floor(Math.log10(n)) - 1)
  return Math.ceil(n / p - 1e-9) * p
}

export const generateModel = (rules: ModelRules, player: ModelPlayer, settings: unknown, worldParams: Readonly<Record<string, unknown>> | null): ModelOut | { refused: string } => {
  if (worldParams === null) return { refused: 'Open World 1’s level, the one with its World component: Apply writes its stages.' }
  const n = Math.round(rules.modelStages)
  const last = Math.round(rules.modelLastLevel)
  const next = Math.round(rules.modelNextLevel)
  if (last < n) return { refused: `The last stage’s Level (${last}) has to be at least the number of stages (${n}).` }
  if (next <= last) return { refused: `The next world has to open after the last stage’s Level (${last}).` }
  const world = readParams(World.params, { ...worldParams }, 'World')
  const rows = world.stages
  const extra = rows.slice(n).filter((row) => row.obstacle !== null)
  if (extra.length > 0) return { refused: `The World has ${rows.length} stages and the model ${n}, and rows past ${n} hold an obstacle: set Stages to ${rows.length}, or take those rows out.` }

  const notes: string[] = []
  const levels = Array.from({ length: n }, (_, i) => Math.round((last * (i + 1)) / n))
  const wins = levels.map((_, i) => Math.max(1, Math.round(rules.modelFirstWins * rules.modelWinsGrowth ** i)))
  // Each wait a step longer than the last, the gap to the next world counted at the last stage's pace.
  const a = rules.modelMinutes / ((n * (n + 1)) / 2 + ((n + 1) * (next - last)) / (last / n))
  const targets = levels.map((_, i) => Math.round(a * ((i + 1) * (i + 2)) / 2 * 10) / 10)
  // Each row as it is stored — its obstacle, its run — with the model's Level, Wins and target over it.
  const stored = Array.isArray(worldParams.stages) ? (worldParams.stages as unknown[]) : []
  const asStored = (i: number): Record<string, unknown> => {
    const row = stored[i]
    return typeof row === 'object' && row !== null && !Array.isArray(row) ? (row as Record<string, unknown>) : {}
  }
  const stages = levels.map((level, i) => ({ ...defaultsOf(STAGE_ROW), ...asStored(i), level, wins: wins[i]!, target: targets[i]! }))
  const runs = levels.map((_, i) => rows[i] ?? defaultsOf(STAGE_ROW))

  const speed: CurvePoint[] = [
    { x: 0, y: rules.modelSpeed0 },
    { x: 100, y: rules.modelSpeed100 },
  ]
  const now = curveFrom(settings)
  const every = Math.max(1, Math.round(rules.modelRebirthEvery))
  const rebirthStages = Array.from({ length: Math.floor(n / every) }, (_, j) => every * (j + 1))
  const rebirthLevel = rebirthStages.length === 0 ? now.rebirthLevel : rebirthStages.map((s, j) => ({ x: j + 1, y: levels[s - 1]! }))
  const rebirthMultiplier = rebirthStages.length === 0 ? now.rebirthMultiplier : rebirthStages.map((_, j) => ({ x: j + 1, y: sig(rules.modelRebirthGrowth ** (j + 1), 3) }))
  if (rebirthStages.length === 0) notes.push('No rebirth falls inside World 1: the rebirth curves are left as they are.')

  const padEvery = Math.max(1, Math.round(rules.modelPadEvery))
  const padCount = Math.min(Math.round(rules.modelPads), 1 + Math.floor(n / padEvery))
  if (padCount < Math.round(rules.modelPads)) notes.push(`Only ${padCount} pads fit in ${n} stages at one every ${padEvery}.`)
  const padStage = (tier: number): number => padEvery * tier // tier 0 is the free one
  const perStep = Array.from({ length: padCount }, (_, k) => sig(rules.modelPadGrowth ** k, 3))
  const listed = world.pads.length
  if (listed > 0 && listed !== padCount) notes.push(`The World lists ${listed} step pads and the model has ${padCount}: list ${padCount}.`)

  const growth = 1 + rules.modelCostGrowth / 100
  const simWorld: SimWorld = {
    name: 'model',
    baseXp: world.baseXp,
    speedMultiplier: world.speedMultiplier,
    levelToEnter: 0,
    padTiers: padCount,
    stages: levels.map((level, i) => ({ level, wins: wins[i]!, runSeconds: runs[i]!.gateSeconds, floorSeconds: runs[i]!.floorSeconds, failChance: runs[i]!.fail / 100 })),
  }
  // The next world, only for the moment it opens.
  const opens: SimWorld = { name: 'next', baseXp: 1, speedMultiplier: 1, levelToEnter: next, padTiers: padCount, stages: [{ level: next, wins: 1, runSeconds: 1, floorSeconds: 1, failChance: 0 }] }
  const want = rules.modelMinutes * 60
  const curveFor = (c0: number): ProgressCurve => ({ ...now, speed, rebirthLevel, rebirthMultiplier, levelCost: [{ x: 0, y: c0 }, { x: 100, y: c0 * growth ** 100 }] })
  const run = (c0: number, pads: readonly PadTier[]) =>
    simulate({ curve: curveFor(c0), pads, worlds: [simWorld, opens], horizonS: want * 3, ...player, until: (m) => m.enteredAt.has('next') }, 1e12)

  /** The pads' prices for a Level cost: each set where it unlocks — on its stage's first clear, plus the grind. */
  const priced = (c0: number): PadTier[] => {
    const tiers: PadTier[] = perStep.map((p, k) => ({ perStep: p, requiresWins: k === 0 ? 0 : Infinity }))
    for (let k = 1; k < padCount; k++) {
      const stage = padStage(k)
      const held = run(c0, tiers).winsAtClear.get(`model/${stage}`)
      if (held === undefined) break
      tiers[k] = { perStep: perStep[k]!, requiresWins: priceOf(held + Math.max(0, Math.round(rules.modelGrind)) * wins[stage - 1]!) }
    }
    return tiers
  }
  const opensAt = (c0: number): number => {
    const r = run(c0, priced(c0))
    return r.enteredAt.get('next') ?? Infinity
  }
  // The one number simulated: the Level cost that opens the next world at the world's length.
  let lo = Math.log(1e-2)
  let hi = Math.log(1e6)
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (opensAt(Math.exp(mid)) < want) lo = mid
    else hi = mid
  }
  const c0 = sig(Math.exp((lo + hi) / 2), 3)
  const tiers = priced(c0)
  const unpriced = tiers.findIndex((t) => !Number.isFinite(t.requiresWins))
  if (unpriced >= 0) return { refused: `Pad ${unpriced + 1}’s stage is never reached in ${rules.modelMinutes} minutes: give the world longer, or fewer pads.` }
  if (!Number.isFinite(opensAt(c0))) return { refused: `No Level cost brings the next world in at ${rules.modelMinutes} minutes with these rules.` }

  notes.push(`World 2 opens at Level ${next}: set that as its World’s Level to enter.`)
  return {
    settings: {
      speed,
      levelCost: [
        { x: 0, y: c0 },
        { x: 100, y: sig(c0 * growth ** 100, 3) },
      ],
      rebirthLevel,
      rebirthMultiplier,
      pads: tiers.map((t) => ({ perStep: t.perStep, requiresWins: t.requiresWins })),
    },
    stages,
    notes,
  }
}

/** The rules as `game.json`'s settings hold them, over their defaults. */
export const modelRulesFrom = (settings: unknown): ModelRules => readSettings(MODEL_RULES, settings)

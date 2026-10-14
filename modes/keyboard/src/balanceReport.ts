import { readSettings, type BalanceDecl, type BalanceGroup, type BalanceLevel, type BalanceReport, type NumberSetting, type TableRows, type TableSetting } from '@mp/mode'

import { simulate, type Milestones } from './balance'
import { generateModel, MODEL_RULES, type ModelRules } from './balanceModel'
import { defaultWorldRead, distinctWorlds, targetSeconds, worldReadOf, type WorldRead } from './balanceWorlds'
import { World } from './components/world'
import { padTiersFrom } from './padTable'
import { curveFrom, rebirthLevelAt } from './progression'

/**
 * Keyboard's Balance tab (ADR 0225, step 3 of ADR 0222): the simulator (ADR 0223) over the game's settings and every
 * level's `World`, each moment beside its target — a stage's speed first there and a world's entry from its World's
 * rows, a rebirth from the game's settings. The window colours them; this says what they are. Its model (ADR 0226,
 * `balanceModel.ts`) writes those numbers from a few rules.
 */

/** The rebirth targets, a game setting beside the rebirth curves: row n is when rebirth n should come. */
export const REBIRTH_TARGETS = {
  rebirthTargets: {
    kind: 'table',
    label: 'Rebirth targets',
    hint: 'row n: the minutes into the game rebirth n should come — the Balance tab sets the simulated run against it',
    columns: { minutes: { label: 'target min', default: 10, min: 0, step: 0.5 } },
    default: [],
  },
} satisfies Record<string, TableSetting>

/** The imagined player, as the Balance tab lets you change it: what `simulate` assumes, in the units a person thinks in. */
export const PLAYER_OPTIONS = {
  hold: { label: 'Time moving, %', default: 100, min: 0, max: 100, step: 1, hint: 'how much of the time the player runs: 100 never stops' },
  failCost: { label: 'Lost on a fall, % of a run', default: 50, min: 0, max: 100, step: 5, hint: 'on average a fall comes halfway through' },
  overhead: { label: 'Walk back, seconds', default: 3, min: 0, step: 0.5, hint: 'from a Wins pad or a fall back to running: the spawn and the teleport' },
} satisfies Record<string, NumberSetting>

/** The options as `simulate` takes them. */
const playerOf = (options: Readonly<Record<string, number>>) => ({
  hold: (options.hold ?? PLAYER_OPTIONS.hold.default) / 100,
  failCost: (options.failCost ?? PLAYER_OPTIONS.failCost.default) / 100,
  overheadSeconds: options.overhead ?? PLAYER_OPTIONS.overhead.default,
})

/** How far it looks: a moment not reached in a day of play is not reached. */
export const HORIZON_S = 24 * 3600

export const balanceReport = (input: { settings: unknown; levels: readonly BalanceLevel[]; options: Readonly<Record<string, number>> }): BalanceReport => {
  const curve = curveFrom(input.settings)
  const pads = padTiersFrom(input.settings)
  const rebirthTargets = (readSettings(REBIRTH_TARGETS, input.settings).rebirthTargets as TableRows).map((r) => targetSeconds(r.minutes ?? 0))
  const notes: string[] = []

  const read = [...input.levels]
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((l) => {
      const w = worldReadOf(l.name, l.level, pads.length)
      return w === null ? [] : [w]
    })
  const { kept, skipped } = distinctWorlds(read)
  for (const why of skipped) notes.push(`${why}: left out.`)
  if (kept.length === 0) notes.push('No level has a World: a World as a new one is, the design stages.')
  // In the order they are entered, which is the simulator's.
  const worlds: WorldRead[] = (kept.length > 0 ? kept : [defaultWorldRead(pads.length)]).sort((a, b) => a.world.levelToEnter - b.world.levelToEnter)
  if (worlds[0]!.world.stages.length === 0) return { groups: [], notes: [...notes, `${worlds[0]!.world.name} has no stages: nothing to simulate.`] }

  // Stop once every stage is cleared and every rebirth with a target has come.
  const reached = (m: Milestones): boolean =>
    m.rebirthAt.length >= rebirthTargets.length && worlds.every((w) => w.world.stages.every((_, i) => m.clearedAt.has(`${w.world.name}/${i + 1}`)))
  const r = simulate({ curve, pads, worlds: worlds.map((w) => w.world), horizonS: HORIZON_S, ...playerOf(input.options), until: reached }, HORIZON_S)
  if (!reached(r)) notes.push(`Simulated ${HORIZON_S / 3600} h of play: a moment with no time is not reached by then.`)

  const groups: BalanceGroup[] = worlds.map((w, k) => ({
    title: w.world.name,
    moments: [
      ...(k === 0 ? [] : [{ label: `entered (Level ${w.world.levelToEnter})`, targetS: w.enterTargetS, simulatedS: r.enteredAt.get(w.world.name) ?? null }]),
      // A stage's moment is its speed first there, as its target is (ADR 0226): the clear comes a run later.
      ...w.world.stages.map((_, i) => ({ label: `stage ${i + 1}`, targetS: w.stageTargetsS[i] ?? null, simulatedS: r.reachedAt.get(`${w.world.name}/${i + 1}`) ?? null })),
    ],
  }))
  const rebirths = Math.max(rebirthTargets.length, r.rebirthAt.length)
  if (rebirths > 0) {
    groups.push({
      title: 'Rebirths',
      moments: Array.from({ length: rebirths }, (_, i) => ({
        label: `rebirth ${i + 1} (Level ${rebirthLevelAt(i + 1, curve)})`,
        targetS: rebirthTargets[i] ?? null,
        simulatedS: r.rebirthAt[i] ?? null,
      })),
    })
  }
  return { groups, notes }
}

/** Apply (ADR 0226): the model over the open level's World, as settings and that World's stage rows. */
const applyModel: NonNullable<BalanceDecl['apply']> = ({ settings, rules, options, paramsOf }) => {
  const out = generateModel({ ...(Object.fromEntries(Object.entries(MODEL_RULES).map(([k, d]) => [k, d.default])) as ModelRules), ...rules }, playerOf(options), settings, paramsOf(World.type))
  if ('refused' in out) return { refused: out.refused, settings: {}, component: null, notes: [] }
  return { refused: null, settings: out.settings, component: { type: World.type, patch: { stages: out.stages } }, notes: out.notes }
}

export const KEYBOARD_BALANCE: BalanceDecl = { options: PLAYER_OPTIONS, report: balanceReport, rules: MODEL_RULES, apply: applyModel }

import { readSettings, type BalanceDecl, type BalanceGroup, type BalanceLevel, type BalanceReport, type NumberSetting, type TableRows, type TableSetting } from '@mp/mode'

import { simulate, type Milestones } from './balance'
import { defaultWorldRead, distinctWorlds, targetSeconds, worldReadOf, type WorldRead } from './balanceWorlds'
import { padTiersFrom } from './padTable'
import { curveFrom, rebirthLevelAt } from './progression'

/**
 * Keyboard's Balance tab (ADR 0225, step 3 of ADR 0222): the simulator (ADR 0223) over the game's settings and every
 * level's `World`, each moment beside its target — a stage's first clear and a world's entry from its World's rows, a
 * rebirth from the game's settings. The window colours them; this says what they are.
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
  hold: { label: 'moving %', default: 100, min: 0, max: 100, step: 1, hint: 'how much of the time a direction is held: 100 never stops' },
  failCost: { label: 'a failed run costs %', default: 50, min: 0, max: 100, step: 5, hint: 'of a run: on average a fall comes midway' },
  overhead: { label: 'back to a stage, s', default: 3, min: 0, step: 0.5, hint: 'after a clear or a fall: the spawn, the teleport' },
} satisfies Record<string, NumberSetting>

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
  const options = { ...Object.fromEntries(Object.entries(PLAYER_OPTIONS).map(([k, o]) => [k, o.default])), ...input.options }
  const r = simulate(
    {
      curve,
      pads,
      worlds: worlds.map((w) => w.world),
      horizonS: HORIZON_S,
      hold: (options.hold ?? 100) / 100,
      failCost: (options.failCost ?? 50) / 100,
      overheadSeconds: options.overhead ?? 3,
      until: reached,
    },
    HORIZON_S,
  )
  if (!reached(r)) notes.push(`Simulated ${HORIZON_S / 3600} h of play: a moment with no time is not reached by then.`)

  const groups: BalanceGroup[] = worlds.map((w, k) => ({
    title: w.world.name,
    moments: [
      ...(k === 0 ? [] : [{ label: `entered (Level ${w.world.levelToEnter})`, targetS: w.enterTargetS, simulatedS: r.enteredAt.get(w.world.name) ?? null }]),
      ...w.world.stages.map((_, i) => ({ label: `stage ${i + 1}`, targetS: w.stageTargetsS[i] ?? null, simulatedS: r.clearedAt.get(`${w.world.name}/${i + 1}`) ?? null })),
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

export const KEYBOARD_BALANCE: BalanceDecl = { options: PLAYER_OPTIONS, report: balanceReport }

import { componentOn, defineComponent, type ComponentRef, type ParamDecls } from '@mp/components'
import type { LoadedLevel, WorldNode } from '@mp/content'

import { GAME_PADS, type PadTier } from '../padTable'
import { Obstacle } from './obstacle'
import { StepPad } from './stepPad'

/**
 * A world's balance, on the level it is (ADR 0222, Kodjo's design): one `World` per level, the central place for what
 * the world pays and asks.
 *
 * - `baseXp`, `speedMultiplier` — what a step pays, times its pad's value (World 1 = 1), and Max Speed times this.
 * - `levelToEnter` — the Level the world opens at. Nothing travels between worlds yet: the simulator reads it.
 * - `stages` — a row a stage: the Obstacle, the Level it requires, the Wins it pays, how long a run takes at its gate
 *   speed and the floor no speed goes under (a timer, a door), and the chance a run fails (Kodjo's call, over a count
 *   of falls), and the minutes into the game its first clear should come (ADR 0225; 0 for none). A row's place is its
 *   stage number and its Checkpoint number; dragging a row moves all of it.
 * - `targetToEnter` — the minutes into the game the world should be entered (ADR 0225; 0 for none).
 * - `pads` — the step pads of its spawn, in order: a pad's place is its tier in the game's pad table (`padTable.ts`).
 *
 * As the level loads it sets each listed Obstacle's Wins and Level (which the Obstacle sets on its pad and sign) and
 * each listed pad's values — `drives`, so the game, its rules and the editor read the same numbers. Those fields are
 * hidden where they are set, so they are edited here and nowhere else.
 */

/** One stage row. */
export const STAGE_ROW = {
  obstacle: { kind: 'componentRef', of: Obstacle.type, label: 'obstacle' },
  level: { kind: 'number', default: 0, min: 0, step: 1, label: 'Level' },
  wins: { kind: 'number', default: 1, min: 1, step: 1, label: 'Wins' },
  gateSeconds: { kind: 'number', default: 45, min: 0, step: 1, label: 'run s' },
  floorSeconds: { kind: 'number', default: 5, min: 0, step: 1, label: 'floor s' },
  fail: { kind: 'number', default: 0, min: 0, max: 95, step: 1, label: 'fail %' },
  target: { kind: 'number', default: 0, min: 0, step: 0.5, label: 'target min' },
} satisfies ParamDecls

/**
 * World 1's design table (`docs/games/keyboard/world-1.md`, Kodjo's numbers), as a new World's first rows: the Level
 * is the speed it needs on the default speed curve, rounded up; every run 45 s at the gate, 5 s at best, never failed.
 */
export const DESIGN_STAGES: readonly [level: number, wins: number][] = [
  [0, 1],
  [0, 3],
  [0, 10],
  [3, 20],
  [5, 50],
  [10, 100],
  [13, 150],
  [18, 300],
  [23, 500],
  [30, 1000],
  [30, 2500],
  [30, 10000],
  [45, 25000],
  [50, 50000],
]

export const World = defineComponent({
  type: 'World',
  label: 'World',
  params: {
    baseXp: { kind: 'number', default: 1, min: 0, step: 1, label: 'base XP per step' },
    speedMultiplier: { kind: 'number', default: 1, min: 0, step: 0.01, label: 'speed ×' },
    levelToEnter: { kind: 'number', default: 0, min: 0, step: 1, label: 'Level to enter' },
    targetToEnter: { kind: 'number', default: 0, min: 0, step: 0.5, label: 'target to enter, min' },
    stages: {
      kind: 'list',
      label: 'stages',
      item: STAGE_ROW,
      default: DESIGN_STAGES.map(([level, wins]) => ({ obstacle: null, level, wins, gateSeconds: 45, floorSeconds: 5, fail: 0, target: 0 })),
    },
    pads: { kind: 'list', label: 'step pads', item: { pad: { kind: 'componentRef', of: StepPad.type, label: 'step pad' } }, default: [] },
  },
  singleton: true,
  drives: (p) => [
    ...p.stages.flatMap((row) => (row.obstacle === null ? [] : [{ ref: row.obstacle, type: Obstacle.type, params: { wins: row.wins, requiredLevel: row.level } }])),
    ...p.pads.flatMap((row, tier) => {
      const values = padTier(tier)
      return row.pad === null || values === undefined ? [] : [{ ref: row.pad, type: StepPad.type, params: { perStep: values.perStep, requiresWins: values.requiresWins } }]
    }),
  ],
})

/** The game's tier `tier` (0 the first), read when the game loads. */
const padTier = (tier: number): PadTier | undefined => GAME_PADS[tier]

/** What a world's level says of it: its `World`'s numbers, or World 1's where it has none. */
export interface WorldValues {
  readonly baseXp: number
  readonly speedMultiplier: number
  readonly levelToEnter: number
}

/** The level's `World` — the first, where there are several — and its node. */
export const worldOf = (loaded: Pick<LoadedLevel, 'allNodes'>): { node: WorldNode; values: WorldValues; stages: readonly ComponentRef[] } | null => {
  for (const node of loaded.allNodes) {
    const w = componentOn(node.components, World)
    if (w === undefined) continue
    return {
      node,
      values: { baseXp: w.baseXp, speedMultiplier: w.speedMultiplier, levelToEnter: w.levelToEnter },
      stages: w.stages.flatMap((row) => (row.obstacle === null ? [] : [row.obstacle])),
    }
  }
  return null
}

/** World 1's, for a level without a `World`. */
export const NO_WORLD: WorldValues = { baseXp: 1, speedMultiplier: 1, levelToEnter: 0 }

/**
 * The Obstacles in the order the level's `World` lists them, each once — the stage order and the Checkpoint numbers
 * (ADR 0222). `null` when the level has no `World`, or it lists none that resolve yet: then the Hierarchy's order.
 */
export const stageOrderOf = (loaded: Pick<LoadedLevel, 'allNodes' | 'findNode'>): readonly WorldNode[] | null => {
  const world = worldOf(loaded)
  if (world === null) return null
  const out: WorldNode[] = []
  for (const ref of world.stages) {
    const node = loaded.findNode(world.node, ref.node)
    if (node === undefined || out.includes(node)) continue
    const has = node.components.some((c) => c.type === Obstacle.type && (ref.component === '' || c.id === ref.component))
    if (has) out.push(node)
  }
  return out.length === 0 ? null : out
}

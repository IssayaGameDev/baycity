import { defaultsOf, readParams } from '@mp/components'
import { forEachNode, type Level } from '@mp/content'

import type { SimStage, SimWorld } from './balance'
import { World } from './components/world'

/**
 * What the simulator reads of a world (ADR 0223): its level's `World` — the first one, on any of its own nodes — as
 * the game reads it, its fields over their defaults. A World that lists no pads holds the whole pad table. Its targets
 * (ADR 0225) come with it, in seconds: a stage row's first clear and the world's entry, `null` where it sets none (0).
 */

type WorldParams = ReturnType<typeof readWorld>
const readWorld = (raw: Record<string, unknown>, at: string) => readParams(World.params, raw, at)

/** A world as its `World` says, and the times its designer wants. */
export interface WorldRead {
  readonly world: SimWorld
  readonly enterTargetS: number | null
  /** One per stage row, in order. */
  readonly stageTargetsS: readonly (number | null)[]
}

/** Minutes as a target is typed, as seconds; 0 is none. */
export const targetSeconds = (minutes: number): number | null => (minutes > 0 ? minutes * 60 : null)

const readFrom = (name: string, w: WorldParams, padTable: number): WorldRead => ({
  world: {
    name,
    baseXp: w.baseXp,
    speedMultiplier: w.speedMultiplier,
    levelToEnter: w.levelToEnter,
    padTiers: w.pads.length > 0 ? w.pads.length : padTable,
    stages: w.stages.map(
      (row): SimStage => ({ level: row.level, wins: row.wins, runSeconds: row.gateSeconds, floorSeconds: row.floorSeconds, failChance: row.fail / 100 }),
    ),
  },
  enterTargetS: targetSeconds(w.targetToEnter),
  stageTargetsS: w.stages.map((row) => targetSeconds(row.target)),
})

/** The world a level is, by its `World`, and its targets; `null` when it has none. */
export const worldReadOf = (name: string, level: Level, padTable: number): WorldRead | null => {
  let found: Record<string, unknown> | null = null
  forEachNode(level.nodes, (n) => {
    if (found !== null) return
    const c = n.components.find((x) => x.type === World.type && x.enabled !== false)
    if (c !== undefined) found = c.params
  })
  return found === null ? null : readFrom(name, readWorld(found, name), padTable)
}

/** The world a level is, by its `World`; `null` when it has none. */
export const simWorldOf = (name: string, level: Level, padTable: number): SimWorld | null => worldReadOf(name, level, padTable)?.world ?? null

/** A World as a new one is: the design stages, the whole pad table, no targets — for a game whose levels have none yet. */
export const defaultWorldRead = (padTable: number): WorldRead => readFrom('World 1 (defaults)', readWorld(defaultsOf(World.params), 'defaults'), padTable)
export const defaultSimWorld = (padTable: number): SimWorld => defaultWorldRead(padTable).world

/**
 * One world a Level to enter: two levels opening at the same Level are two copies of one world (a duplicated level),
 * and the first given is kept. What is left out is said, as `<name> opens at Level N, as <kept> does`.
 */
export const distinctWorlds = <T extends { readonly world: Pick<SimWorld, 'name' | 'levelToEnter'> }>(read: readonly T[]): { kept: T[]; skipped: string[] } => {
  const kept: T[] = []
  const skipped: string[] = []
  for (const r of read) {
    const same = kept.find((k) => k.world.levelToEnter === r.world.levelToEnter)
    if (same === undefined) kept.push(r)
    else skipped.push(`${r.world.name} opens at Level ${r.world.levelToEnter}, as ${same.world.name} does`)
  }
  return { kept, skipped }
}

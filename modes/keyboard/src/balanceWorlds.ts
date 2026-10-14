import { defaultsOf, readParams } from '@mp/components'
import { forEachNode, type Level } from '@mp/content'

import type { SimStage, SimWorld } from './balance'
import { World } from './components/world'

/**
 * What the simulator reads of a world (ADR 0223): its level's `World` — the first one, on any of its own nodes — as
 * the game reads it, its fields over their defaults. A World that lists no pads holds the whole pad table.
 */

type WorldParams = ReturnType<typeof readWorld>
const readWorld = (raw: Record<string, unknown>, at: string) => readParams(World.params, raw, at)

const simWorldFrom = (name: string, w: WorldParams, padTable: number): SimWorld => ({
  name,
  baseXp: w.baseXp,
  speedMultiplier: w.speedMultiplier,
  levelToEnter: w.levelToEnter,
  padTiers: w.pads.length > 0 ? w.pads.length : padTable,
  stages: w.stages.map(
    (row): SimStage => ({ level: row.level, wins: row.wins, runSeconds: row.gateSeconds, floorSeconds: row.floorSeconds, failChance: row.fail / 100 }),
  ),
})

/** The world a level is, by its `World`; `null` when it has none. */
export const simWorldOf = (name: string, level: Level, padTable: number): SimWorld | null => {
  let found: Record<string, unknown> | null = null
  forEachNode(level.nodes, (n) => {
    if (found !== null) return
    const c = n.components.find((x) => x.type === World.type && x.enabled !== false)
    if (c !== undefined) found = c.params
  })
  return found === null ? null : simWorldFrom(name, readWorld(found, name), padTable)
}

/** A World as a new one is: the design stages, the whole pad table — for a game whose levels have none yet. */
export const defaultSimWorld = (padTable: number): SimWorld => simWorldFrom('World 1 (defaults)', readWorld(defaultsOf(World.params), 'defaults'), padTable)

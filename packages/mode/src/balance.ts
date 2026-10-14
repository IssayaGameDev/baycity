import type { Level } from '@mp/content'

import type { NumberSetting } from './settings'

/**
 * A game's balance view, the games window's Balance tab (ADR 0225): the game's own simulator over its settings and its
 * levels, each moment it reaches beside the time the designer wants it. The window draws the table and colours it; what
 * a moment is, and how it is simulated, is the game's.
 */

/** A level of the game as the balance reads it: its short name and its file, the open one as it is now. */
export interface BalanceLevel {
  readonly name: string
  readonly level: Level
}

/** One moment: when the designer wants it, and when the simulator reaches it — seconds into the game, `null` for none. */
export interface BalanceMoment {
  readonly label: string
  readonly targetS: number | null
  readonly simulatedS: number | null
}

export interface BalanceGroup {
  readonly title: string
  readonly moments: readonly BalanceMoment[]
}

export interface BalanceReport {
  readonly groups: readonly BalanceGroup[]
  /** What the window says under it: a world left out, a horizon reached. */
  readonly notes: readonly string[]
}

export interface BalanceDecl {
  /** What the window lets the designer set about the imagined player, as number fields; each starts at its default. */
  readonly options: Readonly<Record<string, NumberSetting>>
  /** Simulate over the game's settings (`game.json`'s `settings`, raw) and its levels. Synchronous: it re-runs as you type. */
  readonly report: (input: { settings: unknown; levels: readonly BalanceLevel[]; options: Readonly<Record<string, number>> }) => BalanceReport
}

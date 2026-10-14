import type { Level } from '@mp/content'

import type { CurvePoint } from './curve'
import type { NumberSetting, TableRows } from './settings'

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

/** What a model's rules make (ADR 0226): the settings to write, and the params to set on a component of the open level. */
export interface BalanceApply {
  /** Why nothing can be written, said to the designer; `null` when it can. */
  readonly refused: string | null
  /** Setting key → its new value: a number, a curve's points, a table's rows. */
  readonly settings: Readonly<Record<string, number | CurvePoint[] | TableRows>>
  /** The open level's first enabled component of this type, and the params to set on it. */
  readonly component: { readonly type: string; readonly patch: Readonly<Record<string, unknown>> } | null
  readonly notes: readonly string[]
}

export interface BalanceDecl {
  /** What the window lets the designer set about the imagined player, as number fields; each starts at its default. */
  readonly options: Readonly<Record<string, NumberSetting>>
  /** Simulate over the game's settings (`game.json`'s `settings`, raw) and its levels. Synchronous: it re-runs as you type. */
  readonly report: (input: { settings: unknown; levels: readonly BalanceLevel[]; options: Readonly<Record<string, number>> }) => BalanceReport
  /**
   * The designer's model (ADR 0226): a few rules, saved in `game.json`'s `settings` under their keys like any setting but
   * shown in the Balance tab, and what Apply makes of them. Absent: the tab has no model.
   */
  readonly rules?: Readonly<Record<string, NumberSetting>>
  readonly apply?: (input: {
    settings: unknown
    rules: Readonly<Record<string, number>>
    options: Readonly<Record<string, number>>
    /** The params of the open level's first enabled component of a type; `null` without one. */
    paramsOf: (type: string) => Readonly<Record<string, unknown>> | null
  }) => BalanceApply
}

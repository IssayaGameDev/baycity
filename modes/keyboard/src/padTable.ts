import { readSettings, type TableRows, type TableSetting } from '@mp/mode'

import game from '@content/keyboard/game.json'

/**
 * The step pads' values, every tier in order, for the whole game (ADR 0222, Kodjo's call): one list, and each world's
 * spawn holds the start of it — World 1 the first 8, World 2 the first 16. A world's `World` component lists its pads;
 * a pad's place in that list is its tier, and this table's row of that tier is what it pays and needs.
 *
 * The defaults are the eight the game shipped with (ADR 0082). A game setting, edited in the games window.
 */
export const PAD_SETTINGS = {
  pads: {
    kind: 'table',
    label: 'Step pads',
    hint: 'every tier in order: what a step pays on it, and the Wins it needs; a world lists its pads, a pad’s place is its tier',
    columns: {
      perStep: { label: 'XP per step', default: 1, min: 1, step: 1 },
      requiresWins: { label: 'Wins needed', default: 0, min: 0, step: 1 },
    },
    default: [
      { perStep: 1, requiresWins: 0 },
      { perStep: 2, requiresWins: 3 },
      { perStep: 5, requiresWins: 15 },
      { perStep: 25, requiresWins: 100 },
      { perStep: 50, requiresWins: 500 },
      { perStep: 100, requiresWins: 2500 },
      { perStep: 250, requiresWins: 15000 },
      { perStep: 500, requiresWins: 50000 },
    ],
  },
} satisfies Record<string, TableSetting>

/** One tier: what a step pays on it, and the Wins it needs. */
export interface PadTier {
  readonly perStep: number
  readonly requiresWins: number
}

/** The tiers a game's settings hold, over the defaults. */
export const padTiersFrom = (settings: unknown): readonly PadTier[] =>
  (readSettings(PAD_SETTINGS, settings).pads as TableRows).map((r) => ({ perStep: r.perStep ?? 1, requiresWins: r.requiresWins ?? 0 }))

/** The tiers `content/keyboard/game.json` holds. Read when the game loads, as the curves are (`GAME_CURVE`). */
export const GAME_PADS: readonly PadTier[] = padTiersFrom((game as { settings?: unknown }).settings)

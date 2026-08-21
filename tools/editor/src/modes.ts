import type { Level } from '@mp/content'
import type { ModeDescriptor } from '@mp/mode'

/**
 * The games this build can author (ADR 0052).
 *
 * Collected by **globbing `modes/*​/src/editorMode.ts`**, the same mechanism that already collects levels and
 * assets. Adding a game means adding that one file to the game: nothing here, nothing in `packages/`, nothing
 * anywhere else in the editor. That is dependency law 3 — "needing to modify `packages/` for a mode is a stack
 * gap" — applied to the editor, which used to answer every game question as parkour.
 *
 * The editor depending on every game is deliberate and is the direction that works: a game cannot import a
 * tool without a cycle, and a tool that authors content for N games has to know N of them. It costs a dev
 * build that fails if any game fails to typecheck, which for a dev tool is a feature.
 */
const LOADED = import.meta.glob('../../../modes/*/src/editorMode.ts', { eager: true }) as Record<string, Record<string, unknown>>

/**
 * A directory whose name starts with `_` is not a game.
 *
 * `modes/_template` exists to be copied — it is the acceptance test for `@mp/game-client` (ADR 0056), since
 * if its `main.ts` cannot be three lines the shell is not finished. But it is not something to author for, and
 * without this it would sit in the game picker offering to make levels for a game nobody plays.
 */
const isTemplate = (path: string): boolean => path.includes('/modes/_')

const isDescriptor = (v: unknown): v is ModeDescriptor =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as ModeDescriptor).name === 'string' &&
  typeof (v as ModeDescriptor).registry === 'object' &&
  typeof (v as ModeDescriptor).session === 'function'

/**
 * Every installed game, by `name`.
 *
 * A module may export its descriptor under any name — the check is structural, so a game is free to call it
 * `PARKOUR_MODE` rather than a fixed `default`.
 */
export const MODES: Readonly<Record<string, ModeDescriptor>> = (() => {
  const out: Record<string, ModeDescriptor> = {}
  for (const [path, module] of Object.entries(LOADED)) {
    if (isTemplate(path)) continue
    const found = Object.values(module).filter(isDescriptor)
    if (found.length === 0) console.warn(`${path}: exports no ModeDescriptor`)
    for (const mode of found) {
      if (out[mode.name] !== undefined) console.warn(`${path}: a game called '${mode.name}' is already installed`)
      else out[mode.name] = mode
    }
  }
  return out
})()

/** In label order, for a picker. */
export const MODE_LIST: readonly ModeDescriptor[] = Object.values(MODES).sort((a, b) => a.label.localeCompare(b.label))

/**
 * The game a level belongs to, or `undefined`.
 *
 * Two ways to get nothing, and they are different: the level names no game (unassigned — a fresh file, or one
 * authored before games were explicit), or it names one this build does not have. The caller distinguishes
 * them by reading `config.mode?.name`, because a level whose game is missing must still be *openable* —
 * refusing would make a file unreadable because a sibling app was not installed.
 */
export const modeOf = (level: Level): ModeDescriptor | undefined => {
  const name = level.config.mode?.name
  return name === undefined ? undefined : MODES[name]
}

/**
 * What a new level should be authored for when nothing says otherwise: the only installed game, or none when
 * there is a choice to make. Never a guess between two.
 */
export const soleMode = (): ModeDescriptor | undefined => (MODE_LIST.length === 1 ? MODE_LIST[0] : undefined)

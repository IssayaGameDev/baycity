/**
 * Which level the editor comes back to.
 *
 * Reloading landed you on whichever level happened to be first, so coming back to what you were editing meant
 * finding it in the tree every time. The last one opened is remembered per browser, like the game's own saves
 * (`packages/game-client/src/persistence.ts`), and is best-effort throughout: a read, parse or write failure
 * falls back to the old behaviour rather than throwing, because a private window or full storage must not
 * stop the editor booting.
 *
 * Per browser and not per user on the server: it is a convenience about where *this* window was looking, not
 * a fact about the content, and two people on one box would have to fight over one server-side value.
 */
const KEY = 'editor.lastLevel'

/** The level last opened here, or `null`. Qualified `<game>/<name>` (ADR 0108). */
export const lastLevel = (): string | null => {
  try {
    const raw = localStorage.getItem(KEY)
    return raw === null || raw === '' ? null : raw
  } catch {
    return null
  }
}

export const rememberLevel = (qualified: string): void => {
  try {
    localStorage.setItem(KEY, qualified)
  } catch {
    // ignore — remembering is best-effort
  }
}

/**
 * The level to open at boot: the one you were last on, else the active game's first, else any game's.
 *
 * The remembered name is only a preference — it has to still be in the listing. A level deleted, renamed, or
 * belonging to a game this build no longer installs would otherwise leave the editor booting into a load
 * error every time, and the stale name is the one thing the person cannot see to fix.
 */
export const bootLevel = (
  remembered: string | null,
  entries: readonly { name: string; mode?: string }[],
  activeGame: string | undefined,
): string | undefined => {
  if (remembered !== null && entries.some((e) => e.name === remembered)) return remembered
  const mine = activeGame === undefined ? [] : entries.filter((e) => e.mode === activeGame)
  return (mine[0] ?? entries[0])?.name
}

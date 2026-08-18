import { validateLevel, type Level } from '@mp/content'

/**
 * What this mode can load: **level files**, and nothing else.
 *
 * `content/levels/default.json` is what loads with no `?level=`. It is a file like any other, so the editor
 * opens, edits and saves it — which is the point. It is not *deletable*, because the editor has no delete for
 * levels at all: those routes are read and write only, and deleting exists solely for assets.
 *
 * That is a deliberate reversal. The default started as a hardcoded module so the game could never boot into
 * nothing, which also made the one level a new player sees the one level nobody could edit.
 *
 * Bundled with `import.meta.glob` rather than fetched: the file list needs no server, and a level that fails
 * to parse is a build error instead of a blank screen.
 */
const FILES = import.meta.glob('../../../content/levels/*.json', { eager: true, import: 'default' }) as Record<
  string,
  unknown
>

/** The level loaded when nothing is asked for. */
export const DEFAULT_NAME = 'default'

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1, -'.json'.length)

/** Everything loadable, the default first and the rest sorted. */
export const levelNames = (): string[] => {
  const names = Object.keys(FILES).map(nameOf)
  return [...(names.includes(DEFAULT_NAME) ? [DEFAULT_NAME] : []), ...names.filter((n) => n !== DEFAULT_NAME).sort()]
}

/**
 * The level called `name`, or the default for `null`. Throws for a name that is not there, listing what is —
 * the caller decides whether a typo should be fatal.
 */
export const levelByName = (name: string | null): Level => {
  const wanted = name ?? DEFAULT_NAME
  const found = Object.entries(FILES).find(([path]) => nameOf(path) === wanted)
  if (found === undefined) {
    // The default included: if `default.json` has been deleted from disk there is nothing to fall back to,
    // and saying so beats booting into an empty void with no explanation.
    throw new Error(`no level "${wanted}" — have: ${levelNames().join(', ') || '(none)'}`)
  }
  return validateLevel(found[1])
}

import { validateLevel, type Level } from '@mp/content'

import { showcase } from './showcase'

/**
 * What this mode can load. Two sources, on purpose (ADR 0023):
 *
 * - **The gym** — `showcase.ts`, in code, where obstacles are *generator calls* with their parameters
 *   intact. That is what lets `gym.test.ts` assert every jump against the measured envelope
 *   (`docs/obstacles.md`), so it stays a fixture rather than becoming editable data.
 * - **JSON files** in `content/levels/` — what `tools/editor` writes. Designed content lives here.
 *
 * Bundled with `import.meta.glob` rather than fetched: the file list needs no server, and a level
 * that fails to parse is a build error instead of a blank screen.
 */
const FILES = import.meta.glob('../../../content/levels/*.json', { eager: true, import: 'default' }) as Record<
  string,
  unknown
>

/** The built-in gym's name. Shadows a `gym.json`, should one ever appear. */
export const GYM = 'gym'

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1, -'.json'.length)

/** Everything loadable, the gym first and the files sorted. */
export const levelNames = (): string[] => [GYM, ...Object.keys(FILES).map(nameOf).sort()]

/**
 * The level called `name`, or the gym for `null`. Throws for a name that is not there, listing what
 * is — the caller decides whether a typo should be fatal.
 */
export const levelByName = (name: string | null): Level => {
  if (name === null || name === GYM) return validateLevel(showcase)
  const found = Object.entries(FILES).find(([path]) => nameOf(path) === name)
  if (found === undefined) throw new Error(`no level "${name}" — have: ${levelNames().join(', ')}`)
  return validateLevel(found[1])
}

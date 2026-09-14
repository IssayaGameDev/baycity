import { validateLevel, type Level, type ParamChecker } from '@mp/content'

/**
 * The level files a game can load, bundled at build time.
 *
 * `content/levels/default.json` is what loads with no `?level=`. It is a file like any other, so the editor
 * opens, edits and saves it — which is the point. It is not *deletable*, because the editor has no delete for
 * levels at all: those routes are read and write only, and deleting exists solely for assets.
 *
 * That is a deliberate reversal. The default started as a hardcoded module so the game could never boot into
 * nothing, which also made the one level a new player sees the one level nobody could edit.
 *
 * Bundled with `import.meta.glob` rather than fetched: the file list needs no server, and a level that fails
 * to parse is a build error instead of a blank screen. The glob resolves relative to *this file*, which sits
 * at the same depth in a package as it did in a mode, so moving it here changed nothing about what it finds.
 *
 * **Live in front of the bundle** (ADR 0089): the staging game on the box is a dev server whose level files
 * the hosted editor rewrites every few seconds. Bundled, every write reloaded every player's page. So a page
 * may instead read its level **at boot over HTTP** (`pickLevel` with `fetchLevel`) and the dev server stops
 * watching level files: a page plays the level as it was when it loaded, and the editor's Play frame is fresh
 * on every Play. The bundle stays the fallback and the whole story locally and in a production build.
 */
const ALL = import.meta.glob('@content/levels/*.json', { eager: true, import: 'default' }) as Record<
  string,
  unknown
>

/**
 * The conventional name for a game's starting level, preferred when it exists.
 *
 * Only a preference, because a level's name is its **filename** and `content/levels/` is shared: two games
 * cannot both own `default.json`. So `LevelSource.defaultName` falls back to the game's first level, which
 * is what lets a second game boot with no `?level=` at all.
 */
export const DEFAULT_NAME = 'default'

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1, -'.json'.length)

export interface LevelSource {
  /** Everything loadable, the default first and the rest sorted. */
  names: () => string[]
  /** What loads with no `?level=`: `default` if this game has one, else its first level. */
  defaultName: string
  /** The level called `name`, or the default for `null`. Throws for a name this game does not have. */
  byName: (name: string | null) => Level
  /** A level from elsewhere, checked as a bundled one is: this game's (or unassigned), and valid for the registry. */
  validate: (raw: unknown) => Level
}

/** Where a live copy of a level comes from. `null` = none available; the bundle answers. */
export type LevelFetch = (name: string) => Promise<unknown | null>

/**
 * The editor server's copy: `GET /api/levels/<name>` on the page's own origin. Anything but a JSON 200 —
 * a 404, a login page, no server at all — is `null`, never a throw: the bundle is the answer then.
 */
export const fetchLevel: LevelFetch = async (name) => {
  try {
    const r = await fetch(`/api/levels/${encodeURIComponent(name)}`, { headers: { accept: 'application/json' } })
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null
    return (await r.json()) as unknown
  } catch {
    return null
  }
}

export interface PickedLevel {
  name: string
  level: Level
  from: 'live' | 'bundled'
}

/**
 * The level a page plays: the one asked for by `?level=`, or the default; live when `live` has it and it
 * checks out, else bundled. A name nobody has falls back to the default, and says so in the console — a typo
 * must not brick the page.
 */
export const pickLevel = async (source: LevelSource, requested: string | null, live: LevelFetch | null): Promise<PickedLevel> => {
  const name = requested ?? source.defaultName
  if (live !== null) {
    const raw = await live(name)
    if (raw !== null) {
      try {
        return { name, level: source.validate(raw), from: 'live' }
      } catch (e) {
        console.warn(`live level "${name}" rejected (${String(e)}) — using the bundled copy`)
      }
    }
  }
  try {
    return { name, level: source.byName(name), from: 'bundled' }
  } catch (e) {
    if (requested === null) throw e
    console.error(`${String(e)} — falling back to ${source.defaultName}`)
    return pickLevel(source, null, live)
  }
}

/**
 * The levels belonging to `mode`, validated against `registry`.
 *
 * **Filtered by `config.mode.name`**, because `content/levels/` is shared by every game on the platform.
 * Without it a game offers files built for another, whose components it has never heard of. Unassigned files
 * are included: a level naming no game is one authored before games were explicit, or a fresh one, and
 * refusing it would make a new file unopenable.
 *
 * Validated **with the registry**, so a bad component parameter is a load error rather than a surprise
 * mid-frame.
 */
export const levelsFor = (mode: string, registry: ParamChecker): LevelSource => {
  const ours = (data: unknown): boolean => {
    const named = (data as { config?: { mode?: { name?: unknown } } }).config?.mode?.name
    return named === undefined || named === mode
  }
  const files = Object.entries(ALL).filter(([, data]) => ours(data))

  const names = (): string[] => {
    const all = files.map(([path]) => nameOf(path))
    return [...(all.includes(DEFAULT_NAME) ? [DEFAULT_NAME] : []), ...all.filter((n) => n !== DEFAULT_NAME).sort()]
  }

  const defaultName = names()[0] ?? DEFAULT_NAME

  return {
    names,
    defaultName,
    byName: (name) => {
      const wanted = name ?? defaultName
      const found = files.find(([path]) => nameOf(path) === wanted)
      if (found === undefined) {
        // The default included: if `default.json` has been deleted from disk there is nothing to fall back
        // to, and saying so beats booting into an empty void with no explanation.
        throw new Error(`no ${mode} level "${wanted}" — have: ${names().join(', ') || '(none)'}`)
      }
      return validateLevel(found[1], registry)
    },
    validate: (raw) => {
      if (!ours(raw)) throw new Error(`that level belongs to another game, not ${mode}`)
      return validateLevel(raw, registry)
    },
  }
}

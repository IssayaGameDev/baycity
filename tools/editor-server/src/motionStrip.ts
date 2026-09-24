import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { ASSETS_DIR, GAME_FILE, LEVELS_DIR, LEVEL_SUFFIX } from '../../../packages/content/src/layout'
import type { ComponentData, Level, Node, NodeOverride } from '../../../packages/content/src/types'

/**
 * Taking `Mover` and `Spinner` out of the content (ADR 0137). **Deleted, not converted** — Kodjo's call:
 * nothing made with them needs keeping — and taken out at all because a file naming a component the build no
 * longer has does not load.
 *
 * What goes: every component of the two types, in levels, in prefab files and in a level's resolution table;
 * every record a placement keeps about one of them (its parameters, its switch, its removal, or the component
 * itself when the placement added it); and the two names from each game's shared list (ADR 0077).
 *
 * **Imports nothing that needs `node_modules`**: `strip-motion.sh` runs it from a checkout of `origin/master`
 * that has none, before the code that drops the two is deployed — so the content is clean before anything
 * that cannot read it arrives. Planning is separate from writing, and pure, so the dry run says exactly what
 * the write will do.
 */

export const RETIRED: ReadonlySet<string> = new Set(['Mover', 'Spinner'])

/** What was taken out of one file. */
export interface Stripped {
  components: number
  /** Override entries: a parameter patch, a switch, a removal or an added component. */
  records: number
}

/** A prefab's retired component ids, by the prefab's own node id: what a placement's records name them by. */
export type RetiredIds = ReadonlyMap<string, ReadonlySet<string>>

const isRetired = (c: ComponentData): boolean => RETIRED.has(c.type)

/** The retired component ids of every node in a prefab's tree, by node id. */
export const retiredIdsOf = (root: Node): RetiredIds => {
  const out = new Map<string, Set<string>>()
  const walk = (n: Node): void => {
    const ids = (n.components ?? []).filter(isRetired).map((c) => c.id)
    if (ids.length > 0) out.set(n.id, new Set(ids))
    for (const kid of n.children ?? []) walk(kid)
  }
  walk(root)
  return out
}

/** Drop a record's empty containers, and the record when nothing is left — as `ops.ts` tidies one. */
const tidy = (owner: Node, key: string): void => {
  const map = owner.overrides
  const over = map?.[key]
  if (map === undefined || over === undefined) return
  for (const k of ['params', 'enabled', 'sequences'] as const) if (over[k] !== undefined && Object.keys(over[k]).length === 0) delete over[k]
  for (const k of ['added', 'removed'] as const) if (over[k] !== undefined && over[k].length === 0) delete over[k]
  if (Object.keys(over).length === 0) delete map[key]
  if (Object.keys(map).length === 0) delete owner.overrides
}

/** Take out whatever one placement record says about the components in `ids`. Returns how many entries went. */
const stripRecord = (over: NodeOverride, ids: ReadonlySet<string>): number => {
  let n = 0
  if (over.added !== undefined) {
    const kept = over.added.filter((c) => !isRetired(c))
    n += over.added.length - kept.length
    over.added = kept
  }
  for (const k of ['params', 'enabled', 'sequences'] as const) {
    const sub = over[k]
    if (sub === undefined) continue
    for (const id of Object.keys(sub))
      if (ids.has(id)) {
        delete sub[id]
        n += 1
      }
  }
  if (over.removed !== undefined) {
    const kept = over.removed.filter((id) => !ids.has(id))
    n += over.removed.length - kept.length
    over.removed = kept
  }
  return n
}

/**
 * Strip one node and everything under it, in place: its own components, its children, and — on a placement —
 * the records naming its prefab's retired components (`prefabIds`) or retired components it added, and the
 * nodes it hangs under a piece.
 */
export const stripNode = (n: Node, prefabIds: (assetId: string) => RetiredIds | undefined, count: Stripped): void => {
  const kept = n.components.filter((c) => !isRetired(c))
  count.components += n.components.length - kept.length
  n.components = kept
  if (n.overrides !== undefined) {
    const inPrefab = n.prefab === undefined ? undefined : prefabIds(n.prefab)
    for (const key of Object.keys(n.overrides)) {
      const over = n.overrides[key]!
      const ids = new Set(inPrefab?.get(key) ?? [])
      for (const c of over.added ?? []) if (isRetired(c)) ids.add(c.id)
      count.records += stripRecord(over, ids)
      for (const kid of over.addedChildren ?? []) stripNode(kid, prefabIds, count)
      tidy(n, key)
    }
  }
  for (const kid of n.children ?? []) stripNode(kid, prefabIds, count)
}

/**
 * Strip a level in place: its nodes and its resolution table. A placement's records are read against the
 * table's definition when the level carries one, since that is what it resolves against (ADR 0124), and
 * against the prefab asset otherwise.
 */
export const stripLevel = (level: Level, assetIds: (assetId: string) => RetiredIds | undefined): Stripped => {
  const table = new Map(Object.entries(level.prefabs ?? {}).map(([id, root]) => [id, retiredIdsOf(root)] as const))
  const lookup = (id: string): RetiredIds | undefined => table.get(id) ?? assetIds(id)
  const count: Stripped = { components: 0, records: 0 }
  for (const n of level.nodes) stripNode(n, lookup, count)
  for (const root of Object.values(level.prefabs ?? {})) stripNode(root, lookup, count)
  return count
}

/** A game's shared-component list without the two, or `null` when it names neither. */
export const stripGameList = (components: readonly string[]): string[] | null => {
  const kept = components.filter((c) => !RETIRED.has(c))
  return kept.length === components.length ? null : kept
}

/** How many components of the two types are left anywhere in a parsed file — the read-back check. */
export const retiredLeft = (v: unknown): number => {
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + retiredLeft(x), 0)
  if (v === null || typeof v !== 'object') return 0
  const o = v as Record<string, unknown>
  const own = typeof o.type === 'string' && RETIRED.has(o.type) && typeof o.id === 'string' ? 1 : 0
  return Object.values(o).reduce((n: number, x) => n + retiredLeft(x), own)
}

/** One file the strip changes: where, what it held and what it will hold, and what went. */
export interface StripChange {
  /** Relative to the content directory. */
  file: string
  before: string
  after: string
  stripped: Stripped
  /** For a game file: the list before and after. */
  names?: { from: readonly string[]; to: readonly string[] }
}

/** Two spaces and a trailing newline, as the content API writes a file. */
const serialise = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`

const filesUnder = (dir: string, suffix: string): string[] => {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const full = join(at, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith(suffix)) out.push(full)
    }
  }
  walk(dir)
  return out
}

/**
 * Every file under `contentDir` the strip would change, and how. Reads only.
 *
 * Prefab ids are read from every prefab file **before** anything is stripped — they are what the levels'
 * records name — and prefab files are stripped like any tree. A file that does not parse is named in
 * `unreadable` and left alone.
 */
export const planStrip = (contentDir: string): { changes: StripChange[]; unreadable: string[] } => {
  const changes: StripChange[] = []
  const unreadable: string[] = []
  const read = (full: string): { text: string; json: unknown } | null => {
    try {
      const text = readFileSync(full, 'utf8')
      return { text, json: JSON.parse(text) as unknown }
    } catch {
      unreadable.push(relative(contentDir, full))
      return null
    }
  }

  const prefabs = filesUnder(join(contentDir, ASSETS_DIR), '.prefab.json')
  const idsByAsset = new Map<string, RetiredIds>()
  for (const full of prefabs) {
    const file = read(full)
    if (file === null) continue
    try {
      const id = (JSON.parse(readFileSync(`${full}.meta`, 'utf8')) as { id?: unknown }).id
      if (typeof id === 'string') idsByAsset.set(id, retiredIdsOf(file.json as Node))
    } catch {
      // No sidecar: nothing can reference it by id, so it names nothing a level records.
    }
  }
  const assetIds = (id: string): RetiredIds | undefined => idsByAsset.get(id)

  for (const full of prefabs) {
    const file = read(full)
    if (file === null) continue
    const root = file.json as Node
    const stripped: Stripped = { components: 0, records: 0 }
    stripNode(root, assetIds, stripped)
    const after = serialise(root)
    if (stripped.components + stripped.records > 0) changes.push({ file: relative(contentDir, full), before: file.text, after, stripped })
  }

  const games = existsSync(contentDir)
    ? readdirSync(contentDir)
        .filter((name) => name !== ASSETS_DIR && statSync(join(contentDir, name)).isDirectory())
        .sort()
    : []
  for (const game of games) {
    for (const full of filesUnder(join(contentDir, game, LEVELS_DIR), LEVEL_SUFFIX)) {
      const file = read(full)
      if (file === null) continue
      const level = file.json as Level
      const stripped = stripLevel(level, assetIds)
      if (stripped.components + stripped.records > 0) changes.push({ file: relative(contentDir, full), before: file.text, after: serialise(level), stripped })
    }
    const gameFull = join(contentDir, game, GAME_FILE)
    if (!existsSync(gameFull)) continue
    const file = read(gameFull)
    if (file === null) continue
    const doc = file.json as { components?: string[] }
    const from = doc.components ?? []
    const to = stripGameList(from)
    if (to === null) continue
    doc.components = to
    changes.push({ file: relative(contentDir, gameFull), before: file.text, after: serialise(doc), stripped: { components: 0, records: 0 }, names: { from, to } })
  }
  return { changes, unreadable }
}

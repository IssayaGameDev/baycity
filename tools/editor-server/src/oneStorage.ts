import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { ASSETS_DIR, LEVELS_DIR, LEVEL_SUFFIX } from '../../../packages/content/src/layout'
import { effectiveNode, type TypeInfo } from '../../../packages/content/src/nodes'
import { childListsOf, OVERRIDE_FIELD_NAMES, overrideFieldEmpty } from '../../../packages/content/src/tree'
import type { Level, Node, NodeOverride } from '../../../packages/content/src/types'

/**
 * One storage for what a placement adds (ADR 0151, step 4): what ADR 0130 kept on a placement's own node moves
 * into the record of its prefab's root, where the editor has written it since.
 *
 * - **Children** always: shown after the prefab's either way, so appended to the record's `addedChildren`
 *   they are shown exactly where they were.
 * - **Components** only when the prefab's root has none of the same type. Then the placement's own list and
 *   the record's `added` resolve alike. When it has one, the placement's own may be a singleton replacing it,
 *   which only a component registry knows and this tool has none — so it stays, and is named in the report.
 * - Empty fields a record kept (`addedChildren: []` among them) go, as `ops.ts` tidies them.
 *
 * **Imports nothing that needs `node_modules`**, like `motionStrip.ts`: `migrate-one-storage.sh` runs it from a
 * checkout of `origin/master` that has none. Planning is separate from writing, and pure.
 */

export interface Moved {
  children: number
  components: number
  /** Empty fields tidied out of records. */
  tidied: number
}

export interface Kept {
  /** The placement's id. */
  placement: string
  /** Why it stays: a component sharing a type with the prefab's root, or a prefab that cannot be found. */
  reason: string
}

/** Every component type and child, structurally only: a registry would say singletons, and none is needed to compare trees. */
const ANY_TYPE: TypeInfo = { get: () => undefined }

/** Drop a record's empty fields, and the record, and the map — as `ops.ts`'s `tidyOverride` does. */
const tidy = (owner: Node, count: Moved): void => {
  const map = owner.overrides
  if (map === undefined) return
  for (const key of Object.keys(map)) {
    const over = map[key]!
    for (const field of OVERRIDE_FIELD_NAMES) {
      if (over[field] !== undefined && overrideFieldEmpty(over, field)) {
        delete over[field]
        count.tidied += 1
      }
    }
    if (Object.keys(over).length === 0) delete map[key]
  }
  if (Object.keys(map).length === 0) delete owner.overrides
}

/**
 * Migrate one placement in place. `definition` is its prefab's root, or `undefined` when it cannot be found —
 * then it is left alone, since the record is keyed by that root's id.
 */
const migratePlacement = (p: Node, definition: Node | undefined, count: Moved, kept: Kept[]): void => {
  const legacyKids = p.children ?? []
  const legacyComps = p.components
  if (legacyKids.length === 0 && legacyComps.length === 0) return
  if (definition === undefined) {
    kept.push({ placement: p.id, reason: 'its prefab cannot be found, so its record has no key' })
    return
  }
  const record: NodeOverride = ((p.overrides ??= {})[definition.id] ??= {})
  if (legacyKids.length > 0) {
    record.addedChildren = [...(record.addedChildren ?? []), ...legacyKids]
    count.children += legacyKids.length
    delete p.children
  }
  const rootTypes = new Set(definition.components.map((c) => c.type))
  const moving = legacyComps.filter((c) => !rootTypes.has(c.type))
  const staying = legacyComps.filter((c) => rootTypes.has(c.type))
  if (moving.length > 0) {
    record.added = [...(record.added ?? []), ...moving]
    count.components += moving.length
  }
  p.components = staying
  for (const c of staying) kept.push({ placement: p.id, reason: `its own ${c.type} shares a type with the prefab's root` })
}

/** Migrate a level in place. `definitionOf` resolves a prefab id: the level's own table first, then the asset. */
export const migrateLevel = (level: Level, definitionOf: (assetId: string) => Node | undefined): { moved: Moved; kept: Kept[] } => {
  const moved: Moved = { children: 0, components: 0, tidied: 0 }
  const kept: Kept[] = []
  const resolve = (id: string): Node | undefined => level.prefabs?.[id] ?? definitionOf(id)
  const walk = (n: Node): void => {
    if (n.prefab !== undefined) migratePlacement(n, resolve(n.prefab), moved, kept)
    tidy(n, moved)
    for (const kids of childListsOf(n)) for (const kid of kids) walk(kid)
  }
  for (const n of level.nodes) walk(n)
  return { moved, kept }
}

/**
 * What the level resolves to, as the loader would build it: every node's id, depth and component ids, in
 * order. The read-back check: a migration must leave this exactly as it was.
 */
export const resolvedShape = (level: Level, definitionOf: (assetId: string) => Node | undefined): string[] => {
  const table: Level = { ...level, prefabs: { ...Object.fromEntries(prefabIdsIn(level).map((id) => [id, definitionOf(id)]).filter((e): e is [string, Node] => e[1] !== undefined)), ...(level.prefabs ?? {}) } }
  const out: string[] = []
  const walk = (n: Node, depth: number): void => {
    const r = effectiveNode(table, n, ANY_TYPE)
    out.push(`${depth} ${r.id} [${r.components.map((c) => c.id).join(',')}]`)
    for (const kid of r.children) walk(kid, depth + 1)
  }
  for (const n of level.nodes) walk(n, 0)
  return out
}

const prefabIdsIn = (level: Level): string[] => {
  const ids = new Set<string>()
  const walk = (n: Node): void => {
    if (n.prefab !== undefined) ids.add(n.prefab)
    for (const kids of childListsOf(n)) for (const kid of kids) walk(kid)
  }
  for (const n of level.nodes) walk(n)
  return [...ids]
}

/** One level the migration changes. */
export interface MigrationChange {
  /** Relative to the content directory. */
  file: string
  before: string
  after: string
  moved: Moved
  kept: Kept[]
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

/** Prefab definitions by asset id, off the `.prefab.json` files and their `.meta` sidecars. */
export const prefabsIn = (contentDir: string): Map<string, Node> => {
  const out = new Map<string, Node>()
  for (const full of filesUnder(join(contentDir, ASSETS_DIR), '.prefab.json')) {
    try {
      const id = (JSON.parse(readFileSync(`${full}.meta`, 'utf8')) as { id?: unknown }).id
      if (typeof id === 'string') out.set(id, JSON.parse(readFileSync(full, 'utf8')) as Node)
    } catch {
      // No sidecar, or a file that does not parse: nothing can reference it by id.
    }
  }
  return out
}

export interface MigrationPlan {
  /** Levels with something to move or tidy. */
  changes: MigrationChange[]
  /** Levels with only what stays, for the report. */
  keptOnly: { file: string; kept: Kept[] }[]
  /** Levels that do not parse, left alone. */
  unreadable: string[]
  /** Levels whose resolved tree the migration would change, left alone — which should never happen, and is why it is checked. */
  refused: string[]
}

/** Every level under `contentDir` the migration would change, and how. Reads only. */
export const planMigration = (contentDir: string): MigrationPlan => {
  const prefabs = prefabsIn(contentDir)
  const definitionOf = (id: string): Node | undefined => prefabs.get(id)
  const changes: MigrationChange[] = []
  const keptOnly: { file: string; kept: Kept[] }[] = []
  const unreadable: string[] = []
  const refused: string[] = []
  const games = existsSync(contentDir)
    ? readdirSync(contentDir)
        .filter((name) => name !== ASSETS_DIR && statSync(join(contentDir, name)).isDirectory())
        .sort()
    : []
  for (const game of games) {
    for (const full of filesUnder(join(contentDir, game, LEVELS_DIR), LEVEL_SUFFIX)) {
      const file = relative(contentDir, full)
      let before: string
      let level: Level
      try {
        before = readFileSync(full, 'utf8')
        level = JSON.parse(before) as Level
      } catch {
        unreadable.push(file)
        continue
      }
      const shape = resolvedShape(JSON.parse(before) as Level, definitionOf)
      const { moved, kept } = migrateLevel(level, definitionOf)
      if (moved.children + moved.components + moved.tidied === 0) {
        if (kept.length > 0) keptOnly.push({ file, kept })
        continue
      }
      if (resolvedShape(level, definitionOf).join('\n') !== shape.join('\n')) {
        refused.push(file)
        continue
      }
      changes.push({ file, before, after: serialise(level), moved, kept })
    }
  }
  return { changes, keptOnly, unreadable, refused }
}

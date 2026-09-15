import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import {
  fingerprintMotion,
  firstMotionDifference,
  keysOfWith,
  migrateGameComponents,
  migrateTracksIn,
  newMotionReport,
  overriddenComponentIds,
  type KeysOf,
} from '../../../packages/content/src/migrateMotion'
import type { Keyframe, Level, Node } from '../../../packages/content/src/types'
import { importAssets } from './assetImporter'

/**
 * Turn every `Track` into a `Mover` or a `Spinner` (ADR 0103). Dry by default; `--write` saves.
 *
 *   tsx src/migrateMotion.ts <contentDir> [--write]
 *
 * A file is rewritten only when **every node's motion is unchanged at every sampled instant**
 * (`fingerprintMotion`). Anything else is left exactly as it was and named, and a refusal exits non-zero so
 * `--write` reports a failure rather than a success.
 *
 * The gate is motion rather than geometry, unlike the prefab-reference migration: `fingerprintGeometry`
 * compares component parameters, and the components are the thing being replaced here, so it would refuse
 * everything. What must not change is where each node is over time.
 *
 * Levels and prefab files both carry tracks, and a level may still hold a resolution map, so all three are
 * walked. **`content/games/*.json` too**: a game opts into shared components by name (ADR 0077), and a game
 * still naming `Track` would build a registry with no `Mover` in it and fail to load the level that now has
 * one. An animation clip nothing references afterwards is deleted, because the asset kind goes with the
 * panel.
 *
 * Run with the editor server **stopped** (`deploy/editor/migrate-motion.sh`): an open live level holds its
 * own copy and would write it back over this one.
 */
const [dir, flag] = process.argv.slice(2)
if (dir === undefined) {
  console.error('usage: migrateMotion <contentDir> [--write]')
  process.exit(2)
}
const write = flag === '--write'
const LEVELS = join(dir, 'levels')
const ASSETS = join(dir, 'assets')
const GAMES = join(dir, 'games')

/**
 * No component registry: this tool depends on `@mp/content` alone, and a registry only decides how a
 * placement's own components layer over a prefab's. The same value is used on both sides of every
 * comparison, so it cannot make a difference appear or disappear.
 */
const registry = { get: () => undefined }

const { entries } = importAssets(ASSETS)
const assetPath = (rel: string): string => join(ASSETS, rel)

/** Every animation clip on disk, by asset id — what a `Track` naming a clip resolves through. */
const clips = new Map<string, readonly Keyframe[]>()
for (const e of entries) {
  if (e.kind !== 'animation') continue
  try {
    const doc = JSON.parse(readFileSync(assetPath(e.path), 'utf8')) as { keys?: readonly Keyframe[] }
    clips.set(e.id, doc.keys ?? [])
  } catch {
    console.warn(`  ! ${e.path} did not parse; treated as empty`)
  }
}
const keysOf: KeysOf = keysOfWith((id) => clips.get(id))

const report = newMotionReport()
const rewritten: string[] = []
const identical: string[] = []

/**
 * Migrate one file. `roots` names every tree in it, so a level's own nodes and its resolution map are both
 * covered by one gate over the whole level.
 */
const migrateFile = (file: string, level: Level, roots: Node[]): void => {
  const at = relative(dir, file)
  const original = readFileSync(file, 'utf8')
  const before = fingerprintMotion(level, registry, keysOf)

  let ok = true
  for (const root of roots) {
    if (!migrateTracksIn(root, at, keysOf, report, overriddenComponentIds(root))) ok = false
  }
  if (!ok) return

  const diff = firstMotionDifference(before, fingerprintMotion(level, registry, keysOf))
  if (diff !== null) {
    report.refused.push({ at, why: `motion changed at line ${diff.at}: "${diff.before ?? '(none)'}" became "${diff.after ?? '(none)'}"` })
    return
  }

  const after = `${JSON.stringify(level, null, 2)}\n`
  if (after === original) {
    identical.push(at)
    return
  }
  rewritten.push(at)
  if (write) writeFileSync(file, after)
}

// ---- levels ------------------------------------------------------------------------------------------------
for (const name of readdirSync(LEVELS).filter((f) => f.endsWith('.json')).sort()) {
  const file = join(LEVELS, name)
  const level = JSON.parse(readFileSync(file, 'utf8')) as Level
  migrateFile(file, level, [...level.nodes, ...Object.values(level.prefabs ?? {})])
}

// ---- prefab files ------------------------------------------------------------------------------------------
// A prefab is a bare root node, so it is wrapped as a one-node level for the gate to walk it.
for (const e of entries) {
  if (e.kind !== 'prefab') continue
  const file = assetPath(e.path)
  let root: Node
  try {
    root = JSON.parse(readFileSync(file, 'utf8')) as Node
  } catch {
    report.warnings.push(`${e.path} did not parse; skipped`)
    continue
  }
  const at = relative(dir, file)
  const wrap = (r: Node): Level => ({ id: `prefab:${e.name}`, config: {}, nodes: [r] })
  const original = readFileSync(file, 'utf8')
  const before = fingerprintMotion(wrap(root), registry, keysOf)
  if (!migrateTracksIn(root, at, keysOf, report, overriddenComponentIds(root))) continue
  const diff = firstMotionDifference(before, fingerprintMotion(wrap(root), registry, keysOf))
  if (diff !== null) {
    report.refused.push({ at, why: `motion changed at line ${diff.at}` })
    continue
  }
  const after = `${JSON.stringify(root, null, 2)}\n`
  if (after === original) {
    identical.push(at)
    continue
  }
  rewritten.push(at)
  if (write) writeFileSync(file, after)
}

// ---- games opt into the new names ---------------------------------------------------------------------------
/**
 * Done last, and **only when nothing refused**: a refused level keeps its `Track`, and a game that has
 * stopped naming `Track` could not load it. The two have to move together or not at all.
 */
const regames: { at: string; from: string; to: string }[] = []
if (report.refused.length === 0) {
  for (const name of readdirSync(GAMES).filter((f) => f.endsWith('.json')).sort()) {
    const file = join(GAMES, name)
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { components?: string[] }
    const next = migrateGameComponents(doc.components ?? [])
    if (next === null) continue
    regames.push({ at: relative(dir, file), from: (doc.components ?? []).join(', '), to: next.join(', ') })
    doc.components = next
    if (write) writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`)
  }
}

// ---- clips nobody references any more -----------------------------------------------------------------------
/**
 * Every clip, not just the unreferenced ones: once no `Track` is left, nothing can name a clip, and a
 * converted track carries its keys inline. The `animation` asset kind goes with the panel (ADR 0103).
 *
 * Deleted only when **nothing refused**, because a refused file still holds its `Track` and that track may be
 * the only thing naming a clip. Removing it first would make the refusal unrecoverable.
 */
const deadClips = report.refused.length > 0 ? [] : entries.filter((e) => e.kind === 'animation')
for (const e of deadClips) {
  if (!write) continue
  rmSync(assetPath(e.path), { force: true })
  rmSync(`${assetPath(e.path)}.meta`, { force: true })
}

// ---- report -------------------------------------------------------------------------------------------------
console.log()
console.log(`${report.converted.length} track(s) converted across ${rewritten.length} file(s)${write ? '' : ' (dry run: nothing written)'}`)
for (const c of report.converted) console.log(`  ✓ ${c.at}  node ${c.node} ${c.component} → ${c.to}   ${c.detail}`)
if (report.dropped.length > 0) {
  console.log(`${report.dropped.length} track(s) dropped:`)
  for (const d of report.dropped) console.log(`  – ${d.at}  node ${d.node} ${d.component}: ${d.why}`)
}
if (regames.length > 0) {
  console.log(`${regames.length} game(s) re-opted into the new components:`)
  for (const g of regames) console.log(`  ~ ${g.at}: [${g.from}] → [${g.to}]`)
}
if (identical.length > 0) console.log(`${identical.length} file(s) already had nothing to change`)
if (deadClips.length > 0) {
  console.log(`${deadClips.length} animation clip(s) ${write ? 'deleted' : 'would be deleted'}, since no Track is left to name one:`)
  for (const e of deadClips) console.log(`  – ${e.path}`)
}
for (const w of report.warnings) console.log(`  ! ${w}`)
if (report.refused.length > 0) {
  console.log(`${report.refused.length} refusal(s); those files are LEFT ALONE:`)
  for (const r of report.refused) console.log(`  ! ${r.at}: ${r.why}`)
}
process.exit(report.refused.length > 0 ? 1 : 0)

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { migrateLevelRefs, newRefReport, type PrefabFile } from '../../../packages/content/src/migratePrefabRefs'
import type { Level, Node } from '../../../packages/content/src/types'
import { importAssets } from './assetImporter'

/**
 * Turn every level's own prefab table into references to prefab files (ADR 0091). Dry by default; `--write` saves.
 *
 *   tsx src/migratePrefabRefs.ts <contentDir> [--write]
 *
 * Two passes, because the importer owns asset identity: a table entry no file matches is **written as a new
 * prefab file** first, the importer gives it an id, and only then can a placement reference it. So pass one
 * creates files, pass two relinks. A level is rewritten only when it draws and collides identically
 * afterwards (`fingerprint.ts`); anything else is left alone and named.
 *
 * Run with the editor server **stopped** (`deploy/editor/migrate-prefab-refs.sh`): an open live level holds
 * its own copy and would write it back over this one.
 */
const [dir, flag] = process.argv.slice(2)
if (dir === undefined) {
  console.error('usage: migratePrefabRefs <contentDir> [--write]')
  process.exit(2)
}
const write = flag === '--write'
const LEVELS = join(dir, 'levels')
const ASSETS = join(dir, 'assets')

const levelFiles = (): string[] =>
  readdirSync(LEVELS)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => join(LEVELS, f))

const readLevel = (file: string): Level => JSON.parse(readFileSync(file, 'utf8')) as Level

/** Every prefab asset that exists, by id, with its file name. */
const prefabFiles = (): PrefabFile[] => {
  const { entries } = importAssets(ASSETS)
  const out: PrefabFile[] = []
  for (const e of entries) {
    if (e.kind !== 'prefab') continue
    const path = join(ASSETS, e.path)
    if (!statSync(path).isFile()) continue
    try {
      out.push({ assetId: e.id, name: e.name, root: JSON.parse(readFileSync(path, 'utf8')) as Node })
    } catch {
      console.warn(`  ! ${e.path} did not parse; skipped`)
    }
  }
  return out
}

/** A file name from a table key: the same rule `Save as prefab…` applies, so nothing unwritable is created. */
const fileNameFor = (key: string): string =>
  key
    .trim()
    .replace(/[^\w-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '') || 'prefab'

const report = newRefReport()
/**
 * No component registry here: this package depends on `@mp/content` alone, and a registry only decides how a
 * placement's own components layer over the prefab's. Every placement in this content declares none, and the
 * same value is used on both sides of every comparison, so it cannot make a difference appear or disappear.
 */
const registry = { get: () => undefined }

// ---- pass one: a file for every entry no file matches -----------------------------------------------------
for (const file of levelFiles()) {
  const level = readLevel(file)
  if (level.prefabs === undefined) continue
  migrateLevelRefs(level, relative(dir, file), prefabFiles(), registry, report)
}

const created: { path: string; key: string; level: string }[] = []
const taken = new Set(prefabFiles().map((f) => f.name))
for (const want of report.created) {
  const name = fileNameFor(want.name)
  if (taken.has(name)) {
    // Two levels carrying an entry of the same name that no file matches: one file, and the gate decides
    // whether each level may adopt it.
    continue
  }
  taken.add(name)
  const path = join(ASSETS, 'prefabs', `${name}.prefab.json`)
  created.push({ path, key: want.key, level: want.level })
  if (write) {
    mkdirSync(join(ASSETS, 'prefabs'), { recursive: true })
    // The root's name is the file's, so the two cannot drift the way `AlternatingDanger` and `FastElevator` did.
    writeFileSync(path, `${JSON.stringify({ ...want.root, id: 'root', name }, null, 2)}\n`)
  }
}

if (!write) {
  console.log(`${created.length} prefab file(s) would be created:`)
  for (const c of created) console.log(`  + ${relative(dir, c.path)}   (from ${c.level} "${c.key}")`)
}

// ---- pass two: relink, now that every definition has a file -----------------------------------------------
const pass2 = newRefReport()
const files = prefabFiles()
let touched = 0
for (const file of levelFiles()) {
  const before = readFileSync(file, 'utf8')
  const level = readLevel(file)
  if (level.prefabs === undefined) continue
  const at = relative(dir, file)
  if (!migrateLevelRefs(level, at, files, registry, pass2)) continue
  // References go to disk, never the definitions: the resolution map is dropped.
  delete level.prefabs
  const after = `${JSON.stringify(level, null, 2)}\n`
  if (after === before) continue
  touched++
  if (write) writeFileSync(file, after)
}

console.log()
console.log(`${pass2.linked.length} entr(y|ies) relinked across ${touched} level file(s)${write ? '' : ' (dry run: nothing written)'}`)
for (const l of pass2.linked) console.log(`  ✓ ${l.level} "${l.key}" → ${l.file} (${l.assetId}) by ${l.by}, ${l.placements} placement(s)${l.remapped > 0 ? `, ${l.remapped} override key(s) remapped` : ''}`)
if (pass2.dropped.length > 0) {
  console.log(`${pass2.dropped.length} table entr(y|ies) dropped:`)
  for (const d of pass2.dropped) console.log(`  – ${d.level} "${d.key}": ${d.why}`)
}
if (pass2.created.length > 0) {
  console.log(`${pass2.created.length} still unmatched (a file was created this run; rerun to relink):`)
  for (const c of pass2.created) console.log(`  ? ${c.level} "${c.key}"`)
}
if (pass2.refused.length > 0) {
  console.log(`${pass2.refused.length} level(s) LEFT ALONE because they would not resolve identically:`)
  for (const r of pass2.refused) console.log(`  ! ${r.level}: ${r.why}`)
}
process.exit(pass2.refused.length > 0 ? 1 : 0)

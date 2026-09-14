import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { migrateLevel, migratePrefabTree, newReport } from '../../../packages/content/src/migratePrimitives'
import type { Level, Node } from '../../../packages/content/src/types'

/**
 * Size-into-scale migration over a content folder (ADR 0090). Dry by default; `--write` saves.
 *
 *   tsx src/migratePrimitives.ts <contentDir> [--write]
 *
 * Every level and every `*.prefab.json` is migrated with the rules in `migratePrimitives.ts`; the report
 * names what changed and what was left alone, and why. Run on the box with the editor server **stopped**
 * (`deploy/editor/migrate-primitives.sh`): an open live level would write its own copy over this one.
 */
const [dir, flag] = process.argv.slice(2)
if (dir === undefined) {
  console.error('usage: migratePrimitives <contentDir> [--write]')
  process.exit(2)
}
const write = flag === '--write'

const files = (root: string, pick: (name: string) => boolean): string[] => {
  const out: string[] = []
  const visit = (at: string): void => {
    for (const name of readdirSync(at)) {
      const p = join(at, name)
      if (statSync(p).isDirectory()) visit(p)
      else if (pick(name)) out.push(p)
    }
  }
  visit(root)
  return out.sort()
}

const report = newReport()
let touched = 0
const save = (file: string, data: unknown, before: string): void => {
  const after = `${JSON.stringify(data, null, 2)}\n`
  if (after === before) return
  touched++
  if (write) writeFileSync(file, after)
}

for (const file of files(join(dir, 'levels'), (n) => n.endsWith('.json'))) {
  const before = readFileSync(file, 'utf8')
  const level = JSON.parse(before) as Level
  migrateLevel(level, relative(dir, file), report)
  save(file, level, before)
}
for (const file of files(join(dir, 'assets'), (n) => n.endsWith('.prefab.json'))) {
  const before = readFileSync(file, 'utf8')
  const root = JSON.parse(before) as Node
  migratePrefabTree(root, relative(dir, file), report)
  save(file, root, before)
}

console.log(`${report.changed.length} node(s) moved to a built-in shape in ${touched} file(s)${write ? '' : ' (dry run: nothing written)'}`)
for (const c of report.changed) console.log(`  ✓ ${c}`)
if (report.skipped.length > 0) {
  console.log(`${report.skipped.length} left alone:`)
  for (const s of report.skipped) console.log(`  – ${s.at}: ${s.why}`)
}

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { planMigration, prefabsIn, resolvedShape } from './oneStorage'
import type { Level } from '../../../packages/content/src/types'

/**
 * One storage for what a placement adds (ADR 0151, step 4). Dry by default; `--write` rewrites.
 *
 *   tsx src/migrateOneStorage.ts <contentDir> [--write]
 *
 * Moves what ADR 0130 kept on a placement's own node into its root's record — children always, components when
 * the prefab's root has none of that type — and tidies empty record fields. Each level is checked twice: the
 * plan refuses one whose resolved tree would change, and each rewrite is read back and refused unless it
 * resolves exactly as before, which restores the file and exits non-zero. Idempotent: with nothing left to
 * move it says so and exits 0.
 *
 * Run with the editor server **stopped** (`deploy/editor/migrate-one-storage.sh`): an open live level holds its
 * own copy and would write the old shape straight back.
 */
const [dir, flag] = process.argv.slice(2)
if (dir === undefined) {
  console.error('usage: migrateOneStorage <contentDir> [--write]')
  process.exit(2)
}
const write = flag === '--write'

const { changes, keptOnly, unreadable, refused } = planMigration(dir)
for (const file of unreadable) console.error(`skipped ${file} — does not parse; left alone`)
for (const file of refused) console.error(`refused ${file} — moving would change what it resolves to; left alone`)
const stays = [...changes.map((c) => ({ file: c.file, kept: c.kept })), ...keptOnly].filter((k) => k.kept.length > 0)
for (const { file, kept } of stays) for (const k of kept) console.log(`stays   ${file}  placement ${k.placement}: ${k.reason}`)

const bad = unreadable.length + refused.length > 0 ? 1 : 0
if (changes.length === 0) {
  console.log('nothing left to move: every placement keeps what it adds in its records')
  process.exit(bad)
}

for (const c of changes) {
  const parts = [
    c.moved.children > 0 ? `${c.moved.children} child(ren)` : '',
    c.moved.components > 0 ? `${c.moved.components} component(s)` : '',
    c.moved.tidied > 0 ? `${c.moved.tidied} empty field(s) tidied` : '',
  ].filter((p) => p !== '')
  console.log(`${write ? 'migrate' : 'would  '} ${c.file}  ${parts.join(', ')}`)
}
const children = changes.reduce((n, c) => n + c.moved.children, 0)
const components = changes.reduce((n, c) => n + c.moved.components, 0)
console.log(`\n${children} child(ren) and ${components} component(s) across ${changes.length} level(s)`)

if (!write) {
  console.log('dry run — pass --write to rewrite')
  process.exit(bad)
}

const prefabs = prefabsIn(dir)
const definitionOf = (id: string) => prefabs.get(id)
for (const c of changes) {
  const full = join(dir, c.file)
  writeFileSync(full, c.after)
  let same = false
  try {
    same = resolvedShape(JSON.parse(readFileSync(full, 'utf8')) as Level, definitionOf).join('\n') === resolvedShape(JSON.parse(c.before) as Level, definitionOf).join('\n')
  } catch {
    // `same` stays false: a rewrite that does not parse is refused like one that resolves differently.
  }
  if (!same) {
    writeFileSync(full, c.before)
    console.error(`refused ${c.file} — the rewrite does not resolve as before; restored`)
    process.exit(1)
  }
}
console.log(`wrote ${changes.length} level(s)`)
process.exit(bad)

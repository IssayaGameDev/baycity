import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { planFold } from './meshRenderer'

/**
 * One Mesh Renderer (ADR 0153): every `Mesh` folds into the `Renderer` beside it. Dry by default; `--write`
 * rewrites.
 *
 *   tsx src/migrateMeshRenderer.ts <contentDir> [--write]
 *
 * **All or nothing**: a level's placement records are remapped by its prefabs' folds, so writing some files and
 * not others would leave records naming Meshes that are gone. Anything that cannot fold, or would draw
 * differently, stops the whole write and is named. Every file written is read back and must be what was
 * planned, or every file is put back and it exits non-zero. Idempotent: with nothing left it says so and exits 0.
 *
 * Run with the editor server **stopped** (`deploy/editor/migrate-mesh-renderer.sh`): an open live level holds its
 * own copy and would write the old shape straight back.
 */
const [dir, flag] = process.argv.slice(2)
if (dir === undefined) {
  console.error('usage: migrateMeshRenderer <contentDir> [--write]')
  process.exit(2)
}
const write = flag === '--write'

const { changes, problems, refused, unreadable } = planFold(dir)
for (const file of unreadable) console.error(`skipped ${file} — does not parse; left alone`)
for (const p of problems) console.error(`cannot   ${p}`)
for (const file of refused) console.error(`refused  ${file} — folding would change what it draws`)

if (changes.length === 0 && problems.length === 0 && refused.length === 0) {
  console.log('nothing left to fold: every object draws through its Mesh Renderer')
  process.exit(unreadable.length > 0 ? 1 : 0)
}

for (const c of changes) {
  const parts = [c.count.meshes > 0 ? `${c.count.meshes} Mesh(es)` : '', c.count.records > 0 ? `${c.count.records} placement record(s)` : ''].filter((p) => p !== '')
  console.log(`${write ? 'fold   ' : 'would  '} ${c.file}  ${parts.join(', ')}`)
}
const meshes = changes.reduce((n, c) => n + c.count.meshes, 0)
const records = changes.reduce((n, c) => n + c.count.records, 0)
console.log(`\n${meshes} Mesh(es) and ${records} placement record(s) across ${changes.length} file(s)`)

if (problems.length + refused.length > 0) {
  console.error('\nnothing written: fix what is named above in the editor, then run this again')
  process.exit(1)
}
if (!write) {
  console.log('dry run — pass --write to rewrite')
  process.exit(0)
}

const written: typeof changes = []
const restore = (): void => {
  for (const c of written) writeFileSync(join(dir, c.file), c.before)
}
for (const c of changes) {
  writeFileSync(join(dir, c.file), c.after)
  written.push(c)
  if (readFileSync(join(dir, c.file), 'utf8') !== c.after) {
    restore()
    console.error(`refused ${c.file} — it did not read back as written; every file put back`)
    process.exit(1)
  }
}
// The whole set again, from disk: what was planned is what is there, and nothing is left to fold.
const again = planFold(dir)
if (again.changes.length + again.problems.length + again.refused.length > 0) {
  restore()
  console.error('a second pass still found something to fold; every file put back')
  process.exit(1)
}
console.log(`wrote ${changes.length} file(s)`)

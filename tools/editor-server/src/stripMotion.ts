import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { planStrip, retiredLeft } from './motionStrip'

/**
 * Take every `Mover` and `Spinner` out of the content (ADR 0137). Dry by default; `--write` rewrites.
 *
 *   tsx src/stripMotion.ts <contentDir> [--write]
 *
 * Deleted, not converted: the platforms they moved stand still until a `Sequence` moves them. Each rewrite is
 * read back and refused unless nothing of the two is left and the rest still parses, which restores the file
 * and exits non-zero. Idempotent: with nothing left to strip it says so and exits 0.
 *
 * Run with the editor server **stopped** (`deploy/editor/strip-motion.sh`): an open live level holds its own
 * copy and would write the components straight back.
 */
const [dir, flag] = process.argv.slice(2)
if (dir === undefined) {
  console.error('usage: stripMotion <contentDir> [--write]')
  process.exit(2)
}
const write = flag === '--write'

const { changes, unreadable } = planStrip(dir)
for (const file of unreadable) console.error(`skipped ${file} — does not parse; left alone`)

if (changes.length === 0) {
  console.log('no Mover or Spinner left anywhere')
  process.exit(unreadable.length > 0 ? 1 : 0)
}

for (const c of changes) {
  const what =
    c.names !== undefined
      ? `[${c.names.from.join(', ')}] → [${c.names.to.join(', ')}]`
      : `${c.stripped.components} component(s)${c.stripped.records > 0 ? `, ${c.stripped.records} override entr${c.stripped.records === 1 ? 'y' : 'ies'}` : ''}`
  console.log(`${write ? 'strip  ' : 'would  '} ${c.file}  ${what}`)
}
const total = changes.reduce((n, c) => n + c.stripped.components, 0)
console.log(`\n${total} component(s) across ${changes.length} file(s)`)

if (!write) {
  console.log('dry run — pass --write to rewrite')
  process.exit(unreadable.length > 0 ? 1 : 0)
}

for (const c of changes) {
  const full = join(dir, c.file)
  writeFileSync(full, c.after)
  let left = -1
  try {
    left = retiredLeft(JSON.parse(readFileSync(full, 'utf8')))
  } catch {
    // `left` stays -1: a rewrite that does not parse is refused like one that kept a component.
  }
  if (left !== 0) {
    writeFileSync(full, c.before)
    console.error(`refused ${c.file} — the rewrite ${left < 0 ? 'did not parse' : 'still names Mover or Spinner'}; restored`)
    process.exit(1)
  }
}
console.log(`wrote ${changes.length} file(s)`)

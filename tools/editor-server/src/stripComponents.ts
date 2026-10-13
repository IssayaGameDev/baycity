import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { planStrip, retiredLeft } from './componentStrip'

/**
 * Take every component of the named types out of the content (ADR 0137, ADR 0217). Dry by default; `--write`
 * rewrites.
 *
 *   tsx src/stripComponents.ts <contentDir> <Type[,Type…]> [--write]
 *
 * Deleted, not converted. Each rewrite is read back and refused unless nothing of the types is left and the rest
 * still parses, which restores the file and exits non-zero. Idempotent: with nothing left to strip it says so and
 * exits 0.
 *
 * Run with the editor server **stopped** (`deploy/editor/strip-components.sh`): an open live level holds its own
 * copy and would write the components straight back.
 */
const [dir, list, flag] = process.argv.slice(2)
const types = (list ?? '').split(',').filter((t) => t !== '')
if (dir === undefined || types.length === 0) {
  console.error('usage: stripComponents <contentDir> <Type[,Type…]> [--write]')
  process.exit(2)
}
const write = flag === '--write'
const retired: ReadonlySet<string> = new Set(types)
const named = types.join(', ')

const { changes, unreadable } = planStrip(dir, retired)
for (const file of unreadable) console.error(`skipped ${file} — does not parse; left alone`)

if (changes.length === 0) {
  console.log(`no ${named} left anywhere`)
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
    left = retiredLeft(JSON.parse(readFileSync(full, 'utf8')), retired)
  } catch {
    // `left` stays -1: a rewrite that does not parse is refused like one that kept a component.
  }
  if (left !== 0) {
    writeFileSync(full, c.before)
    console.error(`refused ${c.file} — the rewrite ${left < 0 ? 'did not parse' : `still names ${named}`}; restored`)
    process.exit(1)
  }
}
console.log(`wrote ${changes.length} file(s)`)

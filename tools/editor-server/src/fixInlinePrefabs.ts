import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Level } from '../../../packages/content/src/types'
import { findInlinePrefabs, planInlineCleanup, withoutEntries } from './inlinePrefabs'

/**
 * Relink levels that carry a prefab **definition** instead of a reference (ADR 0124). Dry by default;
 * `--write` rewrites.
 *
 *   tsx src/fixInlinePrefabs.ts <contentDir> [--write]
 *
 * A definition on disk is read *instead of* the asset from then on, so the placement looks linked — badge,
 * overrides, Open — and silently stops following its prefab. ADR 0124 stopped new ones being written; this is
 * for the files that already have one.
 *
 * **Only the `prefabs` table is touched.** No node, no override, no id: the placements already reference the
 * right asset, so dropping the entry is enough to make them resolve against it. An entry with no asset behind
 * it is **kept** and named — there the table genuinely is the only source, and dropping it would turn a
 * placement that draws something into one that draws nothing.
 *
 * A dropped entry that had **drifted** from its asset changes what the level looks like, which is the whole
 * point and also the only visible effect. Those are counted separately, so the dry run says how much will
 * move before anything does.
 *
 * Idempotent: with no level carrying a table there is nothing to do and it exits 0.
 *
 * Run with the editor server **stopped** (`deploy/editor/fix-inline-prefabs.sh`): an open live level holds its
 * own copy and would write the table straight back.
 */
const [dir, flag] = process.argv.slice(2)
if (dir === undefined) {
  console.error('usage: fixInlinePrefabs <contentDir> [--write]')
  process.exit(2)
}
const write = flag === '--write'

const findings = findInlinePrefabs(dir)
const { drop, keep } = planInlineCleanup(findings)

for (const k of keep) console.error(`kept    ${k.file}  ${k.assetId}  — ${k.why}`)
for (const d of drop) console.log(`${write ? 'drop   ' : 'would  '} ${d.file}  ${d.assetId}${d.drifted ? '  (differs from the asset — this level will change)' : ''}`)

if (drop.length === 0) {
  console.log(keep.length > 0 ? 'nothing to drop' : 'every level already references its prefabs')
  process.exit(0)
}

const drifted = drop.filter((d) => d.drifted).length
console.log(`\n${drop.length} entr${drop.length === 1 ? 'y' : 'ies'} across ${new Set(drop.map((d) => d.file)).size} level(s); ${drifted} differ${drifted === 1 ? 's' : ''} from its asset`)

if (!write) {
  console.log('dry run — pass --write to rewrite')
  process.exit(0)
}

const byFile = new Map<string, string[]>()
for (const d of drop) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d.assetId])

for (const [file, ids] of byFile) {
  const full = join(dir, file)
  const before = readFileSync(full, 'utf8')
  const level = JSON.parse(before) as Level
  const after = withoutEntries(level, ids)
  // Two spaces and a trailing newline, as the content API writes a level.
  writeFileSync(full, `${JSON.stringify(after, null, 2)}\n`)
  // Read back and check the only difference is the table: a node rewritten by accident is the one outcome
  // that would cost real work, and it is cheap to rule out.
  const check = JSON.parse(readFileSync(full, 'utf8')) as Level
  const sameBar = (a: Level, b: Level): boolean => {
    const strip = ({ prefabs: _p, ...rest }: Level): unknown => rest
    return JSON.stringify(strip(a)) === JSON.stringify(strip(b))
  }
  if (!sameBar(level, check)) {
    writeFileSync(full, before)
    console.error(`refused ${file} — the rewrite changed more than the table; restored`)
    process.exit(1)
  }
  console.log(`wrote   ${file}  (${ids.length} dropped)`)
}

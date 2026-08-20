/**
 * One-time migration: rewrite `content/**` from pieces and instances to nodes and components
 * (PLAN-component-system, stage C1.4).
 *
 * Run with `pnpm --filter @mp/components exec tsx src/migrate.ts`. It lives in this package rather than in
 * `tools/` so pnpm resolves the workspace imports, and because it dies with the converter it drives. Idempotent by refusal, not by re-conversion: a file
 * that already has `nodes` (or, for a prefab, `components`) is skipped, so running it twice cannot mangle
 * anything.
 *
 * It also writes `packages/components/src/fixtures/legacy-content.json` — every level exactly as it was
 * before this ran. That is what keeps the equivalence test meaningful once the authored files are gone: it
 * loads the fixture through the old loader and the migrated file through the new one and compares the worlds.
 * The fixture goes when the legacy schema does.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateLevel } from '@mp/content'
import { nodeFromLegacyPrefab, nodeLevelFromLegacy } from './legacy'

// Resolved from this file, not from the working directory: it is run through a package filter so that pnpm
// can resolve the workspace imports, which puts the cwd somewhere else entirely.
const at = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))
const LEVELS = at('../../../content/levels')
const PREFABS = at('../../../content/assets/prefabs')
const FIXTURE_DIR = at('./fixtures')

const read = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
/** Two-space JSON with a trailing newline — what the editor's save route already writes. */
const write = (path: string, value: unknown): void => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')

const legacyLevels: Record<string, unknown> = {}
let levels = 0
let prefabs = 0
let skipped = 0

for (const file of readdirSync(LEVELS).filter((f) => f.endsWith('.json'))) {
  const path = join(LEVELS, file)
  const raw = read(path)
  if (Array.isArray(raw.nodes)) {
    skipped++
    continue
  }
  legacyLevels[file] = raw
  write(path, nodeLevelFromLegacy(validateLevel(raw)))
  levels++
  console.log(`level  ${file}`)
}

for (const file of readdirSync(PREFABS).filter((f) => f.endsWith('.prefab.json'))) {
  const path = join(PREFABS, file)
  const raw = read(path)
  if (Array.isArray(raw.components)) {
    skipped++
    continue
  }
  // The file name is the prefab's name; the stored `id` is routinely stale (commit 0fc0b9f).
  const name = file.slice(0, -'.prefab.json'.length)
  write(path, nodeFromLegacyPrefab(name, raw as never))
  prefabs++
  console.log(`prefab ${file}`)
}

if (Object.keys(legacyLevels).length > 0) {
  mkdirSync(FIXTURE_DIR, { recursive: true })
  write(join(FIXTURE_DIR, 'legacy-content.json'), legacyLevels)
  console.log(`fixture ${Object.keys(legacyLevels).length} levels captured for the equivalence test`)
}

console.log(`\n${levels} levels, ${prefabs} prefabs migrated; ${skipped} already migrated`)

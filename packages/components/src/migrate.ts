/**
 * One-time migrations of `content/**`, run in order, each skipping what it has already done.
 *
 * 1. pieces and instances -> nodes and components (PLAN-component-system, stage C1.4)
 * 2. `Visual` -> `Mesh` + `Renderer` (ADR 0039)
 *
 * The second is node-to-node, because by the time it was written the files were already nodes and one of them
 * had been edited in the editor since. Re-running the first from the captured fixture would have thrown that
 * away.
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
import { MESH, RENDERER, type ComponentData, type Node } from '@mp/content'
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
let split = 0

/**
 * `Visual { source, model, material }` becomes `Mesh { model }` (only where one was named) plus
 * `Renderer { material }`.
 *
 * The `source` enum disappears: having a `Mesh` *is* the answer it used to give. A `Visual` that drew its
 * colliders becomes a `Renderer` alone; one that drew a model becomes both, in that order, so a reader sees
 * what before with what.
 */
const splitVisuals = (node: Node): boolean => {
  let changed = false
  const out: ComponentData[] = []
  for (const c of node.components) {
    if (c.type !== 'Visual') {
      out.push(c)
      continue
    }
    changed = true
    const model = typeof c.params.model === 'string' ? c.params.model : ''
    const material = typeof c.params.material === 'string' ? c.params.material : ''
    const wantsModel = c.params.source === 'model' && model !== ''
    // The component's own id goes to the `Renderer`, so any override keyed by it keeps pointing at the
    // material it was always about. A `Mesh` takes a fresh, derived id.
    if (wantsModel) out.push({ id: `${c.id}m`, type: MESH, params: { model }, ...(c.enabled !== undefined ? { enabled: c.enabled } : {}) })
    out.push({ ...c, type: RENDERER, params: { material } })
  }
  if (changed) node.components = out
  for (const kid of node.children ?? []) if (splitVisuals(kid)) changed = true
  return changed
}

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

// --- pass 2: Visual -> Mesh + Renderer -------------------------------------------------------------
for (const file of readdirSync(LEVELS).filter((f) => f.endsWith('.json'))) {
  const path = join(LEVELS, file)
  const raw = read(path) as unknown as { nodes?: Node[]; prefabs?: Record<string, Node> }
  if (!Array.isArray(raw.nodes)) continue
  let changed = false
  for (const root of Object.values(raw.prefabs ?? {})) if (splitVisuals(root)) changed = true
  for (const node of raw.nodes) if (splitVisuals(node)) changed = true
  if (!changed) continue
  write(path, raw)
  split++
  console.log(`split  ${file}`)
}

for (const file of readdirSync(PREFABS).filter((f) => f.endsWith('.prefab.json'))) {
  const path = join(PREFABS, file)
  const raw = read(path) as unknown as Node
  if (!Array.isArray(raw.components)) continue
  if (!splitVisuals(raw)) continue
  write(path, raw)
  split++
  console.log(`split  ${file}`)
}

console.log(`\n${levels} levels, ${prefabs} prefabs migrated; ${skipped} already migrated; ${split} files split into Mesh + Renderer`)

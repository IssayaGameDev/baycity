import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import {
  migrateLevelComponentRefs,
  migratePrefabComponentRefs,
  newComponentRefReport,
  type ComponentRefDeps,
} from '../../../packages/content/src/migrateComponentRefs'
import type { Level, Node } from '../../../packages/content/src/types'

/**
 * Component fields saved as a bare node id become `{ node, component }` (ADR 0177). Dry by default; `--write` saves.
 *
 *   tsx src/migrateComponentRefs.ts <contentDir> [--write]
 *
 * The one field that changed shape is Boss's `zone`: an object field until then, a Collider field now. The editor
 * server has no component registry (ADR 0097), so it is named here. Every `*.level.json` and `*.prefab.json` under
 * the folder; a prefab placed by id is read through its `.meta` sidecar. **All or nothing**: a reference that
 * cannot be resolved is named and nothing is written. Run on the box with the editor server stopped
 * (`deploy/editor/migrate-component-refs.sh`): an open live level would write its own copy over this one.
 */
const [dir, flag] = process.argv.slice(2)
if (dir === undefined) {
  console.error('usage: migrateComponentRefs <contentDir> [--write]')
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

const read = (file: string): { before: string; data: unknown } => {
  const before = readFileSync(file, 'utf8')
  return { before, data: JSON.parse(before) }
}

// Every prefab, by the asset id its sidecar holds: what a placement names.
const prefabFiles = files(dir, (n) => n.endsWith('.prefab.json'))
const prefabs = new Map<string, { file: string; before: string; root: Node }>()
const byId = new Map<string, Node>()
for (const file of prefabFiles) {
  const { before, data } = read(file)
  const root = data as Node
  prefabs.set(file, { file, before, root })
  const meta = `${file}.meta`
  if (!existsSync(meta)) continue
  const id = (JSON.parse(readFileSync(meta, 'utf8')) as { id?: unknown }).id
  if (typeof id === 'string') byId.set(id, root)
}

const deps: ComponentRefDeps = {
  refsOf: (type) => (type === 'Boss' ? [{ key: 'zone', of: 'Collider' }] : []),
  // Levels resolve placements against the prefabs as they were read, before this run touched any of them.
  prefabOf: (id) => byId.get(id),
}

const report = newComponentRefReport()
const pending: { file: string; before: string; data: unknown }[] = []
for (const file of files(dir, (n) => n.endsWith('.level.json'))) {
  const { before, data } = read(file)
  if (migrateLevelComponentRefs(data as Level, relative(dir, file), deps, report)) pending.push({ file, before, data })
}
for (const { file, before, root } of prefabs.values()) {
  if (migratePrefabComponentRefs(root, relative(dir, file), deps, report)) pending.push({ file, before, data: root })
}

console.log(`${report.changed.length} reference(s) in ${pending.length} file(s)${write ? '' : ' (dry run: nothing written)'}`)
for (const c of report.changed) console.log(`  ✓ ${c}`)
if (report.left.length > 0) {
  console.log(`${report.left.length} cannot be resolved — nothing written:`)
  for (const l of report.left) console.log(`  – ${l}`)
  process.exit(1)
}
if (write) for (const p of pending) writeFileSync(p.file, `${JSON.stringify(p.data, null, 2)}\n`)

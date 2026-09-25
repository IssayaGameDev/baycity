import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import type { ComponentData, Level, Node } from '../../../packages/content/src/types'
import { migrateLevel, planMigration, resolvedShape } from './oneStorage'

/**
 * One storage for what a placement adds (ADR 0151, step 4): what ADR 0130 kept on a placement's own node moves
 * into its root's record, and nothing anyone sees changes.
 */

const comp = (id: string, type: string): ComponentData => ({ id, type, params: {} })
const node = (id: string, extra: Partial<Node> = {}): Node => ({ id, transform: { position: { x: 0, y: 0, z: 0 } }, components: [], ...extra })
/** A prefab: a root with a Collider, holding one piece. */
const tower = (): Node => node('root', { components: [comp('rc', 'Collider')], children: [node('top')] })
const level = (nodes: Node[]): Level => ({ id: 'lv', config: {}, nodes })
const TOWER = 't'.repeat(16)
const defs = (id: string): Node | undefined => (id === TOWER ? tower() : undefined)

describe('migrateLevel', () => {
  it('moves a placement’s own children into its root’s record, after what is there, and nothing resolves differently', () => {
    const l = level([node('p', { prefab: TOWER, children: [node('old')], overrides: { root: { addedChildren: [node('new')] } } })])
    const before = resolvedShape(structuredClone(l), defs)
    const { moved, kept } = migrateLevel(l, defs)
    expect(moved.children).toBe(1)
    expect(kept).toEqual([])
    expect(l.nodes[0]!.children).toBeUndefined()
    expect(l.nodes[0]!.overrides!.root!.addedChildren!.map((k) => k.id)).toEqual(['new', 'old'])
    expect(resolvedShape(l, defs)).toEqual(before)
  })

  it('moves a component when the root has none of its type, and leaves one that shares a type', () => {
    const l = level([node('p', { prefab: TOWER, components: [comp('mat', 'MaterialOverride'), comp('col', 'Collider')] })])
    const before = resolvedShape(structuredClone(l), defs)
    const { moved, kept } = migrateLevel(l, defs)
    expect(moved.components).toBe(1)
    expect(l.nodes[0]!.overrides!.root!.added!.map((c) => c.id)).toEqual(['mat'])
    expect(l.nodes[0]!.components.map((c) => c.id), 'it may be a singleton replacing the root’s: left for a person').toEqual(['col'])
    expect(kept).toEqual([{ placement: 'p', reason: "its own Collider shares a type with the prefab's root" }])
    expect(resolvedShape(l, defs)).toEqual(before)
  })

  it('tidies the empty lists a record kept', () => {
    const l = level([node('p', { prefab: TOWER, overrides: { top: { addedChildren: [] }, root: { name: 'T' } } })])
    expect(migrateLevel(l, defs).moved.tidied).toBe(1)
    expect(l.nodes[0]!.overrides).toEqual({ root: { name: 'T' } })
  })

  it('reaches a placement that lives in another placement’s record', () => {
    const inner = node('q', { prefab: TOWER, children: [node('deep')] })
    const l = level([node('p', { prefab: TOWER, overrides: { top: { addedChildren: [inner] } } })])
    expect(migrateLevel(l, defs).moved.children).toBe(1)
    expect(l.nodes[0]!.overrides!.top!.addedChildren![0]!.overrides!.root!.addedChildren!.map((k) => k.id)).toEqual(['deep'])
  })

  it('leaves a placement whose prefab cannot be found, and says why', () => {
    const l = level([node('p', { prefab: 'm'.repeat(16), children: [node('kid')] })])
    const { moved, kept } = migrateLevel(l, defs)
    expect(moved.children).toBe(0)
    expect(l.nodes[0]!.children!.map((k) => k.id)).toEqual(['kid'])
    expect(kept[0]!.placement).toBe('p')
  })

  it('is done after one pass', () => {
    const l = level([node('p', { prefab: TOWER, children: [node('old')], components: [comp('mat', 'MaterialOverride')] })])
    migrateLevel(l, defs)
    expect(migrateLevel(l, defs).moved).toEqual({ children: 0, components: 0, tidied: 0 })
  })
})

describe('planMigration', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true })
    dir = null
  })
  const put = (rel: string, v: unknown): void => {
    const full = join(dir!, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, `${JSON.stringify(v, null, 2)}\n`)
  }

  it('plans the levels that need it, resolving prefabs from their files, and is done after one write', () => {
    dir = mkdtempSync(join(tmpdir(), 'one-storage-'))
    put('assets/prefabs/Tower.prefab.json', tower())
    put('assets/prefabs/Tower.prefab.json.meta', { id: TOWER, kind: 'prefab' })
    put('parkour/levels/a.level.json', level([node('p', { prefab: TOWER, children: [node('old')] })]))
    put('parkour/levels/still.level.json', level([node('s')]))

    const plan = planMigration(dir)
    expect(plan.unreadable).toEqual([])
    expect(plan.refused).toEqual([])
    expect(plan.changes.map((c) => c.file.replaceAll('\\', '/'))).toEqual(['parkour/levels/a.level.json'])
    for (const c of plan.changes) writeFileSync(join(dir, c.file), c.after)
    const written = JSON.parse(readFileSync(join(dir, 'parkour/levels/a.level.json'), 'utf8')) as Level
    expect(written.nodes[0]!.overrides!.root!.addedChildren!.map((k) => k.id)).toEqual(['old'])
    expect(planMigration(dir).changes).toEqual([])
  })
})

/**
 * `migrate-one-storage.sh` runs it from a checkout of `origin/master` with no `node_modules`, so everything it
 * loads must be `node:` or a relative file. Type imports are erased; `verbatimModuleSyntax` keeps the rest.
 */
describe('what it loads', () => {
  it('needs nothing from node_modules', () => {
    const IMPORT = /^\s*(import|export)\s+(type\s+)?[\w\s{},*$]*?\s*from\s+'([^']+)'/gm
    const bare: string[] = []
    const seen = new Set<string>()
    const walk = (file: string): void => {
      if (seen.has(file)) return
      seen.add(file)
      for (const [, , typeOnly, spec] of readFileSync(file, 'utf8').matchAll(IMPORT)) {
        if (typeOnly !== undefined || spec!.startsWith('node:')) continue
        if (spec!.startsWith('.')) walk(resolve(dirname(file), `${spec}.ts`))
        else bare.push(`${file} → ${spec}`)
      }
    }
    walk(resolve(dirname(fileURLToPath(import.meta.url)), 'migrateOneStorage.ts'))
    expect(seen.size, 'the walk reached the logic').toBeGreaterThan(3)
    expect(bare).toEqual([])
  })
})

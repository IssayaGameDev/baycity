import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import type { ComponentData, Level, Node } from '../../../packages/content/src/types'
import { planStrip, retiredIdsOf, retiredLeft, stripGameList, stripLevel, type RetiredIds } from './motionStrip'

/** Taking `Mover` and `Spinner` out of the content (ADR 0137): what goes, what stays, and that it runs bare. */

const ZERO = { x: 0, y: 0, z: 0 }
const mover = (id: string): ComponentData => ({ id, type: 'Mover', params: { move: { x: 0, y: 2, z: 0 }, speed: 1 } })
const spinner = (id: string): ComponentData => ({ id, type: 'Spinner', params: { axis: '+Y', speed: 90 } })
const box = (id: string): ComponentData => ({ id, type: 'Collider', params: { shape: { kind: 'box', halfExtents: { x: 1, y: 1, z: 1 } } } })
const node = (id: string, components: ComponentData[], extra: Partial<Node> = {}): Node => ({ id, transform: { position: ZERO }, components, ...extra })
const level = (nodes: Node[], extra: Partial<Level> = {}): Level => ({ id: 'lv', config: {}, nodes, ...extra })
const none = (): RetiredIds | undefined => undefined

describe('a level', () => {
  it('loses every Mover and Spinner, at any depth, and keeps everything else', () => {
    const lv = level([node('a', [box('c'), mover('m')], { children: [node('b', [spinner('s'), box('d')])] })])
    expect(stripLevel(lv, none)).toEqual({ components: 2, records: 0 })
    expect(lv.nodes[0]!.components.map((c) => c.id)).toEqual(['c'])
    expect(lv.nodes[0]!.children![0]!.components.map((c) => c.id)).toEqual(['d'])
  })

  it('drops what a placement records about its prefab’s Mover, and keeps the rest of the record', () => {
    const prefab = node('root', [box('c'), mover('m')])
    const placed = node('p', [], {
      prefab: 'asset',
      overrides: { root: { params: { m: { speed: 4 }, c: { shape: { kind: 'ball', radius: 2 } } }, enabled: { m: false }, removed: ['m'] } },
    })
    const lv = level([placed])
    expect(stripLevel(lv, (id) => (id === 'asset' ? retiredIdsOf(prefab) : undefined))).toEqual({ components: 0, records: 3 })
    expect(placed.overrides).toEqual({ root: { params: { c: { shape: { kind: 'ball', radius: 2 } } } } })
  })

  it('drops a Mover a placement added, what it patched on it, and a record left empty', () => {
    const placed = node('p', [], { prefab: 'asset', overrides: { root: { added: [spinner('s')], params: { s: { speed: 10 } } } } })
    const lv = level([placed])
    expect(stripLevel(lv, none)).toEqual({ components: 0, records: 2 })
    expect(placed.overrides).toBeUndefined()
  })

  /** Component ids are short and repeat between files: only the prefab piece's own ids count. */
  it('leaves a record about another piece’s component of the same id alone', () => {
    const prefab = node('root', [mover('c0')], { children: [node('kid', [box('c0')])] })
    const placed = node('p', [], { prefab: 'asset', overrides: { kid: { params: { c0: { shape: { kind: 'ball', radius: 1 } } } } } })
    stripLevel(level([placed]), () => retiredIdsOf(prefab))
    expect(placed.overrides?.kid?.params?.c0).toEqual({ shape: { kind: 'ball', radius: 1 } })
  })

  it('reads a placement against the level’s own table before the asset, and strips the table', () => {
    const table = node('root', [mover('m')])
    const placed = node('p', [], { prefab: 'asset', overrides: { root: { enabled: { m: false } } } })
    const lv = level([placed], { prefabs: { asset: table } })
    expect(stripLevel(lv, none)).toEqual({ components: 1, records: 1 })
    expect(lv.prefabs!.asset!.components).toEqual([])
    expect(placed.overrides).toBeUndefined()
  })

  it('strips the nodes a placement hangs under a piece', () => {
    const placed = node('p', [], { prefab: 'asset', overrides: { root: { addedChildren: [node('mine', [mover('m'), box('c')])] } } })
    expect(stripLevel(level([placed]), none).components).toBe(1)
    expect(placed.overrides?.root?.addedChildren?.[0]?.components.map((c) => c.id)).toEqual(['c'])
  })
})

describe('a game’s list', () => {
  it('loses the two names, and says when there was nothing to lose', () => {
    expect(stripGameList(['Checkpoint', 'Mover', 'Spinner', 'Sequence'])).toEqual(['Checkpoint', 'Sequence'])
    expect(stripGameList(['Checkpoint'])).toBeNull()
  })
})

describe('the content folder', () => {
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

  it('plans levels, prefab files and games, leaves the rest alone, and is done after one write', () => {
    dir = mkdtempSync(join(tmpdir(), 'strip-'))
    put('assets/prefabs/Lift.prefab.json', node('root', [box('c'), mover('m')]))
    put('assets/prefabs/Lift.prefab.json.meta', { id: 'lift', kind: 'prefab' })
    put('parkour/game.json', { components: ['Checkpoint', 'Mover', 'Spinner'], settings: {} })
    put('parkour/levels/a.level.json', level([node('p', [], { prefab: 'lift', overrides: { root: { params: { m: { speed: 3 } } } } })]))
    put('parkour/levels/still.level.json', level([node('s', [box('c')])]))

    const { changes, unreadable } = planStrip(dir)
    expect(unreadable).toEqual([])
    expect(changes.map((c) => c.file.replaceAll('\\', '/'))).toEqual(['assets/prefabs/Lift.prefab.json', 'parkour/levels/a.level.json', 'parkour/game.json'])
    expect(changes.find((c) => c.file.endsWith('a.level.json'))!.stripped).toEqual({ components: 0, records: 1 })
    expect(changes.find((c) => c.file.endsWith('game.json'))!.names).toEqual({ from: ['Checkpoint', 'Mover', 'Spinner'], to: ['Checkpoint'] })

    for (const c of changes) writeFileSync(join(dir, c.file), c.after)
    expect(changes.map((c) => retiredLeft(JSON.parse(readFileSync(join(dir!, c.file), 'utf8'))))).toEqual([0, 0, 0])
    expect(planStrip(dir).changes).toEqual([])
  })
})

/**
 * `strip-motion.sh` runs it from a checkout of `origin/master` with no `node_modules`, so everything it loads
 * must be `node:` or a relative file. Type imports are erased; `verbatimModuleSyntax` keeps the rest.
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
    walk(resolve(dirname(fileURLToPath(import.meta.url)), 'stripMotion.ts'))
    expect(seen.size, 'the walk reached the logic').toBeGreaterThan(2)
    expect(bare).toEqual([])
  })
})

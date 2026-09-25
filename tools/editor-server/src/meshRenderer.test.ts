import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { ComponentData, Level, Node } from '@mp/content'
import { drawnLines, foldLevel, planFold } from './meshRenderer'

/**
 * One Mesh Renderer (ADR 0153): every `Mesh` folds into the `Renderer` beside it, placement records follow,
 * and nothing anyone sees changes.
 */

const comp = (id: string, type: string, params: Record<string, unknown> = {}, enabled?: boolean): ComponentData => ({ id, type, params, ...(enabled === undefined ? {} : { enabled }) })
const collider = (id: string): ComponentData => comp(id, 'Collider', { shape: { kind: 'box', halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } })
const node = (id: string, components: ComponentData[], extra: Partial<Node> = {}): Node => ({ id, transform: { position: { x: 0, y: 0, z: 0 } }, components, ...extra })
const level = (nodes: Node[], extra: Partial<Level> = {}): Level => ({ id: 'lv', config: {}, nodes, ...extra })
const nothing = (): undefined => undefined

/** A prefab: a root holding a piece drawn as a sphere, by a Mesh and a Renderer. */
const TOWER = 't'.repeat(16)
const tower = (): Node => node('root', [], { children: [node('top', [collider('tc'), comp('tm', 'Mesh', { model: 'builtin:sphere' }), comp('tr', 'Renderer', { material: 'stone' })])] })

describe('an object’s own Mesh', () => {
  it('folds its model into the Renderer, which keeps its id, and draws the same', () => {
    const l = level([node('a', [collider('c'), comp('m', 'Mesh', { model: 'builtin:box' }), comp('r', 'Renderer', { material: 'red' })])])
    const before = drawnLines(structuredClone(l), nothing)
    expect(foldLevel(l, nothing, 'lv').count.meshes).toBe(1)
    expect(l.nodes[0]!.components).toEqual([collider('c'), comp('r', 'Renderer', { model: 'builtin:box', material: 'red' })])
    expect(drawnLines(l, nothing)).toEqual(before)
  })

  it('becomes a switched-off Renderer holding the model when there was no Renderer, which drew nothing either', () => {
    const l = level([node('a', [collider('c'), comp('m', 'Mesh', { model: 'builtin:box' })])])
    const before = drawnLines(structuredClone(l), nothing)
    foldLevel(l, nothing, 'lv')
    expect(l.nodes[0]!.components[1]).toEqual(comp('m', 'Renderer', { model: 'builtin:box', material: '' }, false))
    expect(drawnLines(l, nothing)).toEqual(before)
  })

  it('tells a different drawing apart, which is what the check stands on', () => {
    const drawn = (model: string, material: string): string[] =>
      drawnLines(level([node('a', [collider('c'), comp('m', 'Mesh', { model: 'builtin:box' }), comp('r', 'Renderer', { model, material })])]), nothing)
    expect(drawn('', 'red'), 'the Mesh’s box, as the Renderer’s own would be').toEqual(drawnLines(level([node('a', [collider('c'), comp('r', 'Renderer', { model: 'builtin:box', material: 'red' })])]), nothing))
    expect(drawn('builtin:sphere', 'red')).not.toEqual(drawn('', 'red'))
    expect(drawn('', 'blue')).not.toEqual(drawn('', 'red'))
  })

  it('refuses a switched-off Mesh that holds a model: folding would draw it or lose it', () => {
    const l = level([node('a', [collider('c'), comp('m', 'Mesh', { model: 'builtin:box' }, false), comp('r', 'Renderer')])])
    expect(foldLevel(l, nothing, 'lv').problems[0]).toMatch(/switched-off Mesh holding 'builtin:box'/)
  })

  it('reaches objects a placement added, and the level’s own copies of prefabs', () => {
    const inner = node('kid', [collider('kc'), comp('km', 'Mesh', { model: 'builtin:capsule' }), comp('kr', 'Renderer')])
    const l = level([node('p', [], { prefab: TOWER, overrides: { root: { addedChildren: [inner] } } })], { prefabs: { [TOWER]: tower() } })
    const before = drawnLines(structuredClone(l), nothing)
    expect(foldLevel(l, nothing, 'lv').count.meshes).toBe(2)
    expect(JSON.stringify(l)).not.toContain('"Mesh"')
    expect(drawnLines(l, nothing)).toEqual(before)
  })
})

describe('what a placement records against a piece’s Mesh', () => {
  /** Fold the prefab the way `planFold` does, then the level against it. */
  const foldBoth = (l: Level): { before: string[]; after: string[] } => {
    const def = tower()
    const before = drawnLines(structuredClone(l), (id) => (id === TOWER ? tower() : undefined))
    const lp = level([def])
    const pieces = { moved: new Map([['top', { mesh: 'tm', renderer: 'tr' }]]), renderer: new Map([['top', 'tr']]) }
    foldLevel(lp, nothing, 'prefab')
    foldLevel(l, (id) => (id === TOWER ? pieces : undefined), 'lv')
    return { before, after: drawnLines(l, (id) => (id === TOWER ? lp.nodes[0] : undefined)) }
  }

  it('moves a changed model onto the piece’s Renderer', () => {
    const l = level([node('p', [], { prefab: TOWER, overrides: { top: { params: { tm: { model: 'builtin:box' }, tr: { material: 'gold' } } } } })])
    const { before, after } = foldBoth(l)
    expect(l.nodes[0]!.overrides).toEqual({ top: { params: { tr: { material: 'gold', model: 'builtin:box' } } } })
    expect(after).toEqual(before)
  })

  it('turns the Mesh switched off or removed there into the model cleared: it drew the colliders', () => {
    for (const record of [{ enabled: { tm: false } }, { removed: ['tm'] }]) {
      const l = level([node('p', [], { prefab: TOWER, overrides: { top: structuredClone(record) } })])
      const { before, after } = foldBoth(l)
      expect(l.nodes[0]!.overrides).toEqual({ top: { params: { tr: { model: '' } } } })
      expect(after).toEqual(before)
    }
  })

  it('folds a Mesh the placement added into the piece’s own Renderer', () => {
    const def = (): Node => node('root', [], { children: [node('top', [collider('tc'), comp('tr', 'Renderer')])] })
    const l = level([node('p', [], { prefab: TOWER, overrides: { top: { added: [comp('am', 'Mesh', { model: 'builtin:box' })] } } })])
    const before = drawnLines(structuredClone(l), (id) => (id === TOWER ? def() : undefined))
    foldLevel(l, () => ({ moved: new Map(), renderer: new Map([['top', 'tr']]) }), 'lv')
    expect(l.nodes[0]!.overrides).toEqual({ top: { params: { tr: { model: 'builtin:box' } } } })
    expect(drawnLines(l, (id) => (id === TOWER ? def() : undefined))).toEqual(before)
  })
})

describe('planFold', () => {
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

  it('folds prefabs and the levels placing them together, and is done after one write', () => {
    dir = mkdtempSync(join(tmpdir(), 'mesh-renderer-'))
    put('assets/prefabs/Tower.prefab.json', tower())
    put('assets/prefabs/Tower.prefab.json.meta', { id: TOWER, kind: 'prefab' })
    put('parkour/levels/a.level.json', level([node('p', [], { prefab: TOWER, overrides: { top: { params: { tm: { model: 'builtin:box' } } } } })]))
    put('parkour/levels/still.level.json', level([node('s', [collider('c'), comp('r', 'Renderer', { model: '', material: '' })])]))

    const plan = planFold(dir)
    expect([plan.problems, plan.refused, plan.unreadable]).toEqual([[], [], []])
    expect(plan.changes.map((c) => c.file.replaceAll('\\', '/'))).toEqual(['assets/prefabs/Tower.prefab.json', 'parkour/levels/a.level.json'])
    for (const c of plan.changes) writeFileSync(join(dir, c.file), c.after)
    const written = JSON.parse(readFileSync(join(dir, 'parkour/levels/a.level.json'), 'utf8')) as Level
    expect(written.nodes[0]!.overrides).toEqual({ top: { params: { tr: { model: 'builtin:box' } } } })
    expect(planFold(dir).changes).toEqual([])
  })

  it('names what cannot fold', () => {
    dir = mkdtempSync(join(tmpdir(), 'mesh-renderer-'))
    put('parkour/levels/a.level.json', level([node('a', [comp('m', 'Mesh', { model: 'builtin:box' }, false), comp('r', 'Renderer')])]))
    expect(planFold(dir).problems).toHaveLength(1)
  })
})

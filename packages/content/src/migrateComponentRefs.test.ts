import { describe, expect, it } from 'vitest'

import { migrateLevelComponentRefs, migratePrefabComponentRefs, newComponentRefReport, type ComponentRefDeps } from './migrateComponentRefs'
import type { ComponentData, Level, Node } from './types'

/**
 * The one-off migration of component fields saved as a bare node id (ADR 0177): each becomes `{ node, component }`,
 * naming the component Boss's old zone read took — the first enabled box Collider — resolved where the runtime
 * resolves it. What cannot be resolved is left and named.
 */

const comp = (id: string, type: string, params: Record<string, unknown> = {}): ComponentData => ({ id, type, params })
const at0 = { position: { x: 0, y: 0, z: 0 } }
const node = (id: string, components: ComponentData[], children: Node[] = []): Node => ({ id, name: id, transform: at0, components, children })
const ball = (id: string): ComponentData => comp(id, 'Collider', { shape: { kind: 'ball', radius: 1 } })
const box = (id: string, enabled = true): ComponentData => ({ ...comp(id, 'Collider', { shape: { kind: 'box', halfExtents: { x: 1, y: 1, z: 1 } } }), ...(enabled ? {} : { enabled: false }) })
const boss = (zone: unknown): ComponentData => comp('bo', 'Boss', { zone, speed: 8 })

/** A Boss prefab: a root, the boss, and its zone — a ball first, then a switched-off box, then the box it reads. */
const BOSS_PREFAB = (): Node => node('root', [], [node('boss', [boss('zone')]), node('zone', [ball('z-ball'), box('z-off', false), box('z-box')])])

const deps = (prefabs: Record<string, Node> = {}): ComponentRefDeps => ({
  refsOf: (type) => (type === 'Boss' ? [{ key: 'zone', of: 'Collider' }] : []),
  prefabOf: (id) => prefabs[id],
})

const zoneOf = (n: Node): unknown => n.components.find((c) => c.type === 'Boss')?.params.zone

describe('migrating component fields saved as a node id', () => {
  it('names the zone’s first enabled box Collider, in a prefab file', () => {
    const root = BOSS_PREFAB()
    const report = newComponentRefReport()
    expect(migratePrefabComponentRefs(root, 'Boss.prefab.json', deps(), report)).toBe(true)
    expect(zoneOf(root.children![0]!)).toEqual({ node: 'zone', component: 'z-box' })
    expect(report.changed).toHaveLength(1)
  })

  it('resolves a level’s own Boss among the level’s own nodes', () => {
    const level: Level = { id: 'l', config: {}, nodes: [node('boss', [boss('lane')]), node('lane', [box('l-box')])] }
    migrateLevelComponentRefs(level, 'keyboard/x', deps(), newComponentRefReport())
    expect(zoneOf(level.nodes[0]!)).toEqual({ node: 'lane', component: 'l-box' })
  })

  it('resolves a placement record’s zone among that placement’s pieces', () => {
    const level: Level = {
      id: 'l',
      config: {},
      nodes: [{ id: 'p', transform: at0, components: [], prefab: 'B', overrides: { boss: { params: { bo: { zone: 'zone' } } } } }],
    }
    migrateLevelComponentRefs(level, 'keyboard/x', deps({ B: BOSS_PREFAB() }), newComponentRefReport())
    expect(level.nodes[0]!.overrides!.boss!.params!.bo!.zone).toEqual({ node: 'zone', component: 'z-box' })
  })

  it('migrates a level’s inline prefab table as a prefab', () => {
    const level: Level = { id: 'l', config: {}, prefabs: { t: BOSS_PREFAB() }, nodes: [] }
    migrateLevelComponentRefs(level, 'keyboard/x', deps(), newComponentRefReport())
    expect(zoneOf(level.prefabs!.t!.children![0]!)).toEqual({ node: 'zone', component: 'z-box' })
  })

  it('leaves and names what it cannot resolve, and leaves what is already migrated', () => {
    const level: Level = {
      id: 'l',
      config: {},
      nodes: [node('a', [boss('nowhere')]), node('b', [boss('bare')]), node('bare', []), node('c', [boss({ node: 'bare', component: 'x' })])],
    }
    const report = newComponentRefReport()
    expect(migrateLevelComponentRefs(level, 'keyboard/x', deps(), report)).toBe(false)
    expect(zoneOf(level.nodes[0]!)).toBe('nowhere')
    expect(report.left).toEqual(["keyboard/x: a.Boss.zone: 'nowhere' is not in reach", "keyboard/x: b.Boss.zone: 'bare' has no Collider"])
    expect(zoneOf(level.nodes[3]!)).toEqual({ node: 'bare', component: 'x' })
  })
})

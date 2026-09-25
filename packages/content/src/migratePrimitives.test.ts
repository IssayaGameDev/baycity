import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { migrateLevel, migrateNode, newReport } from './migratePrimitives'
import { COLLIDER, RENDERER } from './nodes'
import type { Level, Node } from './types'

const platform = (id: string, extra: Partial<Node> = {}): Node => ({
  id,
  transform: { position: vec3(0, 5, 0) },
  components: [
    { id: 'c', type: COLLIDER, params: { shape: { kind: 'box', halfExtents: vec3(3.75, 0.25, 3) }, center: vec3(0, 0.25, 0) } },
    { id: 'r', type: RENDERER, params: { material: 'm' } },
  ],
  ...extra,
})

describe('migrating a piece to a built-in shape', () => {
  it('moves the box size into scale, keeps the centre where it was, and draws the rounded box', () => {
    const n = platform('p', { transform: { position: vec3(0, 5, 0), scale: vec3(3.3, 1, 5) } })
    expect(migrateNode(n)).toBeNull()
    expect(n.transform.scale).toEqual(vec3(24.75, 0.5, 30))
    expect(n.components.map((c) => c.type)).toEqual([COLLIDER, RENDERER])
    expect(n.components[0]!.params.shape).toEqual({ kind: 'box', halfExtents: vec3(0.5, 0.5, 0.5) })
    // 0.25 up, in a box now 0.5 tall: the same 0.25 m once the loader scales it.
    expect(n.components[0]!.params.center).toEqual(vec3(0, 0.5, 0))
    expect(n.components[1]!.params, 'the Mesh Renderer draws it (ADR 0153)').toEqual({ model: 'builtin:rounded-box', material: 'm' })
    expect(migrateNode(n), 'a second run changes nothing').toBeNull()
    expect(n.transform.scale).toEqual(vec3(24.75, 0.5, 30))
  })

  it('a ball becomes a sphere with a uniform scale', () => {
    const n: Node = { id: 'b', transform: { position: vec3(0, 0, 0) }, components: [{ id: 'c', type: COLLIDER, params: { shape: { kind: 'ball', radius: 2 } } }, { id: 'r', type: RENDERER, params: {} }] }
    expect(migrateNode(n)).toBeNull()
    expect(n.transform.scale).toEqual(vec3(4, 4, 4))
    expect(n.components[0]!.params.shape).toEqual({ kind: 'ball', radius: 0.5 })
    expect(n.components[1]!.params.model).toBe('builtin:sphere')
  })

  it('leaves alone what it cannot express, and says why', () => {
    expect(migrateNode(platform('a', { children: [platform('kid')] }))).toBe('has children')
    const two = platform('b')
    two.components.push({ id: 'c2', type: COLLIDER, params: { shape: { kind: 'box', halfExtents: vec3(1, 1, 1) } } })
    expect(migrateNode(two)).toBe('more than one collider')
    const capsule: Node = { id: 'k', transform: { position: vec3(0, 0, 0) }, components: [{ id: 'c', type: COLLIDER, params: { shape: { kind: 'capsule', halfHeight: 1, radius: 0.3 } } }, { id: 'r', type: RENDERER, params: {} }] }
    expect(migrateNode(capsule)).toBe('a capsule collider')
    const empty: Node = { id: 'e', transform: { position: vec3(0, 0, 0) }, components: [] }
    expect(migrateNode(empty), 'nothing to draw: not a candidate').toBeNull()
    expect(empty.components).toEqual([])
  })

  it('a level: own nodes and its prefab table, except prefab nodes a placement overrides', () => {
    const level: Level = {
      id: 'lv',
      config: {},
      prefabs: {
        pad: { id: 'root', transform: { position: vec3(0, 0, 0) }, components: [], children: [platform('slab'), platform('rail')] },
      },
      nodes: [platform('floor'), { id: 'p1', transform: { position: vec3(0, 0, 0) }, components: [], prefab: 'pad', overrides: { rail: { transform: { position: vec3(1, 0, 0) } } } }],
    }
    const report = newReport()
    migrateLevel(level, 'lv', report)
    expect(report.changed).toEqual(['lv/floor', 'lv/prefabs/pad/root/slab'])
    expect(report.skipped).toEqual([{ at: 'lv/prefabs/pad/root/rail', why: 'a placement overrides it' }])
    expect(level.prefabs!.pad!.children![1]!.components.some((c) => c.params.model !== undefined)).toBe(false)
  })
})

import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { COLLIDER, instantiateLevel } from './index'
import { applyOp, invertOp, type Op } from './ops'
import { validateLevel } from './validate'
import type { ComponentData, Level, Node } from './types'

/**
 * A disabled node and everything under it is absent from the level (ADR 0099).
 *
 * The loader is the thing under test, not the editor: the flag is level data, so the game gets it from the
 * same place, and "absent" has to mean no body, no visual and no `baseIndex` rather than merely invisible.
 */

const ZERO = { x: 0, y: 0, z: 0 }
const BOX = { kind: 'box', halfExtents: { x: 1, y: 1, z: 1 } }
const comp = (id: string, type: string, params: Record<string, unknown> = {}): ComponentData => ({ id, type, params })
const solid = (id: string, extra: Partial<Node> = {}): Node => ({
  id,
  transform: { position: ZERO },
  components: [comp(`${id}-c`, COLLIDER, { shape: BOX, center: ZERO })],
  ...extra,
})

const REGISTRY = { get: () => undefined }
const load = (nodes: Node[]) =>
  instantiateLevel(createPhysicsWorld({ gravity: ZERO }), { id: 'fx', config: {}, nodes } as Level, REGISTRY)

describe('a disabled node', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('is not built, and neither is anything under it', () => {
    const on = load([solid('a'), solid('b', { children: [solid('b1')] })])
    expect(on.allNodes.map((n) => n.id)).toEqual(['a', 'b', 'b1'])

    const off = load([solid('a'), solid('b', { enabled: false, children: [solid('b1')] })])
    expect(off.allNodes.map((n) => n.id), 'the subtree goes with it').toEqual(['a'])
    expect(off.nodes.map((n) => n.id), 'and nothing of it is touchable').toEqual(['a'])
  })

  it('leaves no collider behind, so nothing can stand on it', () => {
    const off = load([solid('a', { enabled: false })])
    expect(off.nodes).toEqual([])
    expect(off.visuals).toEqual([])
  })

  it('shifts the base indices after it, which is why every client must read the same file', () => {
    // `baseIndex` is assigned in instance order at load and goes on the wire (ADR 0021). Skipping a node
    // renumbers what follows — safe only because enabled-ness is level data, not a per-client view setting.
    const track = (id: string): Node => ({
      id,
      transform: { position: ZERO },
      components: [comp(`${id}-c`, COLLIDER, { shape: BOX, center: ZERO }), comp(`${id}-t`, 'Wanderer', {})],
    })
    const moved = { get: (t: string) => (t === 'Wanderer' ? { moves: true } : undefined) }
    const world = createPhysicsWorld({ gravity: ZERO })
    const all = instantiateLevel(world, { id: 'fx', config: {}, nodes: [track('x'), track('y')] } as Level, moved)
    const second = all.nodes[1]!
    expect(all.baseIndex(second.colliderHandles[0]!)).toBe(1)

    const world2 = createPhysicsWorld({ gravity: ZERO })
    const skipped = instantiateLevel(world2, { id: 'fx', config: {}, nodes: [{ ...track('x'), enabled: false }, track('y')] } as Level, moved)
    expect(skipped.baseIndex(skipped.nodes[0]!.colliderHandles[0]!), 'y is now the first base').toBe(0)
  })

  it('is enabled when the flag is absent, so no existing level changes', () => {
    expect(load([solid('a')]).allNodes).toHaveLength(1)
    expect(load([solid('a', { enabled: true })]).allNodes, 'and true is the same as absent').toHaveLength(1)
  })

  it('is accepted by the validator, and only as a boolean', () => {
    expect(() => validateLevel({ id: 'fx', config: {}, nodes: [solid('a', { enabled: false })] })).not.toThrow()
    expect(() => validateLevel({ id: 'fx', config: {}, nodes: [{ ...solid('a'), enabled: 'no' }] })).toThrow(/enabled/)
  })
})

describe('switching a node off as an op', () => {
  const level = (): Level => ({ id: 'fx', config: {}, nodes: [solid('a')] })

  it('writes the absence of the field when on, so there is one shape on disk', () => {
    const lv = level()
    applyOp(lv, { kind: 'setNodeEnabled', id: 'a', enabled: false })
    expect(lv.nodes[0]!.enabled).toBe(false)
    applyOp(lv, { kind: 'setNodeEnabled', id: 'a', enabled: true })
    expect(lv.nodes[0]!.enabled, 'absent, not true').toBeUndefined()
  })

  it('inverts, and reports nothing when it would change nothing', () => {
    const lv = level()
    const undo = invertOp(lv, { kind: 'setNodeEnabled', id: 'a', enabled: false })
    expect(undo).toEqual({ kind: 'setNodeEnabled', id: 'a', enabled: true })
    applyOp(lv, { kind: 'setNodeEnabled', id: 'a', enabled: false })
    expect(invertOp(lv, { kind: 'setNodeEnabled', id: 'a', enabled: false }), 'already off').toBeNull()
  })

  it('records an inherited node against the placement, so one placement can differ', () => {
    const lv: Level = {
      id: 'fx',
      config: {},
      prefabs: { P: { id: 'root', transform: { position: ZERO }, components: [], children: [solid('spikes')] } },
      nodes: [
        { id: 'p1', transform: { position: ZERO }, components: [], prefab: 'P' },
        { id: 'p2', transform: { position: ZERO }, components: [], prefab: 'P' },
      ],
    }
    const op: Op = { kind: 'setOverrideNodeEnabled', owner: 'p1', node: 'spikes', enabled: false }
    expect(invertOp(lv, op)).toEqual({ kind: 'setOverrideNodeEnabled', owner: 'p1', node: 'spikes', enabled: null })
    applyOp(lv, op)
    expect(lv.nodes[0]!.overrides?.spikes?.nodeEnabled).toBe(false)
    expect(lv.nodes[1]!.overrides, 'the other placement keeps its spikes').toBeUndefined()
    expect(lv.prefabs!.P!.children![0]!.enabled, 'and the prefab is untouched').toBeUndefined()
  })

  it('clears an override back to whatever the prefab says', () => {
    const lv: Level = {
      id: 'fx',
      config: {},
      prefabs: { P: { id: 'root', transform: { position: ZERO }, components: [], children: [solid('spikes')] } },
      nodes: [{ id: 'p1', transform: { position: ZERO }, components: [], prefab: 'P', overrides: { spikes: { nodeEnabled: false } } }],
    }
    applyOp(lv, { kind: 'setOverrideNodeEnabled', owner: 'p1', node: 'spikes', enabled: null })
    expect(lv.nodes[0]!.overrides?.spikes?.nodeEnabled).toBeUndefined()
  })
})

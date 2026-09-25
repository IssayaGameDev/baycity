import { SEQUENCE, type NodeRef, type Op } from '@mp/content'
import { describe, expect, it } from 'vitest'

import { repaintFor, type Repaint } from './remoteRepaint'

/**
 * What an edit made elsewhere needs redrawn (ADR 0167): its objects' subtrees for most, everything for what
 * reshapes the tree or reaches every placement, the environment for the sky — and everything for an op it does
 * not know, so nothing is ever drawn stale.
 */

const T = { position: { x: 0, y: 0, z: 0 } }
const component = (id: string, type: string) => ({ id, type, params: {} })
/** What the document has now: `seq` on `a` is a sequence, `col` a collider; anything else is gone. */
const typeOf = (_ref: NodeRef, componentId: string): string | undefined => ({ seq: SEQUENCE, col: 'Collider' })[componentId]
const plan = (...ops: Op[]): Repaint => repaintFor(ops, typeOf)
const nodes = (p: Repaint): string[] => p.nodes.map((r) => ('id' in r ? r.id : `${r.owner}>${r.node}`))

describe('what an edit from elsewhere redraws', () => {
  it('rebuilds just the objects a change is about, and each of them once per op', () => {
    const p = plan(
      { kind: 'setParams', id: 'a', componentId: 'col', patch: { center: { x: 1, y: 0, z: 0 } } },
      { kind: 'setComponentEnabled', id: 'b', componentId: 'col', enabled: false },
      { kind: 'setNodeEnabled', id: 'c', enabled: false },
      { kind: 'addComponent', id: 'd', component: component('new', 'Hazard') },
      { kind: 'moveComponent', id: 'e', componentId: 'col', to: 0 },
      { kind: 'setOverrideParams', owner: 'p', node: 'k', componentId: 'col', patch: {} },
      { kind: 'setOverrideNodeEnabled', owner: 'p', node: 'k2', enabled: false },
      { kind: 'addOverrideComponent', owner: 'p', node: 'k3', component: component('x', 'Bumper') },
    )
    expect(p.all).toBe(false)
    expect(nodes(p)).toEqual(['a', 'b', 'c', 'd', 'e', 'p>k', 'p>k2', 'p>k3'])
    expect(p.environment).toBe(false)
  })

  it('redraws nothing in the viewport for a name', () => {
    expect(plan({ kind: 'setName', id: 'a', name: 'x' }, { kind: 'setOverrideName', owner: 'p', node: 'k', name: 'y' })).toEqual({ all: false, nodes: [], environment: false })
  })

  it('takes a transform among other ops as its subtree, a scale changing the meshes', () => {
    expect(nodes(plan({ kind: 'setTransform', id: 'a', transform: T }, { kind: 'setName', id: 'b', name: 'n' }))).toEqual(['a'])
  })

  it('redraws everything for what renumbers the objects or reaches every placement', () => {
    const everything: Op[] = [
      { kind: 'insertNode', parent: null, index: 0, node: { id: 'n', transform: T, components: [] } },
      { kind: 'removeNode', id: 'a' },
      { kind: 'moveNode', id: 'a', parent: null, index: 1 },
      { kind: 'replaceNode', id: 'a', node: { id: 'a', transform: T, components: [] } },
      { kind: 'internPrefab', key: 'k', root: { id: 'r', transform: T, components: [] } },
      { kind: 'dropPrefab', key: 'k' },
      { kind: 'setMode', mode: null },
      { kind: 'setNetBounds', netBounds: 100 },
      { kind: 'setNodeOverride', owner: 'p', node: 'k', override: null },
      { kind: 'setOverrideNodeRemoved', owner: 'p', node: 'k', removed: true },
      { kind: 'setOverrideChildOrder', owner: 'p', node: 'k', order: null },
      { kind: 'setOverrideSequence', owner: 'p', node: 'k', componentId: 'seq', override: null },
      // A prefab's definition, edited in the level's table: every placement of it.
      { kind: 'setParams', id: 'a', componentId: 'col', patch: {}, table: 'k' },
    ]
    for (const op of everything) expect(plan(op).all, op.kind).toBe(true)
  })

  it('redraws everything for a sequence, which may fade other objects, and for a component that is gone', () => {
    expect(plan({ kind: 'setParams', id: 'a', componentId: 'seq', patch: {} }).all).toBe(true)
    expect(plan({ kind: 'addComponent', id: 'a', component: component('s', SEQUENCE) }).all).toBe(true)
    expect(plan({ kind: 'removeComponent', id: 'a', componentId: 'col-gone' }).all).toBe(true)
  })

  it('re-bakes the sky only for the environment', () => {
    expect(plan({ kind: 'setEnvironment', environment: null })).toEqual({ all: false, nodes: [], environment: true })
    expect(plan({ kind: 'setCameraSeeThrough', seeThrough: true }).environment).toBe(true)
    expect(plan({ kind: 'setParams', id: 'a', componentId: 'col', patch: {} }).environment).toBe(false)
  })

  it('redraws everything for an op it does not know', () => {
    expect(plan({ kind: 'somethingNew', id: 'a' } as unknown as Op).all).toBe(true)
  })
})

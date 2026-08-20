import { vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { instantiateNodeLevel } from './nodeLoader'
import { effectiveNode, COLLIDER, MATERIAL_OVERRIDE, SPAWN, TRACK, VISUAL, type TypeInfo } from './nodes'
import { moveTrack } from './track'
import type { ComponentData, Node, NodeLevel } from './types'

/**
 * The node loader's own behaviour — what a `Piece` could not express.
 *
 * The migration is proved elsewhere (`@mp/components`' equivalence pass loads every authored level both
 * ways). This covers the capabilities that are new: several colliders on one node, a collider offset, a node
 * that draws nothing, a material that cascades, a component switched off, and override resolution.
 */

/** Only `singleton` matters to resolution, so the real registry is not needed here. */
const TYPES: TypeInfo = {
  get: (type) => (type === COLLIDER ? {} : { singleton: true }),
}

const comp = (id: string, type: string, params: Record<string, unknown> = {}): ComponentData => ({ id, type, params })

const box = (half = 0.5): ComponentData['params'] => ({ shape: { kind: 'box', halfExtents: vec3(half, half, half) } })

const levelOf = (nodes: Node[], prefabs?: Record<string, Node>): NodeLevel => ({
  id: 'fx',
  config: { fallBehavior: 'physical-fall', fallY: -999 },
  ...(prefabs !== undefined ? { prefabs } : {}),
  nodes,
})

const load = (level: NodeLevel): ReturnType<typeof instantiateNodeLevel> =>
  instantiateNodeLevel(createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } }), level, TYPES)

describe('a node with more than one collider', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('builds a body and a mesh for each, and offsets them by their centres', () => {
    const loaded = load(
      levelOf([
        {
          id: 'n0',
          transform: { position: vec3(0, 1, 0) },
          components: [
            comp('c0', COLLIDER, { ...box(), center: vec3(-2, 0, 0) }),
            comp('c1', COLLIDER, { ...box(), center: vec3(2, 0, 0) }),
            comp('c2', VISUAL, { source: 'collider', model: '', material: '' }),
          ],
        },
      ]),
    )
    expect(loaded.visuals.map((v) => v.position)).toEqual([vec3(-2, 1, 0), vec3(2, 1, 0)])
  })

  it('reports one node for both colliders, so a rule on it covers either one', () => {
    const loaded = load(
      levelOf([
        {
          id: 'n0',
          transform: { position: vec3(0, 0, 0) },
          components: [comp('c0', COLLIDER, box()), comp('c1', COLLIDER, { ...box(), center: vec3(3, 0, 0) })],
        },
      ]),
    )
    expect(loaded.nodes).toHaveLength(1)
    expect(loaded.nodes[0]?.id).toBe('n0')
  })

  // A rotated node turns its colliders' offsets with it, or two colliders would swap sides.
  it('rotates an offset with the node', () => {
    const loaded = load(
      levelOf([
        {
          id: 'n0',
          transform: { position: vec3(0, 0, 0), rotation: vec3(0, Math.PI / 2, 0) },
          components: [comp('c0', COLLIDER, { ...box(), center: vec3(2, 0, 0) }), comp('c1', VISUAL, { source: 'collider', model: '', material: '' })],
        },
      ]),
    )
    const p = loaded.visuals[0]!.position
    expect(p.x).toBeCloseTo(0, 9)
    expect(p.z).toBeCloseTo(-2, 9)
  })
})

describe('a node draws only what it says it draws', () => {
  it('draws nothing without a Visual, the way a GameObject with no renderer is invisible', () => {
    const loaded = load(levelOf([{ id: 'n0', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', COLLIDER, box())] }]))
    expect(loaded.visuals).toEqual([])
    expect(loaded.nodes, 'still solid, and still something a rule can sit on').toHaveLength(1)
  })

  it('draws a model without colliding, which no Piece could do', () => {
    const loaded = load(
      levelOf([{ id: 'n0', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', VISUAL, { source: 'model', model: 'mesh1', material: '' })] }]),
    )
    expect(loaded.visuals).toHaveLength(1)
    expect(loaded.nodes, 'nothing to touch').toEqual([])
  })

  // `source: 'collider'` with no collider has nothing to draw. Inventing a box for it would put geometry in
  // the world that no data asked for.
  it('draws nothing for a collider-source Visual with no collider', () => {
    const loaded = load(
      levelOf([{ id: 'n0', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', VISUAL, { source: 'collider', model: '', material: 'mat' })] }]),
    )
    expect(loaded.visuals).toEqual([])
  })

  it('ignores a component that is switched off', () => {
    const loaded = load(
      levelOf([
        {
          id: 'n0',
          transform: { position: vec3(0, 0, 0) },
          components: [{ ...comp('c0', COLLIDER, box()), enabled: false }, comp('c1', VISUAL, { source: 'collider', model: '', material: '' })],
        },
      ]),
    )
    expect(loaded.nodes, 'no body, so nothing can touch it').toEqual([])
    expect(loaded.visuals, 'and the Visual has no collider left to draw').toEqual([])
  })
})

describe('a material that cascades', () => {
  const tree = (): Node[] => [
    {
      id: 'root',
      transform: { position: vec3(0, 0, 0) },
      components: [comp('c0', MATERIAL_OVERRIDE, { material: 'gold' })],
      children: [
        {
          id: 'kid',
          transform: { position: vec3(1, 0, 0) },
          components: [comp('c0', COLLIDER, box()), comp('c1', VISUAL, { source: 'collider', model: '', material: 'plain' })],
        },
      ],
    },
  ]

  /**
   * `PrefabInstance.material` stopped at the instance's own pieces. There is no longer a distinction between
   * a node's pieces and its children to stop at, so it reaches the whole subtree.
   */
  it('beats a descendant’s own material', () => {
    expect(load(levelOf(tree())).visuals[0]?.material).toBe('gold')
  })

  it('is itself beaten by a closer one', () => {
    const nodes = tree()
    nodes[0]!.children![0]!.components.push(comp('c2', MATERIAL_OVERRIDE, { material: 'ice' }))
    expect(load(levelOf(nodes)).visuals[0]?.material).toBe('ice')
  })

  it('greyboxes a subtree when it says nothing, which is an opinion and not an absence', () => {
    const nodes = tree()
    nodes[0]!.components = [comp('c0', MATERIAL_OVERRIDE, { material: '' })]
    expect(load(levelOf(nodes)).visuals[0]?.material).toBeUndefined()
  })
})

describe('spawn', () => {
  it('comes from the component, composed through its parents', () => {
    const loaded = load(
      levelOf([
        {
          id: 'root',
          transform: { position: vec3(5, 0, 0) },
          components: [],
          children: [{ id: 'sp', transform: { position: vec3(0, 2, 0) }, components: [comp('c0', SPAWN)] }],
        },
      ]),
    )
    expect(loaded.markers).toEqual([{ kind: 'spawn', position: vec3(5, 2, 0) }])
  })
})

describe('resolving a placement against its prefab', () => {
  const prefab: Node = {
    id: 'root',
    name: 'pad',
    transform: { position: vec3(0, 0, 0) },
    components: [comp('rc0', TRACK, { keys: moveTrack(vec3(0, 0, 0), vec3(0, 1, 0), 2, 1000), loop: 'loop', phaseMs: 0 })],
    children: [
      {
        id: 'p0',
        transform: { position: vec3(0, 0, 0) },
        components: [comp('c0', COLLIDER, box()), comp('c1', VISUAL, { source: 'collider', model: '', material: 'plain' })],
      },
    ],
  }

  const placed = (node: Partial<Node>): NodeLevel =>
    levelOf([{ id: 'n0', transform: { position: vec3(0, 0, 0) }, components: [], prefab: 'pad', ...node }], { pad: prefab })

  it('takes the prefab’s components and children, wearing the placement’s transform', () => {
    const level = placed({ transform: { position: vec3(7, 0, 0) } })
    const r = effectiveNode(level, level.nodes[0]!, TYPES)
    expect(r.transform.position).toEqual(vec3(7, 0, 0))
    expect(r.components.map((c) => c.type)).toEqual([TRACK])
    expect(r.children.map((c) => c.id)).toEqual(['p0'])
  })

  it('patches a descendant’s parameters without touching the prefab', () => {
    const level = placed({ overrides: { p0: { params: { c1: { material: 'gold' } } } } })
    expect(load(level).visuals[0]?.material).toBe('gold')
    expect(prefab.children![0]!.components[1]!.params.material, 'the definition is untouched').toBe('plain')
  })

  it('removes an inherited component on one placement only', () => {
    const level = placed({ overrides: { p0: { removed: ['c1'] } } })
    expect(load(level).visuals, 'nothing left to draw it').toEqual([])
    expect(load(placed({})).visuals, 'and the plain placement still draws').toHaveLength(1)
  })

  it('adds a component to one placement only', () => {
    const level = placed({ overrides: { p0: { added: [comp('a0', COLLIDER, { ...box(), center: vec3(4, 0, 0) })] } } })
    expect(load(level).visuals.map((v) => v.position.x)).toEqual([0, 4])
  })

  it('switches an inherited component off on one placement only', () => {
    const level = placed({ overrides: { p0: { enabled: { c0: false } } } })
    expect(load(level).nodes, 'no collider, so nothing to stand on').toEqual([])
  })

  it('lets the placement’s own singleton beat the prefab’s', () => {
    const level = placed({ components: [comp('o0', TRACK, { keys: [], loop: 'loop', phaseMs: 0 })] })
    const r = effectiveNode(level, level.nodes[0]!, TYPES)
    expect(r.components).toHaveLength(1)
    expect(r.components[0]?.id, 'the placement’s, not the prefab’s').toBe('o0')
  })

  it('appends a repeatable one instead of replacing', () => {
    const level = levelOf(
      [
        {
          id: 'n0',
          transform: { position: vec3(0, 0, 0) },
          components: [comp('o0', COLLIDER, { ...box(), center: vec3(9, 0, 0) })],
          prefab: 'solid',
        },
      ],
      { solid: { id: 'root', transform: { position: vec3(0, 0, 0) }, components: [comp('rc0', COLLIDER, box())] } },
    )
    const r = effectiveNode(level, level.nodes[0]!, TYPES)
    expect(r.components.map((c) => c.id)).toEqual(['rc0', 'o0'])
  })

  it('keeps the placement’s own children after the inherited ones', () => {
    const level = placed({
      children: [{ id: 'mine', transform: { position: vec3(0, 3, 0) }, components: [comp('c0', COLLIDER, box())] }],
    })
    const r = effectiveNode(level, level.nodes[0]!, TYPES)
    expect(r.children.map((c) => c.id)).toEqual(['p0', 'mine'])
  })

  // A prefab that lost a node must not break every placement that had touched it.
  it('ignores an override for a node the prefab no longer has', () => {
    const level = placed({ overrides: { gone: { name: 'nobody' } } })
    expect(() => load(level)).not.toThrow()
  })

  it('carries the prefab’s motion, so a placement’s children ride it', () => {
    const level = placed({
      children: [
        {
          id: 'mine',
          transform: { position: vec3(0, 1, 0) },
          components: [comp('c0', COLLIDER, box()), comp('c1', VISUAL, { source: 'collider', model: '', material: '' })],
        },
      ],
    })
    const loaded = load(level)
    loaded.update(500)
    // Two visuals: the prefab's own piece at the root's pose, then the placement's child one metre above it.
    expect(loaded.visuals[0]!.position.y, 'the track lifted the prefab piece by 2').toBeCloseTo(2, 6)
    expect(loaded.visuals[1]!.position.y, 'and the rider went with it, keeping its own 1').toBeCloseTo(3, 6)
  })
})

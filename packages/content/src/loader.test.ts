import { vec3, type Vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { instantiateLevel, type ClipSource } from './loader'
import { effectiveNode, COLLIDER, LIGHT, MATERIAL_OVERRIDE, MESH, RENDERER, SPAWN, TRACK, type TypeInfo } from './nodes'
import { moveTrack } from './track'
import type { ComponentData, Node, Level } from './types'

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

const levelOf = (nodes: Node[], prefabs?: Record<string, Node>): Level => ({
  id: 'fx',
  config: {},
  ...(prefabs !== undefined ? { prefabs } : {}),
  nodes,
})

const load = (level: Level): ReturnType<typeof instantiateLevel> =>
  instantiateLevel(createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } }), level, TYPES)

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
            comp('c2', RENDERER, { material: '' }),
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
          components: [comp('c0', COLLIDER, { ...box(), center: vec3(2, 0, 0) }), comp('c1', RENDERER, { material: '' })],
        },
      ]),
    )
    const p = loaded.visuals[0]!.position
    expect(p.x).toBeCloseTo(0, 9)
    expect(p.z).toBeCloseTo(-2, 9)
  })
})

describe('a node draws only what it says it draws', () => {
  it('draws nothing without a Renderer, the way a GameObject with no renderer is invisible', () => {
    const loaded = load(levelOf([{ id: 'n0', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', COLLIDER, box())] }]))
    expect(loaded.visuals).toEqual([])
    expect(loaded.nodes, 'still solid, and still something a rule can sit on').toHaveLength(1)
  })

  it('draws a model without colliding, which no Piece could do', () => {
    const loaded = load(
      levelOf([
        { id: 'n0', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', MESH, { model: 'mesh1' }), comp('c1', RENDERER, { material: '' })] },
      ]),
    )
    expect(loaded.visuals).toHaveLength(1)
    expect(loaded.visuals[0]?.model).toBe('mesh1')
    expect(loaded.nodes, 'nothing to touch').toEqual([])
  })

  // A Renderer with nothing to render has nothing to draw. Inventing a box for it would put geometry in the
  // world that no data asked for.
  it('draws nothing for a Renderer with no mesh and no collider', () => {
    const loaded = load(levelOf([{ id: 'n0', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', RENDERER, { material: 'mat' })] }]))
    expect(loaded.visuals).toEqual([])
  })

  /** Unity's rule, and the reason the two are separate components (ADR 0039). */
  it('draws nothing for a Mesh with no Renderer, the way a MeshFilter alone shows nothing', () => {
    const loaded = load(
      levelOf([{ id: 'n0', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', COLLIDER, box()), comp('c1', MESH, { model: 'mesh1' })] }]),
    )
    expect(loaded.visuals).toEqual([])
    expect(loaded.nodes, 'still solid').toHaveLength(1)
  })

  it('falls back to the colliders when a Mesh names no model', () => {
    const loaded = load(
      levelOf([
        {
          id: 'n0',
          transform: { position: vec3(0, 0, 0) },
          components: [comp('c0', COLLIDER, box()), comp('c1', MESH, { model: '' }), comp('c2', RENDERER, { material: 'mat' })],
        },
      ]),
    )
    expect(loaded.visuals).toHaveLength(1)
    expect(loaded.visuals[0]?.model, 'no mesh asset, so the collider shape').toBeUndefined()
  })

  it('ignores a component that is switched off', () => {
    const loaded = load(
      levelOf([
        {
          id: 'n0',
          transform: { position: vec3(0, 0, 0) },
          components: [{ ...comp('c0', COLLIDER, box()), enabled: false }, comp('c1', RENDERER, { material: '' })],
        },
      ]),
    )
    expect(loaded.nodes, 'no body, so nothing can touch it').toEqual([])
    expect(loaded.visuals, 'and the Renderer has no collider left to draw').toEqual([])
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
          components: [comp('c0', COLLIDER, box()), comp('c1', RENDERER, { material: 'plain' })],
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
    components: [comp('rc0', TRACK, { keys: moveTrack(vec3(0, 1, 0), 2, 1000), loop: 'loop', phaseMs: 0 })],
    children: [
      {
        id: 'p0',
        transform: { position: vec3(0, 0, 0) },
        components: [comp('c0', COLLIDER, box()), comp('c1', RENDERER, { material: 'plain' })],
      },
    ],
  }

  const placed = (node: Partial<Node>): Level =>
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
          components: [comp('c0', COLLIDER, box()), comp('c1', RENDERER, { material: '' })],
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

/**
 * Lights (ADR 0047). The loader's job is to surface them as data and to carry them on the frame tree; what a
 * light *is* belongs to the renderer, and this package never learns.
 */
describe('a Light component', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('surfaces one light per component, at the node world position', () => {
    const loaded = load(
      levelOf([
        {
          id: 'lamp',
          transform: { position: vec3(2, 3, 4) },
          components: [comp('c0', LIGHT, { kind: 'point', color: '#ff8800', intensity: 7, range: 9 })],
        },
      ]),
    )
    expect(loaded.lights).toHaveLength(1)
    const light = loaded.lights[0]!
    expect(light.kind).toBe('point')
    expect(light.color).toBe('#ff8800')
    expect(light.intensity).toBe(7)
    expect(light.range).toBe(9)
    expect(light.position).toEqual(vec3(2, 3, 4))
    expect(light.node).toBe('lamp')
  })

  it('needs no collider and no renderer, so a light is not a solid', () => {
    const loaded = load(levelOf([{ id: 'l', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', LIGHT)] }]))
    expect(loaded.lights).toHaveLength(1)
    expect(loaded.visuals).toHaveLength(0)
    // Nothing to touch, so it is not in the touchable list — but it is still a node.
    expect(loaded.nodes).toHaveLength(0)
    expect(loaded.allNodes).toHaveLength(1)
  })

  it('defaults shadows off, whatever else is authored', () => {
    const loaded = load(levelOf([{ id: 'l', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', LIGHT, { intensity: 50 })] }]))
    expect(loaded.lights[0]!.castShadow).toBe(false)
  })

  it('honours a light that does ask to cast', () => {
    const loaded = load(levelOf([{ id: 'l', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', LIGHT, { castShadow: true })] }]))
    expect(loaded.lights[0]!.castShadow).toBe(true)
  })

  it('skips a switched-off light, like any other disabled component', () => {
    const loaded = load(
      levelOf([{ id: 'l', transform: { position: vec3(0, 0, 0) }, components: [{ id: 'c0', type: LIGHT, params: {}, enabled: false }] }]),
    )
    expect(loaded.lights).toHaveLength(0)
  })

  it('inherits its parent transform, so a lamp under a group moves with it', () => {
    const loaded = load(
      levelOf([
        {
          id: 'group',
          transform: { position: vec3(10, 0, 0) },
          components: [],
          children: [{ id: 'lamp', transform: { position: vec3(0, 2, 0) }, components: [comp('c0', LIGHT)] }],
        },
      ]),
    )
    expect(loaded.lights[0]!.position).toEqual(vec3(10, 2, 0))
  })

  /** The reason a light gets its own `Dynamic`: a moving lamp has no collider to ride along with. */
  it('rides a moving node even with no collider of its own', () => {
    const loaded = load(
      levelOf([
        {
          id: 'lamp',
          transform: { position: vec3(0, 0, 0) },
          components: [comp('c0', LIGHT), comp('c1', TRACK, { keys: moveTrack(vec3(0, 1, 0), 4, 1000), loop: 'loop', phaseMs: 0 })],
        },
      ]),
    )
    const start = { ...loaded.lights[0]!.position }
    loaded.update(250)
    loaded.render(1)
    expect(loaded.lights[0]!.position.y).not.toBe(start.y)
  })
})

/**
 * A `Track` playing an animation asset instead of its own keys (ADR 0050).
 *
 * The point of the whole asset kind is that one clip drives many movers, so the tests that matter are: a
 * clip resolves at all, two nodes playing one clip each move around *their own* transform, and every way of
 * naming nothing leaves the node standing still rather than throwing.
 */
describe('a Track that names a clip', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  const RISE = moveTrack(vec3(0, 1, 0), 4, 2000)
  const clips: ClipSource = { keys: (id) => (id === 'rise' ? RISE : undefined) }

  const mover = (id: string, at: Vec3, params: Record<string, unknown>): Node => ({
    id,
    transform: { position: at },
    components: [comp(`${id}-t`, TRACK, { loop: 'loop', phaseMs: 0, ...params }), comp(`${id}-c`, COLLIDER, box()), comp(`${id}-r`, RENDERER, {})],
  })

  const loadWith = (nodes: Node[]): ReturnType<typeof instantiateLevel> =>
    instantiateLevel(createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } }), levelOf(nodes), TYPES, clips)

  it('plays the clip’s keys', () => {
    const loaded = loadWith([mover('a', vec3(0, 0, 0), { clip: 'rise' })])
    loaded.update(0)
    expect(loaded.visuals[0]!.position.y).toBeCloseTo(0, 6)
    loaded.update(1000)
    expect(loaded.visuals[0]!.position.y, 'four metres up at the top of the cycle').toBeCloseTo(4, 6)
  })

  /** The property the asset kind exists for, and the reason keys had to become offsets first. */
  it('moves two nodes around their own transforms from one clip', () => {
    const loaded = loadWith([mover('a', vec3(0, 0, 0), { clip: 'rise' }), mover('b', vec3(10, 5, -3), { clip: 'rise' })])
    loaded.update(1000)
    expect(loaded.visuals[0]!.position).toMatchObject({ x: 0, z: 0 })
    expect(loaded.visuals[0]!.position.y).toBeCloseTo(4, 6)
    expect(loaded.visuals[1]!.position).toMatchObject({ x: 10, z: -3 })
    expect(loaded.visuals[1]!.position.y, 'the same four metres, from its own rest pose').toBeCloseTo(9, 6)
  })

  it('lets inline keys win over a clip, so a hand-edited file is never ambiguous', () => {
    const loaded = loadWith([mover('a', vec3(0, 0, 0), { clip: 'rise', keys: moveTrack(vec3(0, 1, 0), 1, 2000) })])
    loaded.update(1000)
    expect(loaded.visuals[0]!.position.y, 'the inline one metre, not the clip’s four').toBeCloseTo(1, 6)
  })

  it('stands still for a clip that does not resolve, rather than failing to load', () => {
    for (const params of [{ clip: 'gone' }, { clip: '' }, {}]) {
      const loaded = loadWith([mover('a', vec3(0, 2, 0), params)])
      loaded.update(1000)
      expect(loaded.visuals[0]!.position.y, `${JSON.stringify(params)} holds its transform`).toBeCloseTo(2, 6)
    }
  })

  it('stands still when no clip source was supplied at all', () => {
    const loaded = load(levelOf([mover('a', vec3(0, 2, 0), { clip: 'rise' })]))
    loaded.update(1000)
    expect(loaded.visuals[0]!.position.y).toBeCloseTo(2, 6)
  })
})

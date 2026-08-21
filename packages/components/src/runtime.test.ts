import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'
import { COLLIDER, instantiateLevel, type ComponentData, type Node, type Level, type WorldNode } from '@mp/content'
import { vec3 } from '@mp/core'

import { createComponentRuntime, characterAccess, hasHooks, type Effects } from './runtime'
import { createRegistry } from './registry'
import { defineComponent } from './define'
import { Bumper, Checkpoint, Goal, Hazard, Track } from './gameplay'
import { ENGINE_COMPONENTS } from './engine'

/**
 * Running components (stage C2).
 *
 * The load-bearing test here is the determinism one: the whole netcode claim is that a hook may accumulate
 * state because every client accumulates the same state, and that claim is only worth what a test says it is.
 */

const comp = (id: string, type: string, params: Record<string, unknown> = {}): ComponentData => ({ id, type, params })
const box = { shape: { kind: 'box', halfExtents: vec3(1, 1, 1) }, center: vec3(0, 0, 0) }

const levelOf = (nodes: Node[]): Level => ({ id: 'fx', config: {}, nodes })

/** Counts every call, so a test can assert order and how often something ran. */
const log: string[] = []

const Counter = defineComponent({
  type: 'Counter',
  params: { step: { kind: 'number', default: 1 } },
  init: (params) => ({ total: 0, started: params.step }),
  onAttach: (self) => void log.push(`attach:${self.node.id}`),
  onFixedUpdate: (self) => {
    self.state.total += self.params.step
    log.push(`update:${self.node.id}:${self.state.total}`)
  },
  onDetach: (self) => void log.push(`detach:${self.node.id}:${self.state.total}`),
})

/** Reads another component on its own node — Unity's GetComponent. */
const Peeker = defineComponent({
  type: 'Peeker',
  params: {},
  onAttach: (self) => void log.push(`peek:${self.get(Counter)?.step ?? 'none'}`),
})

/** Accumulates a deterministic random walk, which is what a desync would show up in. */
const Wanderer = defineComponent({
  type: 'Wanderer',
  params: {},
  init: () => ({ sum: 0 }),
  onFixedUpdate: (self, ctx) => {
    self.state.sum += ctx.random() + ctx.random()
  },
  onDetach: (self) => void log.push(`sum:${self.state.sum.toFixed(12)}`),
})

const Touchy = defineComponent({
  type: 'Touchy',
  params: {},
  onContact: (self, _ctx, hit) => void log.push(`touch:${self.node.id}:${hit.colliderHandle}`),
})

const TEST_REGISTRY = createRegistry([...ENGINE_COMPONENTS, Bumper, Checkpoint, Goal, Hazard, Track, Counter, Peeker, Wanderer, Touchy])

const load = (nodes: Node[]): ReturnType<typeof instantiateLevel> =>
  instantiateLevel(createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } }), levelOf(nodes), TEST_REGISTRY)

const noEffects = (): Effects => ({ kill: () => {}, progress: () => {} })

describe('which components the runner picks up', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('ignores anything with no hooks, so a data-only component costs nothing', () => {
    const loaded = load([{ id: 'n', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', COLLIDER, box), comp('c1', Goal.type)] }])
    expect(createComponentRuntime(loaded, TEST_REGISTRY, { character: { launch: () => {} }, effects: noEffects() }).count()).toBe(0)
  })

  it('says which definitions have anything to run', () => {
    expect(hasHooks(Bumper)).toBe(true)
    expect(hasHooks(Goal), 'no goal rule exists yet').toBe(false)
    expect(hasHooks(Track), 'motion is the loader’s pure function of time, not a hook').toBe(false)
  })

  it('skips a component that is switched off', () => {
    const loaded = load([{ id: 'n', transform: { position: vec3(0, 0, 0) }, components: [{ ...comp('c0', Counter.type), enabled: false }] }])
    expect(createComponentRuntime(loaded, TEST_REGISTRY, { character: { launch: () => {} }, effects: noEffects() }).count()).toBe(0)
  })

  it('runs a component on a node with no collider at all', () => {
    const loaded = load([{ id: 'n', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', Counter.type)] }])
    expect(loaded.nodes, 'nothing touchable').toEqual([])
    expect(createComponentRuntime(loaded, TEST_REGISTRY, { character: { launch: () => {} }, effects: noEffects() }).count()).toBe(1)
  })
})

describe('the lifecycle', () => {
  const tree = (): Node[] => [
    {
      id: 'parent',
      transform: { position: vec3(0, 0, 0) },
      components: [comp('c0', Counter.type, { step: 2 }), comp('c1', Peeker.type)],
      children: [{ id: 'child', transform: { position: vec3(0, 1, 0) }, components: [comp('c0', Counter.type, { step: 10 })] }],
    },
  ]

  it('attaches in tree order, then component order', () => {
    log.length = 0
    const runtime = createComponentRuntime(load(tree()), TEST_REGISTRY, { character: { launch: () => {} }, effects: noEffects() })
    runtime.attach(0, 0, 1 / 60)
    expect(log).toEqual(['attach:parent', 'peek:2', 'attach:child'])
  })

  it('gives each instance its own state, initialised from its own parameters', () => {
    log.length = 0
    const runtime = createComponentRuntime(load(tree()), TEST_REGISTRY, { character: { launch: () => {} }, effects: noEffects() })
    runtime.attach(0, 0, 1 / 60)
    runtime.fixedUpdate(1, 16, 1 / 60)
    runtime.fixedUpdate(2, 32, 1 / 60)
    expect(log.filter((l) => l.startsWith('update'))).toEqual(['update:parent:2', 'update:child:10', 'update:parent:4', 'update:child:20'])
  })

  it('detaches in reverse, so a child tears down before its parent', () => {
    log.length = 0
    const runtime = createComponentRuntime(load(tree()), TEST_REGISTRY, { character: { launch: () => {} }, effects: noEffects() })
    runtime.attach(0, 0, 1 / 60)
    runtime.detach()
    expect(log.filter((l) => l.startsWith('detach'))).toEqual(['detach:child:0', 'detach:parent:0'])
  })

  it('reads another component on its own node, and nothing from elsewhere', () => {
    log.length = 0
    const loaded = load([
      { id: 'a', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', Peeker.type)] },
      { id: 'b', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', Counter.type, { step: 7 })] },
    ])
    createComponentRuntime(loaded, TEST_REGISTRY, { character: { launch: () => {} }, effects: noEffects() }).attach(0, 0, 1 / 60)
    expect(log.filter((l) => l.startsWith('peek')), 'the Counter is on the other node, so there is nothing to find').toEqual(['peek:none'])
  })
})

describe('contact', () => {
  const nodes = (): Node[] => [
    { id: 'pad', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', COLLIDER, box), comp('c1', Touchy.type)] },
  ]

  it('delivers to every component on the node that owns the collider', () => {
    log.length = 0
    const loaded = load(nodes())
    const runtime = createComponentRuntime(loaded, TEST_REGISTRY, { character: { launch: () => {} }, effects: noEffects() })
    const handle = loaded.nodes[0]!.colliderHandles[0]!
    runtime.contact([handle])
    expect(log).toEqual([`touch:pad:${handle}`])
  })

  it('ignores a handle that belongs to nothing', () => {
    log.length = 0
    const runtime = createComponentRuntime(load(nodes()), TEST_REGISTRY, { character: { launch: () => {} }, effects: noEffects() })
    runtime.contact([9999])
    expect(log).toEqual([])
  })
})

describe('the rules that own their reaction', () => {
  const solid = (id: string, rule: ComponentData): Node => ({
    id,
    transform: { position: vec3(0, 0, 0) },
    components: [comp('c0', COLLIDER, box), rule],
  })

  const fire = (nodes: Node[]): { launched: number; killed: number; progressed: WorldNode[] } => {
    const loaded = load(nodes)
    let launched = 0
    let killed = 0
    const progressed: WorldNode[] = []
    const runtime = createComponentRuntime(loaded, TEST_REGISTRY, {
      character: {
        launch: (speed) => {
          if (speed > launched) launched = speed
        },
      },
      effects: { kill: () => void killed++, progress: (n) => void progressed.push(n) },
    })
    // Every collider in the level, which is what touching all of them at once looks like. Taken from the
    // nodes rather than counted up from zero: a Rapier handle packs a generation and is not a small integer.
    runtime.contact(loaded.nodes.flatMap((n) => [...n.colliderHandles]))
    return { launched, killed, progressed }
  }

  it('launches off a bumper, at its own power', () => {
    expect(fire([solid('t', comp('c1', Bumper.type, { power: 40 }))]).launched).toBe(40)
  })

  it('launches at the strongest when several are touched at once', () => {
    const result = fire([solid('a', comp('c1', Bumper.type, { power: 20 })), solid('b', comp('c1', Bumper.type, { power: 45 }))])
    expect(result.launched, 'the reading that cannot surprise anybody').toBe(45)
  })

  it('takes a bumper’s default when the parameter was never written', () => {
    expect(fire([solid('t', comp('c1', Bumper.type))]).launched).toBe(26)
  })

  it('kills on a hazard', () => {
    expect(fire([solid('t', comp('c1', Hazard.type))]).killed).toBe(1)
  })

  it('reports progress at a checkpoint, handing over the node', () => {
    const { progressed } = fire([solid('cp', comp('c1', Checkpoint.type))])
    expect(progressed.map((n) => n.id)).toEqual(['cp'])
  })

  it('does nothing at a goal, because no goal rule exists yet', () => {
    const result = fire([solid('g', comp('c1', Goal.type))])
    expect([result.launched, result.killed, result.progressed.length]).toEqual([0, 0, 0])
  })

  it('bounces and kills on one node, which no single trigger field could say', () => {
    const both: Node = {
      id: 'nasty',
      transform: { position: vec3(0, 0, 0) },
      components: [comp('c0', COLLIDER, box), comp('c1', Bumper.type, { power: 30 }), comp('c2', Hazard.type)],
    }
    const result = fire([both])
    expect(result.launched).toBe(30)
    expect(result.killed).toBe(1)
  })
})

/**
 * The test this whole design rests on.
 *
 * A hook may accumulate state because every client accumulates the *same* state. Two runtimes over the same
 * level, folded over the same ticks, must agree exactly — including through `ctx.random()`, which is what
 * would betray a hidden `Math.random` or a wall-clock read.
 */
describe('determinism', () => {
  const nodes = (): Node[] => [
    {
      id: 'a',
      transform: { position: vec3(0, 0, 0) },
      components: [comp('c0', Wanderer.type), comp('c1', Counter.type, { step: 3 })],
      children: [{ id: 'b', transform: { position: vec3(0, 1, 0) }, components: [comp('c0', Wanderer.type)] }],
    },
  ]

  const fold = (ticks: number): string[] => {
    log.length = 0
    const runtime = createComponentRuntime(load(nodes()), TEST_REGISTRY, { character: { launch: () => {} }, effects: noEffects() })
    runtime.attach(0, 0, 1 / 60)
    for (let t = 1; t <= ticks; t++) runtime.fixedUpdate(t, t * 16.666, 1 / 60)
    runtime.detach()
    return [...log]
  }

  it('two runs over the same ticks produce identical state', () => {
    expect(fold(120)).toEqual(fold(120))
  })

  it('the same tick gives the same random numbers, so a resume lands where a replay does', () => {
    const short = fold(30).filter((l) => l.startsWith('update'))
    const long = fold(60).filter((l) => l.startsWith('update'))
    // The `sum` lines are the accumulated walk, so they differ by construction. The shared prefix must not.
    expect(long.slice(0, short.length)).toEqual(short)
    expect(long.length).toBe(short.length * 2)
  })

  it('draws numbers in [0, 1) and does not repeat within a tick', () => {
    log.length = 0
    const runtime = createComponentRuntime(load(nodes()), TEST_REGISTRY, { character: { launch: () => {} }, effects: noEffects() })
    runtime.attach(0, 0, 1 / 60)
    runtime.fixedUpdate(1, 16, 1 / 60)
    runtime.detach()
    const sums = log.filter((l) => l.startsWith('sum:')).map((l) => Number(l.slice(4)))
    expect(sums).toHaveLength(2)
    for (const s of sums) expect(s).toBeGreaterThan(0)
    for (const s of sums) expect(s).toBeLessThan(2)
    expect(sums[0], 'two instances at one tick draw different numbers').not.toBe(sums[1])
  })
})

describe('characterAccess', () => {
  it('raises the launch field and never lowers it, since the step is what consumes it', () => {
    const state = { launch: 0 }
    const access = characterAccess(state)
    access.launch(20)
    access.launch(5)
    expect(state.launch).toBe(20)
    access.launch(40)
    expect(state.launch).toBe(40)
  })
})

describe('node references (stage C4)', () => {
  const Linked = defineComponent({
    type: 'Linked',
    params: { target: { kind: 'nodeRef' } },
    onAttach: (self) => void log.push(`link:${self.node.id}->${self.find(self.params.target)?.id ?? 'nothing'}`),
  })
  const REG = createRegistry([...ENGINE_COMPONENTS, Linked])
  const loadWith = (level: Level): ReturnType<typeof instantiateLevel> =>
    instantiateLevel(createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } }), level, REG)
  const attach = (level: Level): void => {
    log.length = 0
    createComponentRuntime(loadWith(level), REG, { character: { launch: () => {} }, effects: noEffects() }).attach(0, 0, 1 / 60)
  }

  it('resolves a reference between two nodes in a level', () => {
    attach(
      levelOf([
        { id: 'a', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', Linked.type, { target: 'b' })] },
        { id: 'b', transform: { position: vec3(3, 0, 0) }, components: [] },
      ]),
    )
    expect(log).toEqual(['link:a->b'])
  })

  it('reads a missing target as nothing rather than throwing', () => {
    attach(levelOf([{ id: 'a', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', Linked.type, { target: 'ghost' })] }]))
    expect(log).toEqual(['link:a->nothing'])
  })

  it('takes null for no reference at all', () => {
    attach(levelOf([{ id: 'a', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', Linked.type)] }]))
    expect(log).toEqual(['link:a->nothing'])
  })

  /**
   * The case the whole scope mechanism exists for. Both placements of one prefab carry the same authored
   * reference, and each has to find **its own** copy — resolving both to the first placement's node is the
   * failure that would look like it worked.
   */
  it('resolves a reference authored inside a prefab to this placement’s own copy', () => {
    const prefab: Node = {
      id: 'root',
      name: 'pair',
      transform: { position: vec3(0, 0, 0) },
      components: [],
      children: [
        { id: 'watcher', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', Linked.type, { target: 'anchor' })] },
        { id: 'anchor', transform: { position: vec3(1, 0, 0) }, components: [] },
      ],
    }
    const level: Level = {
      id: 'fx',
      config: {},
      prefabs: { pair: prefab },
      nodes: [
        { id: 'first', transform: { position: vec3(0, 0, 0) }, components: [], prefab: 'pair' },
        { id: 'second', transform: { position: vec3(9, 0, 0) }, components: [], prefab: 'pair' },
      ],
    }
    const loaded = loadWith(level)
    log.length = 0
    createComponentRuntime(loaded, REG, { character: { launch: () => {} }, effects: noEffects() }).attach(0, 0, 1 / 60)

    // Both say `anchor`, so the ids alone cannot tell them apart. The positions can.
    expect(log).toEqual(['link:watcher->anchor', 'link:watcher->anchor'])
    const anchors = loaded.allNodes.filter((n) => n.id === 'anchor')
    expect(anchors).toHaveLength(2)
    expect(anchors[0]!.scope, 'two placements, two scopes').not.toBe(anchors[1]!.scope)
    expect(loaded.findNode(anchors[0]!, 'anchor')).toBe(anchors[0]!)
    expect(loaded.findNode(anchors[1]!, 'anchor')).toBe(anchors[1]!)
  })

  it('lets a reference set on a placement reach a level node, since that override lives in the level', () => {
    const prefab: Node = { id: 'root', name: 'one', transform: { position: vec3(0, 0, 0) }, components: [], children: [{ id: 'inner', transform: { position: vec3(0, 0, 0) }, components: [] }] }
    const level: Level = {
      id: 'fx',
      config: {},
      prefabs: { one: prefab },
      nodes: [
        { id: 'placed', transform: { position: vec3(0, 0, 0) }, components: [], prefab: 'one', overrides: { inner: { added: [comp('a0', Linked.type, { target: 'elsewhere' })] } } },
        { id: 'elsewhere', transform: { position: vec3(5, 0, 0) }, components: [] },
      ],
    }
    attach(level)
    expect(log).toEqual(['link:inner->elsewhere'])
  })
})

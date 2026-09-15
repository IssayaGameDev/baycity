import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'
import { COLLIDER, RENDERER, instantiateLevel, type ComponentData, type Node, type Level, type WorldNode } from '@mp/content'
import { vec3 } from '@mp/core'

import { createComponentRuntime, characterAccess, hasHooks, HOOK_NAMES, type Effects } from './runtime'
import { createRegistry } from './registry'
import { defineComponent } from './define'
import { Bumper, Checkpoint, Goal, Hazard, Mover } from './gameplay'
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

/** Drives its own node upward, a tick at a time (ADR 0058). Declares `moves`, so `self.offset` is live. */
const Riser = defineComponent({
  type: 'Riser',
  params: { rate: { kind: 'number', default: 1 } },
  moves: true,
  onFixedUpdate: (self, ctx) => {
    if (self.offset !== undefined) self.offset.position.y += self.params.rate * ctx.dt
  },
})

/** Wants to move its node but never said so. The point is that it gets `undefined` rather than a no-op. */
const Sneak = defineComponent({
  type: 'Sneak',
  params: {},
  onFixedUpdate: (self) => void log.push(`sneak:${self.offset === undefined ? 'denied' : 'granted'}`),
})

/** Turns its own node a quarter turn a tick. Rotation is Euler **radians**, like `Transform`. */
const Spinner = defineComponent({
  type: 'Spinner',
  params: {},
  moves: true,
  onFixedUpdate: (self) => {
    if (self.offset !== undefined) self.offset.rotation.y += Math.PI / 2
  },
})

const TEST_REGISTRY = createRegistry([...ENGINE_COMPONENTS, Bumper, Checkpoint, Goal, Hazard, Mover, Counter, Peeker, Wanderer, Touchy, Riser, Sneak, Spinner])

const load = (nodes: Node[]): ReturnType<typeof instantiateLevel> =>
  instantiateLevel(createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } }), levelOf(nodes), TEST_REGISTRY)

const noEffects = (): Effects => ({ kill: () => {}, progress: () => {} })

/**
 * A character-shaped object for `characterAccess`, standing in for `CharacterState` (ADR 0059).
 *
 * `CharacterLike` is structural precisely so this package can be tested without importing the controller,
 * and building it through `characterAccess` rather than hand-writing the six methods is what stops a test
 * from passing against a stub the game does not use.
 */
const fakeCharacter = (at = vec3(0, 0, 0)) => ({
  launch: 0,
  impulse: vec3(0, 0, 0),
  vx: 0,
  vy: 0,
  vz: 0,
  carry: vec3(0, 0, 0),
  grounded: true,
  body: { translation: () => at },
})

/** The access every test that does not care about the character passes. */
const anyCharacter = () => characterAccess(fakeCharacter())

describe('which components the runner picks up', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('ignores anything with no hooks, so a data-only component costs nothing', () => {
    const loaded = load([{ id: 'n', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', COLLIDER, box), comp('c1', Goal.type)] }])
    expect(createComponentRuntime(loaded, TEST_REGISTRY, { character: anyCharacter(), effects: noEffects() }).count()).toBe(0)
  })

  it('says which definitions have anything to run', () => {
    expect(hasHooks(Bumper)).toBe(true)
    expect(hasHooks(Goal), 'no goal rule exists yet').toBe(false)
    expect(hasHooks(Mover), 'motion is the loader’s pure function of time, not a hook').toBe(false)
  })

  it('skips a component that is switched off', () => {
    const loaded = load([{ id: 'n', transform: { position: vec3(0, 0, 0) }, components: [{ ...comp('c0', Counter.type), enabled: false }] }])
    expect(createComponentRuntime(loaded, TEST_REGISTRY, { character: anyCharacter(), effects: noEffects() }).count()).toBe(0)
  })

  it('runs a component on a node with no collider at all', () => {
    const loaded = load([{ id: 'n', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', Counter.type)] }])
    expect(loaded.nodes, 'nothing touchable').toEqual([])
    expect(createComponentRuntime(loaded, TEST_REGISTRY, { character: anyCharacter(), effects: noEffects() }).count()).toBe(1)
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
    const runtime = createComponentRuntime(load(tree()), TEST_REGISTRY, { character: anyCharacter(), effects: noEffects() })
    runtime.attach(0, 0, 1 / 60)
    expect(log).toEqual(['attach:parent', 'peek:2', 'attach:child'])
  })

  it('gives each instance its own state, initialised from its own parameters', () => {
    log.length = 0
    const runtime = createComponentRuntime(load(tree()), TEST_REGISTRY, { character: anyCharacter(), effects: noEffects() })
    runtime.attach(0, 0, 1 / 60)
    runtime.fixedUpdate(1, 16, 1 / 60)
    runtime.fixedUpdate(2, 32, 1 / 60)
    expect(log.filter((l) => l.startsWith('update'))).toEqual(['update:parent:2', 'update:child:10', 'update:parent:4', 'update:child:20'])
  })

  it('detaches in reverse, so a child tears down before its parent', () => {
    log.length = 0
    const runtime = createComponentRuntime(load(tree()), TEST_REGISTRY, { character: anyCharacter(), effects: noEffects() })
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
    createComponentRuntime(loaded, TEST_REGISTRY, { character: anyCharacter(), effects: noEffects() }).attach(0, 0, 1 / 60)
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
    const runtime = createComponentRuntime(loaded, TEST_REGISTRY, { character: anyCharacter(), effects: noEffects() })
    const handle = loaded.nodes[0]!.colliderHandles[0]!
    runtime.contact([handle])
    expect(log).toEqual([`touch:pad:${handle}`])
  })

  it('ignores a handle that belongs to nothing', () => {
    log.length = 0
    const runtime = createComponentRuntime(load(nodes()), TEST_REGISTRY, { character: anyCharacter(), effects: noEffects() })
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
    // Through the real `characterAccess`, so the "strongest bumper wins" rule under test is the shipped one
    // rather than a copy of it written here.
    const character = fakeCharacter()
    const runtime = createComponentRuntime(loaded, TEST_REGISTRY, {
      character: characterAccess(character),
      effects: { kill: () => void killed++, progress: (n) => void progressed.push(n) },
    })
    // Every collider in the level, which is what touching all of them at once looks like. Taken from the
    // nodes rather than counted up from zero: a Rapier handle packs a generation and is not a small integer.
    runtime.contact(loaded.nodes.flatMap((n) => [...n.colliderHandles]))
    launched = character.launch
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
    const runtime = createComponentRuntime(load(nodes()), TEST_REGISTRY, { character: anyCharacter(), effects: noEffects() })
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
    const runtime = createComponentRuntime(load(nodes()), TEST_REGISTRY, { character: anyCharacter(), effects: noEffects() })
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
    const state = fakeCharacter()
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
    createComponentRuntime(loadWith(level), REG, { character: anyCharacter(), effects: noEffects() }).attach(0, 0, 1 / 60)
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
    createComponentRuntime(loaded, REG, { character: anyCharacter(), effects: noEffects() }).attach(0, 0, 1 / 60)

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

/**
 * A component moving its own node (ADR 0058).
 *
 * The gap this closed: `WorldNode` is readonly and a `Mover` is evaluated by the loader as `offset = f(t)`, so
 * nothing a hook could reach was writable and "a door that opens when touched" was not expressible in any
 * game. What a component writes is an **offset** from the authored transform, which is why these assert
 * against a node placed away from the origin rather than at it.
 */
describe('driving a node', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  const at = (id: string, y: number, ...components: ComponentData[]): Node => ({
    id,
    transform: { position: vec3(0, y, 0) },
    // A `Renderer` too: it is what turns the node's colliders into a `VisualItem`, and half of what these
    // assert is that the *drawn* thing followed the body rather than only the body moving.
    components: [comp('c0', COLLIDER, box), comp('c1', RENDERER, { material: '' }), ...components],
  })

  /** The visual drawing a node's first collider. */
  const visualOf = (level: ReturnType<typeof instantiateLevel>, id: string) => {
    const handle = level.allNodes.find((n) => n.id === id)!.colliderHandles[0]!
    return level.visuals.find((v) => v.colliderHandles.includes(handle))!
  }

  /** One tick of the real order: components write, then the frame tree reads. */
  const tick = (level: ReturnType<typeof instantiateLevel>, runtime: ReturnType<typeof createComponentRuntime>, n: number, ms: number): void => {
    runtime.fixedUpdate(n, ms, 1)
    level.update(ms)
  }

  it('hands a live offset to a component that declared moves, and nothing to one that did not', () => {
    const level = load([at('driven', 0, comp('r', 'Riser')), at('static', 0, comp('s', 'Sneak'))])
    expect(level.driveOf(level.allNodes.find((n) => n.id === 'driven')!)).toEqual({ position: vec3(0, 0, 0), rotation: vec3(0, 0, 0) })
    expect(level.driveOf(level.allNodes.find((n) => n.id === 'static')!)).toBeUndefined()

    log.length = 0
    const runtime = createComponentRuntime(level, TEST_REGISTRY, { character: anyCharacter(), effects: noEffects() })
    runtime.attach(0, 0, 1)
    runtime.fixedUpdate(1, 0, 1)
    expect(log).toEqual(['sneak:denied'])
  })

  it('moves the node it sits on, and the visual with it', () => {
    const level = load([at('lift', 5, comp('r', 'Riser', { rate: 2 }))])
    const visual = visualOf(level, 'lift')
    const runtime = createComponentRuntime(level, TEST_REGISTRY, { character: anyCharacter(), effects: noEffects() })
    runtime.attach(0, 0, 1)

    tick(level, runtime, 1, 0)
    // The offset is added to the authored 5, never replacing it.
    expect(visual.position.y).toBeCloseTo(7, 6)
    tick(level, runtime, 2, 0)
    expect(visual.position.y).toBeCloseTo(9, 6)
  })

  it('carries children, so moving a parent moves its subtree', () => {
    const level = load([
      {
        id: 'platform',
        transform: { position: vec3(0, 0, 0) },
        components: [comp('c0', COLLIDER, box), comp('c1', RENDERER, { material: '' }), comp('r', 'Riser', { rate: 1 })],
        children: [at('rider', 3)],
      },
    ])
    const runtime = createComponentRuntime(level, TEST_REGISTRY, { character: anyCharacter(), effects: noEffects() })
    runtime.attach(0, 0, 1)
    tick(level, runtime, 1, 0)

    const child = visualOf(level, 'rider')
    // The child was authored 3 above its parent and the parent rose 1.
    expect(child.position.y).toBeCloseTo(4, 6)
  })

  it('rotates the node, in Euler radians like its transform', () => {
    const level = load([at('turn', 0, comp('s', 'Spinner'))])
    const runtime = createComponentRuntime(level, TEST_REGISTRY, { character: anyCharacter(), effects: noEffects() })
    runtime.attach(0, 0, 1)
    tick(level, runtime, 1, 0)
    // 90° about Y is (0, √½, 0, √½).
    const visual = visualOf(level, 'turn')
    expect(visual.rotation.y).toBeCloseTo(Math.SQRT1_2, 6)
    expect(visual.rotation.w).toBeCloseTo(Math.SQRT1_2, 6)
  })

  /**
   * The reason the drive is an offset and not a pose: a node can be moved by a `Mover` *and* by a component,
   * and the answer is both rather than whichever ran last.
   */
  it('adds to a mover rather than fighting it', () => {
    // 10 m at 10 m/s is a one-second leg, so half a second in it is 5 m up.
    const level = load([at('both', 0, comp('t', 'Mover', { move: vec3(0, 10, 0), speed: 10, smooth: false }), comp('r', 'Riser', { rate: 1 }))])
    const runtime = createComponentRuntime(level, TEST_REGISTRY, { character: anyCharacter(), effects: noEffects() })
    runtime.attach(0, 0, 1)
    // Half way along the mover's leg is 5; one tick of the riser at rate 1 and dt 1 is another 1.
    tick(level, runtime, 1, 500)
    expect(visualOf(level, 'both').position.y).toBeCloseTo(6, 6)
  })

  /** A driven node needs a kinematic body, decided at load, which is why `moves` has to be declared. */
  it('gives a driven node a body that can actually be posed', () => {
    const level = load([at('driven', 0, comp('r', 'Riser'))])
    const runtime = createComponentRuntime(level, TEST_REGISTRY, { character: anyCharacter(), effects: noEffects() })
    runtime.attach(0, 0, 1)
    tick(level, runtime, 1, 0)
    // `basePose` only answers for nodes in the per-tick pose pass, so a non-zero answer here is the proof.
    const handle = level.allNodes.find((n) => n.id === 'driven')!.colliderHandles[0]!
    expect(level.basePose(handle)?.position.y).toBeCloseTo(1, 6)
  })
})

/**
 * The widened character access, and components living on the player (ADR 0059).
 *
 * `launch` was the whole surface before this, which is why a trampoline was expressible and a rope was not.
 */
describe('the character access', () => {
  it('reads position, velocity, carry and footing off the live state', () => {
    const state = fakeCharacter(vec3(1, 2, 3))
    const access = characterAccess(state)
    expect(access.position()).toEqual(vec3(1, 2, 3))

    state.vx = 4
    state.vz = -6
    state.grounded = false
    state.carry = vec3(0, 9, 0)
    // Accessors rather than a snapshot, so a component reading next tick sees next tick.
    expect(access.velocity()).toEqual({ x: 4, y: 0, z: -6 })
    expect(access.carry()).toEqual(vec3(0, 9, 0))
    expect(access.grounded()).toBe(false)
  })

  /** Adds, where `launch` takes the max: two shoves have a sum, two heights do not. */
  it('accumulates pushes within a tick', () => {
    const state = fakeCharacter()
    const access = characterAccess(state)
    access.push(vec3(1, 0, 0))
    access.push(vec3(0, 0, 2))
    access.push(vec3(-4, 5, 0))
    expect(state.impulse).toEqual(vec3(-3, 5, 2))
  })

  /** In place, because the step zeroes that same object rather than replacing it. */
  it('pushes into the object the step consumes', () => {
    const state = fakeCharacter()
    const impulse = state.impulse
    characterAccess(state).push(vec3(0, 1, 0))
    expect(state.impulse).toBe(impulse)
  })
})

describe('components on the player', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  const Ability = defineComponent({
    type: 'Ability',
    params: { strength: { kind: 'number', default: 3 } },
    onAttach: (self) => void log.push(`ability:attach:${self.node.id}`),
    onFixedUpdate: (self, ctx) => {
      log.push(`ability:${ctx.character.grounded() ? 'ground' : 'air'}`)
      ctx.character.push(vec3(self.params.strength, 0, 0))
    },
    onContact: () => void log.push('ability:contact'),
  })
  const REG = createRegistry([...ENGINE_COMPONENTS, Counter, Ability])
  const loadIn = (nodes: Node[]): ReturnType<typeof instantiateLevel> =>
    instantiateLevel(createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } }), levelOf(nodes), REG)

  const player = { id: 'player', components: [comp('a', 'Ability', { strength: 5 })] }

  it('runs a component the level never mentioned', () => {
    log.length = 0
    const state = fakeCharacter()
    const runtime = createComponentRuntime(loadIn([]), REG, { character: characterAccess(state), effects: noEffects(), player })
    expect(runtime.count()).toBe(1)
    runtime.attach(0, 0, 1)
    runtime.fixedUpdate(1, 0, 1)
    expect(log).toEqual(['ability:attach:player', 'ability:ground'])
    expect(state.impulse).toEqual(vec3(5, 0, 0))
  })

  it('attaches nothing when a game declares no player components', () => {
    expect(createComponentRuntime(loadIn([]), REG, { character: anyCharacter(), effects: noEffects() }).count()).toBe(0)
  })

  /** The level is the world and the player reacts to it, so within a tick the world has already moved. */
  it('runs after every level node', () => {
    log.length = 0
    const nodes: Node[] = [
      { id: 'a', transform: { position: vec3(0, 0, 0) }, components: [comp('c', 'Counter')] },
      { id: 'b', transform: { position: vec3(0, 0, 0) }, components: [comp('c', 'Counter')] },
    ]
    const runtime = createComponentRuntime(loadIn(nodes), REG, { character: anyCharacter(), effects: noEffects(), player })
    runtime.attach(0, 0, 1)
    expect(log).toEqual(['attach:a', 'attach:b', 'ability:attach:player'])
  })

  /**
   * The player owns no colliders, so a contact is delivered to whatever it *touched*. A hazard the player
   * walks into fires on the hazard's node, which is where the rule was authored.
   */
  it('never fires onContact, having no colliders of its own', () => {
    log.length = 0
    const loaded = loadIn([{ id: 'pad', transform: { position: vec3(0, 0, 0) }, components: [comp('c0', COLLIDER, box)] }])
    const runtime = createComponentRuntime(loaded, REG, { character: anyCharacter(), effects: noEffects(), player })
    runtime.attach(0, 0, 1)
    log.length = 0
    runtime.contact(loaded.nodes.flatMap((n) => [...n.colliderHandles]))
    expect(log).toEqual([])
  })

  it('tears down with everything else', () => {
    const runtime = createComponentRuntime(loadIn([]), REG, { character: anyCharacter(), effects: noEffects(), player })
    runtime.attach(0, 0, 1)
    log.length = 0
    runtime.detach()
    // `Ability` has no onDetach; what is asserted is that detaching a player component does not throw.
    expect(log).toEqual([])
  })
})

/**
 * A component with **only** a new hook still counts as having hooks (ADR 0061).
 *
 * The bug this stops, hit while adding `onLocomote`: `defineComponent` decided data-or-behaviour from a
 * hand-written list of hook names, so a component carrying only the new one looked like data and the runner
 * skipped it entirely. Silent, and it looks exactly like the hook never firing. Both sides read `HOOK_NAMES`
 * now, and this is the test that says so.
 */
describe('hook detection', () => {
  it('counts every hook the runner knows about', () => {
    for (const name of HOOK_NAMES) {
      const def = defineComponent({ type: `Only_${name}`, params: {}, [name]: () => {} })
      expect(hasHooks(def), name).toBe(true)
    }
  })

  it('still treats a component with no hooks as data', () => {
    expect(hasHooks(defineComponent({ type: 'JustData', params: {} }))).toBe(false)
  })
})

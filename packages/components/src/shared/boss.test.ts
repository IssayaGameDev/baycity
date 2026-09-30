import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'
import { COLLIDER, instantiateLevel, type ComponentData, type Node, type Level } from '@mp/content'
import { vec3, type Vec3 } from '@mp/core'

import { createComponentRuntime, characterAccess, type Effects } from '../runtime'
import { createRegistry } from '../registry'
import { ENGINE_COMPONENTS } from '../engine/index'
import { Boss } from './boss'

/**
 * The Boss (ADR 0095): who it picks, where it drives, and what it does with an empty zone.
 *
 * Every test runs the real runtime over a real instantiated level, because the parts most likely to be wrong
 * are the seams — that `nodeRef` resolves, that a node reports its world rotation and its world-scaled box,
 * and that `self.offset` is live. A hand-built `self` would pass while all three were broken.
 */

const comp = (id: string, type: string, params: Record<string, unknown> = {}): ComponentData => ({ id, type, params })
const REGISTRY = createRegistry([...ENGINE_COMPONENTS, Boss])
const noEffects = (): Effects => ({ kill: () => {}, progress: () => {} })
const DT = 1 / 60

const character = (at: Vec3) =>
  characterAccess({ launch: 0, impulse: vec3(0, 0, 0), vx: 0, vy: 0, vz: 0, carry: vec3(0, 0, 0), grounded: true, body: { translation: () => at } })

/**
 * A boss at the origin and a zone box reaching 20 m down +Z.
 *
 * `rotationDeg` turns the zone, which is the only thing that says which way "through" it is.
 */
const scene = (opts: { rotationDeg?: number; zoneAt?: Vec3; half?: Vec3; speed?: number; turn?: number } = {}): Node[] => [
  {
    id: 'boss',
    transform: { position: vec3(0, 0, 0) },
    components: [comp('b0', Boss.type, { zone: { node: 'zone', component: 'z0' }, speed: opts.speed ?? 6, turn: opts.turn ?? 3600 })],
  },
  {
    id: 'zone',
    transform: { position: opts.zoneAt ?? vec3(0, 0, 10), rotation: vec3(0, opts.rotationDeg ?? 0, 0) },
    components: [comp('z0', COLLIDER, { shape: { kind: 'box', halfExtents: opts.half ?? vec3(10, 5, 20) }, center: vec3(0, 0, 0), trigger: true })],
  },
]

/** Run the boss for `ticks` and report where it ended up, in world space. */
/** A peer as the runtime wants one. Alive unless a test is about death. */
const peer = (id: number, position: Vec3, alive = true): Peer => ({ id, position, alive })
type Peer = { id: number; position: Vec3; alive: boolean }

const run = (
  nodes: Node[],
  peers: readonly Peer[],
  ticks: number,
  self: Vec3 = vec3(0, -100, 0), // far below by default, so the local player is not in the zone
): { position: Vec3; heading: number } => {
  const loaded = instantiateLevel(createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } }), { id: 'fx', config: {}, nodes } as Level, REGISTRY)
  const runtime = createComponentRuntime(loaded, REGISTRY, { character: character(self), effects: noEffects(), peers: () => peers })
  runtime.attach(0, 0, DT)
  for (let t = 1; t <= ticks; t++) runtime.fixedUpdate(t, t * DT * 1000, DT)
  const node = loaded.allNodes.find((n) => n.id === 'boss')!
  const drive = loaded.driveOf(node)!
  return {
    position: vec3(node.position.x + drive.position.x, node.position.y + drive.position.y, node.position.z + drive.position.z),
    heading: drive.rotation.y,
  }
}

describe('Boss', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('does not move while its zone is empty', () => {
    const at = run(scene(), [], 60)
    expect(at.position.x).toBeCloseTo(0, 6)
    expect(at.position.z).toBeCloseTo(0, 6)
  })

  it('drives at the player in the zone, at the speed it was given', () => {
    // One second at 6 m/s, straight down +Z at a player 15 m away.
    const at = run(scene({ speed: 6 }), [peer(1000, vec3(0, 0, 15))], 60)
    expect(at.position.z).toBeCloseTo(6, 1)
    expect(at.position.x).toBeCloseTo(0, 6)
  })

  it('picks the player furthest along the zone, not the nearest', () => {
    // Both inside; the one at z = 18 is closer to the exit, so the boss should veer to +x, not -x.
    const at = run(
      scene(),
      [
        peer(1000, vec3(-8, 0, 4)),
        peer(1001, vec3(8, 0, 18)),
      ],
      60,
    )
    expect(at.position.x).toBeGreaterThan(1)
  })

  it('follows the zone when the zone is turned, because forward is the zone\'s own', () => {
    // Turned 90°, so "through" is +X. The player further along +X is now the target, not the one further +Z.
    const at = run(
      scene({ rotationDeg: 90 }),
      [
        peer(1000, vec3(4, 0, -8)),
        peer(1001, vec3(18, 0, 8)),
      ],
      60,
    )
    expect(at.position.z).toBeGreaterThan(1)
  })

  it('ignores anyone outside the box', () => {
    // 60 m down z is well past the zone's far face at z = 30.
    const at = run(scene(), [peer(1000, vec3(0, 0, 60))], 60)
    expect(at.position.z).toBeCloseTo(0, 6)
  })

  it('counts the local player too', () => {
    const at = run(scene(), [], 60, vec3(0, 0, 15))
    expect(at.position.z).toBeCloseTo(6, 1)
  })

  it('drives home when the zone empties, and stops there rather than circling', () => {
    const nodes = scene({ speed: 6 })
    const loaded = instantiateLevel(createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } }), { id: 'fx', config: {}, nodes } as Level, REGISTRY)
    let peers: Peer[] = [peer(1000, vec3(0, 0, 15))]
    const runtime = createComponentRuntime(loaded, REGISTRY, {
      character: character(vec3(0, -100, 0)),
      effects: noEffects(),
      peers: () => peers,
    })
    const node = loaded.allNodes.find((n) => n.id === 'boss')!
    const drive = loaded.driveOf(node)!

    runtime.attach(0, 0, DT)
    for (let t = 1; t <= 60; t++) runtime.fixedUpdate(t, t * DT * 1000, DT)
    expect(drive.position.z, 'it came out to meet them').toBeGreaterThan(5)

    peers = []
    // Long enough to get home twice over: it must arrive and settle, not oscillate about the origin.
    for (let t = 61; t <= 400; t++) runtime.fixedUpdate(t, t * DT * 1000, DT)
    expect(drive.position.x).toBeCloseTo(0, 5)
    expect(drive.position.z).toBeCloseTo(0, 5)
  })

  it('cannot swing its heading faster than `turn`', () => {
    // 90°/s given a target straight behind it: after a tenth of a second it has turned about 9°, so it has
    // barely begun to come round and has certainly not reached the player.
    const slow = run(scene({ turn: 90, speed: 6, zoneAt: vec3(0, 0, -10) }), [peer(1000, vec3(0, 0, -15))], 6)
    expect(Math.abs(slow.position.z), 'still near home, because it spent the time turning').toBeLessThan(0.6)
  })

  it('does not chase a corpse, which used to make it orbit a body until it respawned', () => {
    const at = run(scene(), [peer(1000, vec3(0, 0, 15), false)], 60)
    expect(at.position.z).toBeCloseTo(0, 6)
  })

  it('leaves a dying target for whoever is still running', () => {
    // The one further through the zone is dead, so the live one behind them is the target: the boss should
    // come out to z = 6 rather than sit still or head for the body.
    const at = run(
      scene({ speed: 6 }),
      [peer(1000, vec3(0, 0, 18), false), peer(1001, vec3(0, 0, 15), true)],
      60,
    )
    expect(at.position.z).toBeCloseTo(6, 1)
  })

  it('settles on its target instead of overshooting and swinging back', () => {
    // Parked 4 m away at 6 m/s: after two seconds it has long since arrived, and must be sitting on the
    // target rather than oscillating through it.
    const target = vec3(0, 0, 4)
    const near = run(scene({ speed: 6 }), [peer(1000, target)], 120)
    expect(Math.hypot(near.position.x - target.x, near.position.z - target.z)).toBeLessThan(0.15)
  })

  it('stays at its authored height, so it never chases anyone upward', () => {
    const at = run(scene(), [peer(1000, vec3(0, 40, 15))], 60)
    expect(at.position.y).toBeCloseTo(0, 6)
  })

  it('does nothing at all when its zone reference is broken', () => {
    const nodes = scene()
    nodes[0]!.components = [comp('b0', Boss.type, { zone: { node: 'nope', component: 'z0' }, speed: 6, turn: 3600 })]
    const at = run(nodes, [peer(1000, vec3(0, 0, 15))], 60)
    expect(at.position.z).toBeCloseTo(0, 6)
  })

  it('does nothing when its zone names a collider the zone does not have', () => {
    const nodes = scene()
    nodes[0]!.components = [comp('b0', Boss.type, { zone: { node: 'zone', component: 'gone' }, speed: 6, turn: 3600 })]
    const at = run(nodes, [peer(1000, vec3(0, 0, 15))], 60)
    expect(at.position.z).toBeCloseTo(0, 6)
  })

  // The old shape, a bare node id, reads as that node's first Collider until the box's content is migrated.
  it('still reads a zone saved as a node id', () => {
    const nodes = scene()
    nodes[0]!.components = [comp('b0', Boss.type, { zone: 'zone', speed: 6, turn: 3600 })]
    const at = run(nodes, [peer(1000, vec3(0, 0, 15))], 30)
    expect(at.position.z).toBeGreaterThan(0.5)
  })

  it('uses the collider it names, not the node’s first', () => {
    const nodes = scene()
    nodes[1]!.components = [
      comp('z1', COLLIDER, { shape: { kind: 'ball', radius: 1 }, center: vec3(0, 0, 0), trigger: true }),
      ...nodes[1]!.components,
    ]
    const at = run(nodes, [peer(1000, vec3(0, 0, 15))], 30)
    expect(at.position.z, 'the box, second on the node').toBeGreaterThan(0.5)
  })
})

describe('ctx.players()', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  /**
   * Read through the shipped path rather than a stub component: the Boss only moves when it can see somebody
   * in its zone, so "it moved" is the observable proof that the list arrived and held who it should.
   */
  it('holds the local player and its peers, and is self-only with no network', () => {
    expect(run(scene(), [], 60, vec3(0, 0, 15)).position.z, 'saw itself').toBeGreaterThan(1)
    expect(run(scene(), [peer(1000, vec3(0, 0, 15))], 60).position.z, 'saw a peer').toBeGreaterThan(1)
    expect(run(scene(), [], 60).position.z, 'saw nobody').toBeCloseTo(0, 6)
  })
})

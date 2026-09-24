import { vec3, type Vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics, type PhysicsWorld } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { instantiateLevel } from './loader'
import { COLLIDER, LIGHT, RENDERER, type TypeInfo } from './nodes'
import type { Stage, Step, Timing } from './sequence'
import { SEQUENCE } from './sequenceData'
import type { ComponentData, Level, Node } from './types'

/**
 * The loader running sequences (ADR 0137): every channel reaching what the game draws and collides with, both
 * clocks, the riding base, and tick slicing.
 */

const TYPES: TypeInfo = { get: (type) => (type === COLLIDER || type === SEQUENCE ? {} : { singleton: true }) }
const comp = (id: string, type: string, params: Record<string, unknown> = {}): ComponentData => ({ id, type, params })
const solidBox = (id: string, half = 0.5): ComponentData[] => [comp(`${id}-col`, COLLIDER, { shape: { kind: 'box', halfExtents: vec3(half, half, half) } }), comp(`${id}-vis`, RENDERER, { material: '' })]
const secs = (seconds: number): Timing => ({ by: 'seconds', seconds })

let n = 0
const id = (): string => `s${++n}`
const move = (to: Vec3, seconds: number, target?: string): Step => ({ id: id(), kind: 'move', to, timing: secs(seconds), ease: 'linear', ...(target === undefined ? {} : { target }) })
const wait = (seconds: number): Step => ({ id: id(), kind: 'wait', seconds })
const stage = (...steps: Step[]): Stage => ({ id: id(), steps })
const sequence = (stages: Stage[], over: Record<string, unknown> = {}): ComponentData =>
  comp(id(), SEQUENCE, { name: '', clock: 'shared', axes: 'object', loop: 'restart', times: 0, offset: 0, stages, ...over })

const node = (nid: string, components: ComponentData[], extra: Partial<Node> = {}): Node => ({ id: nid, transform: { position: vec3(0, 0, 0) }, components, ...extra })
const levelOf = (nodes: Node[], prefabs?: Record<string, Node>): Level => ({ id: 'fx', config: {}, ...(prefabs === undefined ? {} : { prefabs }), nodes })

let world: PhysicsWorld
const load = (level: Level): ReturnType<typeof instantiateLevel> => {
  world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
  return instantiateLevel(world, level, TYPES)
}
/** Does a small ball dropped from high above the origin land on anything? */
const somethingBelow = (x = 0): boolean => world.castSphere({ origin: vec3(x, 20, 0), direction: vec3(0, -1, 0), maxDistance: 40, radius: 0.05 }) !== undefined
/** How far a ball travelling along +x from far left gets before it hits something. */
const reachFromLeft = (): number | undefined => world.castSphere({ origin: vec3(-20, 0, 0), direction: vec3(1, 0, 0), maxDistance: 40, radius: 0.05 })?.distance

beforeAll(async () => {
  await initPhysics()
})

describe('position', () => {
  it('moves the object’s collider and what is drawn', () => {
    const loaded = load(levelOf([node('p', [...solidBox('p'), sequence([stage(move(vec3(0, 4, 0), 2)), stage(wait(1))])])]))
    loaded.update(1000)
    expect(loaded.visuals[0]!.position).toEqual(vec3(0, 2, 0))
    expect(loaded.basePose(loaded.nodes[0]!.colliderHandles[0]!)?.position).toEqual(vec3(0, 2, 0))
  })

  it('moves a child a step aims at, and leaves the parent where it is', () => {
    const loaded = load(
      levelOf([node('door', [...solidBox('door'), sequence([stage(move(vec3(-3, 0, 0), 1, 'left')), stage(wait(1))])], { children: [node('left', solidBox('left'))] })]),
    )
    loaded.update(1000)
    expect(loaded.visuals.map((v) => v.position)).toEqual([vec3(0, 0, 0), vec3(-3, 0, 0)])
  })

  /** Targets are prefab ids inside a placement, which is where the door's halves are. */
  it('moves a placement’s inherited child from the prefab root’s sequence', () => {
    const prefab = node('root', [sequence([stage(move(vec3(0, 0, 5), 1, 'half')), stage(wait(1))])], { children: [node('half', solidBox('half'))] })
    const loaded = load(levelOf([{ id: 'placed', transform: { position: vec3(10, 0, 0) }, components: [], prefab: 'door' }], { door: prefab }))
    loaded.update(1000)
    expect(loaded.visuals[0]!.position).toEqual(vec3(10, 0, 5))
  })
})

describe('collider on and off', () => {
  it('switches the body off and on, and nothing below finds it while it is off', () => {
    const loaded = load(
      levelOf([node('p', [...solidBox('p'), sequence([stage(wait(1)), stage({ id: id(), kind: 'collider', on: false }), stage(wait(1))])])]),
    )
    loaded.update(500)
    expect(somethingBelow()).toBe(true)
    loaded.update(1500)
    expect(somethingBelow()).toBe(false)
    expect(loaded.visuals[0]!.visible, 'switching the collider off leaves it drawn').toBe(true)
  })

  /** The fading platform: its first stage switches the collider off, so it is built off. */
  it('is built the way level time 0 has it', () => {
    load(levelOf([node('p', [...solidBox('p'), sequence([stage({ id: id(), kind: 'collider', on: false }), stage(wait(2))])])]))
    expect(somethingBelow()).toBe(false)
  })
})

describe('enable and disable', () => {
  it('takes the node and its branch out: not drawn, not solid, its light off', () => {
    const loaded = load(
      levelOf([
        node('p', [...solidBox('p'), comp('lamp', LIGHT, { kind: 'point' }), sequence([stage(wait(1)), stage({ id: id(), kind: 'enabled', on: false }), stage(wait(1))])], {
          children: [node('kid', solidBox('kid'), { transform: { position: vec3(4, 0, 0) } })],
        }),
      ]),
    )
    loaded.update(1500)
    expect(loaded.visuals.map((v) => v.visible)).toEqual([false, false])
    expect(loaded.lights[0]!.visible).toBe(false)
    expect(somethingBelow(0)).toBe(false)
    expect(somethingBelow(4), 'the child goes with it').toBe(false)
    loaded.update(2500) // the next pass: back as it was set up
    expect(loaded.visuals.map((v) => v.visible)).toEqual([true, true])
    expect(somethingBelow(4)).toBe(true)
  })
})

describe('fade', () => {
  it('marks the visual as fadeable at load and sets its opacity per tick', () => {
    const loaded = load(levelOf([node('p', [...solidBox('p'), sequence([stage({ id: id(), kind: 'fade', to: 0, timing: secs(2), ease: 'linear' }), stage(wait(1))])])]))
    expect(loaded.visuals[0]!.fades).toBe(true)
    loaded.update(1000)
    expect(loaded.visuals[0]!.opacity).toBeCloseTo(0.5, 9)
  })

  it('leaves a visual nothing fades alone', () => {
    const loaded = load(levelOf([node('p', solidBox('p'))]))
    expect(loaded.visuals[0]!.fades).toBe(false)
    expect(loaded.visuals[0]!.opacity).toBe(1)
  })
})

describe('scale', () => {
  const growing = (): Level => levelOf([node('p', [...solidBox('p'), sequence([stage({ id: id(), kind: 'scale', to: vec3(3, 1, 1), timing: secs(2), ease: 'linear' }), stage(wait(1))])])])

  it('re-shapes the collider as it grows', () => {
    const loaded = load(growing())
    expect(reachFromLeft()).toBeCloseTo(20 - 0.5 - 0.05, 3)
    loaded.update(2000)
    expect(reachFromLeft(), 'three times as wide: its face is at x = -1.5').toBeCloseTo(20 - 1.5 - 0.05, 3)
  })

  it('stretches what is drawn by how far it has grown since it was built', () => {
    const loaded = load(growing())
    loaded.update(1000)
    expect(loaded.visuals[0]!.drawScale).toEqual(vec3(2, 1, 1))
  })

  it('grows a child with it, collider and all', () => {
    const loaded = load(
      levelOf([
        node('p', [sequence([stage({ id: id(), kind: 'scale', to: vec3(2, 2, 2), timing: secs(1), ease: 'linear' }), stage(wait(1))])], {
          children: [node('kid', solidBox('kid'), { transform: { position: vec3(1, 0, 0) } })],
        }),
      ]),
    )
    loaded.update(1000)
    expect(loaded.visuals[0]!.position, 'its offset from the parent doubles').toEqual(vec3(2, 0, 0))
    expect(loaded.visuals[0]!.drawScale).toEqual(vec3(2, 2, 2))
    world.step(1 / 30) // a kinematic body reaches its posed place on the step, as it does every tick in the game
    expect(reachFromLeft(), 'at x = 2 and twice as wide: its face is at x = 1').toBeCloseTo(20 + 2 - 1 - 0.05, 3)
  })
})

describe('render', () => {
  it('interpolates the stretch and the fade between ticks, like the pose', () => {
    const loaded = load(
      levelOf([
        node('p', [
          ...solidBox('p'),
          sequence([stage({ id: id(), kind: 'scale', to: vec3(3, 1, 1), timing: secs(2), ease: 'linear' }, { id: id(), kind: 'fade', to: 0, timing: secs(2), ease: 'linear' }), stage(wait(1))]),
        ]),
      ]),
    )
    loaded.update(0)
    loaded.update(1000)
    loaded.render(0.5)
    expect(loaded.visuals[0]!.drawScale.x).toBeCloseTo(1.5, 9)
    expect(loaded.visuals[0]!.opacity).toBeCloseTo(0.75, 9)
  })
})

describe('the two clocks', () => {
  const lifter = (clock: string): Level => levelOf([node('p', [...solidBox('p'), sequence([stage(move(vec3(0, 10, 0), 10)), stage(wait(1))], { clock })])])

  it('runs a shared sequence on the room’s clock', () => {
    const loaded = load(lifter('shared'))
    loaded.update(3000)
    expect(loaded.visuals[0]!.position.y).toBeCloseTo(3, 9)
  })

  /** Local counts from the first instant this screen posed the level: a late joiner starts it from the top. */
  it('runs a local sequence from when this screen started', () => {
    const loaded = load(lifter('local'))
    loaded.update(3000)
    expect(loaded.visuals[0]!.position.y).toBeCloseTo(0, 9)
    loaded.update(4000)
    expect(loaded.visuals[0]!.position.y).toBeCloseTo(1, 9)
  })
})

describe('the riding base', () => {
  it('is offered on the wire for a piece a shared sequence moves', () => {
    const loaded = load(levelOf([node('p', [...solidBox('p'), sequence([stage(move(vec3(0, 3, 0), 1)), stage(wait(1))])])]))
    expect(loaded.baseIndex(loaded.nodes[0]!.colliderHandles[0]!)).toBe(0)
  })

  /** Another screen has it somewhere else, so a position relative to it would be wrong there. */
  it('is withheld for a piece a local sequence moves — but it can still be ridden here', () => {
    const loaded = load(levelOf([node('p', [...solidBox('p'), sequence([stage(move(vec3(0, 3, 0), 1)), stage(wait(1))], { clock: 'local' })])]))
    const handle = loaded.nodes[0]!.colliderHandles[0]!
    expect(loaded.baseIndex(handle)).toBeUndefined()
    expect(loaded.basePose(handle)).toBeDefined()
  })

  it('is still offered for a piece a local sequence only fades: its pose is the same everywhere', () => {
    const loaded = load(levelOf([node('p', [...solidBox('p'), sequence([stage({ id: id(), kind: 'fade', to: 0, timing: secs(1), ease: 'linear' }), stage(wait(1))], { clock: 'local' })])]))
    expect(loaded.baseIndex(loaded.nodes[0]!.colliderHandles[0]!)).toBe(0)
  })
})

describe('tick slicing (ADR 0104)', () => {
  it('slices a tick in which a sequence moves something too far to be ridden', () => {
    const loaded = load(levelOf([node('p', [...solidBox('p'), sequence([stage(move(vec3(0, 60, 0), 1)), stage(wait(1))])])]))
    // 60 m/s for a 33 ms tick is 2 m: past a 1 m allowance, so two slices at least.
    expect(loaded.motionSlices(0, 1000 / 30, 1)).toBe(2)
    expect(loaded.motionSlices(1100, 1100 + 1000 / 30, 1), 'during the wait nothing moves').toBe(1)
  })
})

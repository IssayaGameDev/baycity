import { vec3, type Vec3 } from '@mp/core'
import { createPhysicsWorld, DEFAULT_FRICTION, initPhysics, type PhysicsWorld } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { instantiateLevel } from './loader'
import { COUNTDOWN } from './countdown'
import { COLLIDER, COLLIDER_FRICTION, LIGHT, RENDERER, TEXT, type TypeInfo } from './nodes'
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

/** A `Text` rides its node as a light does (ADR 0189), and fades and switches off with it. */
describe('text', () => {
  it('is surfaced where its node stands, and rides the node’s sequence', () => {
    const fade: Step = { id: id(), kind: 'fade', to: 0, timing: secs(1), ease: 'linear' }
    const loaded = load(
      levelOf([node('sign', [comp('t', TEXT, { text: 'Exit', size: 2 }), sequence([stage(move(vec3(0, 4, 0), 2)), stage(fade), stage(wait(5))])], { transform: { position: vec3(1, 0, 0) } })]),
    )
    expect(loaded.texts).toHaveLength(1)
    const text = loaded.texts[0]!
    expect([text.text, text.size, text.node]).toEqual(['Exit', 2, 'sign'])
    expect(text.position).toEqual(vec3(1, 0, 0))
    loaded.update(1000)
    loaded.render(1)
    expect(text.position).toEqual(vec3(1, 2, 0))
    loaded.update(2500)
    loaded.render(1)
    expect(text.opacity).toBeCloseTo(0.5, 6)
  })

  it('switches off with its node', () => {
    const loaded = load(levelOf([node('sign', [comp('t', TEXT, {}), sequence([stage(wait(1)), stage({ id: id(), kind: 'enabled', on: false }), stage(wait(5))])])]))
    loaded.update(500)
    expect(loaded.texts[0]!.visible).toBe(true)
    loaded.update(1500)
    expect(loaded.texts[0]!.visible).toBe(false)
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

  /** The jitter (ADR 0185): a later slice moved where the frame blends from, so a frame spanned only the last slice. */
  it('draws a sliced tick blended from where the tick began, not from its last slice', () => {
    const loaded = load(levelOf([node('p', [...solidBox('p'), sequence([stage(move(vec3(0, 60, 0), 1)), stage(wait(1))])])]))
    const tick = 1000 / 30
    loaded.update(0)
    loaded.update(tick / 2, undefined, true)
    loaded.update(tick, undefined, false)
    loaded.render(0.5)
    // Halfway through a tick in which it rose 2 m from 0: 1 m. Blended from the last slice it would be 1.5 m.
    expect(loaded.visuals[0]!.position.y).toBeCloseTo(1, 6)
    loaded.render(1)
    expect(loaded.visuals[0]!.position.y).toBeCloseTo(2, 6)
  })
})

/**
 * A sequence through the frame tree: what the loader adds to the engine's maths (`sequence.test.ts`) — a
 * kinematic body and a place in the per-tick pass, the subtree carried, a metre kept a metre whatever a parent
 * is scaled to (ADR 0106), and a node with nothing to do costing what a still one always did.
 */
describe('through the frame tree', () => {
  /** The drawn position after posing the world at `nowMs`. `render(1)` lands exactly on the tick. */
  const drawnAt = (loaded: ReturnType<typeof load>, nowMs: number, which = 0): Vec3 => {
    loaded.update(nowMs)
    loaded.render(1)
    return loaded.visuals[which]!.position
  }
  /** Out to `to` in `seconds`, then a second's rest there, so the end of the move is not the end of a pass. */
  const out = (to: Vec3, seconds: number): Stage[] => [stage(move(to, seconds)), stage(wait(1))]
  const turned = (quarterAboutZ: boolean): Partial<Node> => ({ transform: { position: vec3(0, 0, 0), ...(quarterAboutZ ? { rotation: vec3(0, 0, Math.PI / 2) } : {}) } })

  it('carries the node out and back, and starts each pass from where it was placed', () => {
    const loaded = load(levelOf([node('p', [...solidBox('p'), sequence([stage(move(vec3(0, 3, 0), 2)), stage(move(vec3(0, 0, 0), 2))])])]))
    expect(drawnAt(loaded, 0).y).toBeCloseTo(0, 6)
    expect(drawnAt(loaded, 2000).y).toBeCloseTo(3, 6)
    expect(drawnAt(loaded, 3000).y).toBeCloseTo(1.5, 6)
    expect(drawnAt(loaded, 4000).y).toBeCloseTo(0, 6)
  })

  it('carries its children, so a subtree rides its parent', () => {
    const loaded = load(levelOf([node('p', [...solidBox('p'), sequence(out(vec3(0, 3, 0), 2))], { children: [node('kid', solidBox('kid'), { transform: { position: vec3(0, 1, 0) } })] })]))
    expect(drawnAt(loaded, 2000, 0).y).toBeCloseTo(3, 6)
    expect(drawnAt(loaded, 2000, 1).y, 'the child sits 1 m up, on a deck 3 m up').toBeCloseTo(4, 6)
  })

  it('turns, without moving its place', () => {
    // Read off a collider offset, which a turn swings round.
    const offset = [comp('c', COLLIDER, { shape: { kind: 'box', halfExtents: vec3(0.5, 0.5, 0.5) }, center: vec3(2, 0, 0) }), comp('r', RENDERER, { material: '' })]
    const quarter: Step = { id: id(), kind: 'turn', axis: vec3(0, 1, 0), angle: 90, timing: secs(1), ease: 'linear' }
    const at = drawnAt(load(levelOf([node('p', [...offset, sequence([stage(quarter), stage(wait(1))])])])), 1000)
    expect(at.x).toBeCloseTo(0, 6)
    expect(at.z, 'a quarter turn about +Y swings +X round to -Z').toBeCloseTo(-2, 6)
  })

  it('adds two sequences on one node, each playing its own stages', () => {
    const loaded = load(levelOf([node('p', [...solidBox('p'), sequence(out(vec3(0, 4, 0), 2)), sequence(out(vec3(4, 0, 0), 1))])]))
    const at = drawnAt(loaded, 1000)
    expect(at.y, 'halfway up').toBeCloseTo(2, 6)
    expect(at.x, 'and all the way across').toBeCloseTo(4, 6)
  })

  it('moves the metres written, under a scaled parent', () => {
    for (const scale of [vec3(2, 2, 2), vec3(2, 1, 1), vec3(0.5, 3, 0.25)]) {
      const loaded = load(levelOf([node('holder', [], { transform: { position: vec3(0, 0, 0), scale }, children: [node('lift', [...solidBox('lift'), sequence(out(vec3(0, 3, 0), 0.5))])] })]))
      expect(drawnAt(loaded, 500).y, `scale ${scale.x},${scale.y},${scale.z}`).toBeCloseTo(3, 6)
    }
  })

  it('keeps a diagonal pointing where it was written, under a parent stretched on one axis', () => {
    const loaded = load(levelOf([node('holder', [], { transform: { position: vec3(0, 0, 0), scale: vec3(4, 1, 1) }, children: [node('lift', [...solidBox('lift'), sequence(out(vec3(3, 3, 0), 0.5))])] })]))
    const at = drawnAt(loaded, 500)
    expect(at.x, 'x is not stretched by the parent').toBeCloseTo(3, 5)
    expect(at.y).toBeCloseTo(3, 5)
  })

  it('moves along the object’s own axes, or along the level’s', () => {
    // Turned a quarter about +Z: the object's own +Y now points along the level's -X.
    const lift = (axes: string): Vec3 => drawnAt(load(levelOf([node('lift', [...solidBox('lift'), sequence(out(vec3(0, 3, 0), 0.5), { axes })], turned(true))])), 500)
    expect(lift('object').x, 'its own up is the level’s -X').toBeCloseTo(-3, 5)
    expect(lift('object').y).toBeCloseTo(0, 5)
    expect(lift('level').y, 'the level’s up whatever it is turned to').toBeCloseTo(3, 5)
    expect(lift('level').x).toBeCloseTo(0, 5)
  })

  it('keeps level axes level under a turned parent, and turns object axes with it', () => {
    const lift = (axes: string): Vec3 =>
      drawnAt(load(levelOf([node('holder', [], { ...turned(true), children: [node('lift', [...solidBox('lift'), sequence(out(vec3(0, 3, 0), 0.5), { axes })])] })])), 500)
    expect(lift('level').y).toBeCloseTo(3, 5)
    expect(lift('level').x).toBeCloseTo(0, 5)
    expect(lift('object').x, 'the parent’s up is the level’s -X').toBeCloseTo(-3, 5)
  })

  it('leaves a node whose sequence does nothing out of the per-tick pass', () => {
    const loaded = load(levelOf([node('p', [...solidBox('p'), sequence([])])]))
    expect(loaded.basePose(loaded.nodes[0]!.colliderHandles[0]!), 'a fixed body, as before any sequence').toBeUndefined()
    expect(drawnAt(loaded, 2000).y).toBeCloseTo(0, 9)
  })

  it('leaves a still or gentle level at one slice, so nothing else pays for slicing', () => {
    expect(load(levelOf([node('p', solidBox('p'))])).motionSlices(0, 1000, 1)).toBe(1)
    const easy: Step = { id: id(), kind: 'move', to: vec3(0, 3, 0), timing: { by: 'speed', speed: 1.5 }, ease: 'in-out-sine' }
    expect(load(levelOf([node('p', [...solidBox('p'), sequence([stage(easy)])])])).motionSlices(0, 1000 / 30, 1)).toBe(1)
  })

  it('caps the slice count, because past a point no tick rate makes a deck rideable', () => {
    const silly = load(levelOf([node('p', [...solidBox('p'), sequence(out(vec3(0, 400, 0), 0.5))])]))
    expect(silly.motionSlices(0, 1000 / 30, 1)).toBe(8)
    expect(silly.motionSlices(0, 1000 / 30, 0), 'a nonsense allowance asks for nothing').toBe(1)
  })

  it('stops when the component is switched off', () => {
    const loaded = load(levelOf([node('p', [...solidBox('p'), { ...sequence(out(vec3(0, 3, 0), 2)), enabled: false }])]))
    expect(drawnAt(loaded, 2000).y).toBeCloseTo(0, 9)
  })
})

describe('a restart (ADR 0206)', () => {
  it('is drawn at the start at once, carries nobody, and leaves the body with no speed', () => {
    const loaded = load(levelOf([node('wall', [...solidBox('wall'), sequence([stage(move(vec3(10, 0, 0), 1))])])]))
    const handle = loaded.nodes[0]!.colliderHandles[0]!
    loaded.update(900)
    loaded.update(1100)
    loaded.render(0.5)
    expect(loaded.visuals[0]!.position.x, 'not halfway back along the path').toBeCloseTo(1, 6)
    expect(loaded.baseCarry(loaded.baseIndex(handle)!, vec3(0, 0.5, 0))).toEqual(vec3(0, 0, 0))
    expect(loaded.motionSlices(900, 1100, 0.5), 'the jump needs no slicing').toBeLessThanOrEqual(2)
  })

  it('moves on as before on the ticks after', () => {
    const loaded = load(levelOf([node('wall', [...solidBox('wall'), sequence([stage(move(vec3(10, 0, 0), 1))])])]))
    loaded.update(900)
    loaded.update(1100)
    loaded.update(1300)
    loaded.render(0.5)
    expect(loaded.visuals[0]!.position.x, 'blending again').toBeCloseTo(2, 6)
  })
})

/** A model is drawn at its node's pivot, wherever its colliders sit (ADR 0207) — as the editor draws it. */
describe('a model and its colliders', () => {
  const MODEL = 'aaaaaaaaaaaaaaaa'
  const offCentre = (): ComponentData[] => [
    comp('col', COLLIDER, { shape: { kind: 'box', halfExtents: vec3(0.5, 0.5, 0.5) }, center: vec3(2, 0, 0) }),
    comp('vis', RENDERER, { model: MODEL }),
  ]

  it('sits on the pivot, not on a collider’s centre, while the collider keeps its own', () => {
    const loaded = load(levelOf([node('prop', offCentre(), { transform: { position: vec3(5, 0, 0) } })]))
    expect(loaded.visuals[0]!.position).toEqual(vec3(5, 0, 0))
    expect(loaded.basePose(loaded.nodes[0]!.colliderHandles[0]!), 'a still body has no pose to report').toBeUndefined()
    // The collider two metres along, at x = 7: its face at 6.5, 26.5 m from where the ball starts, less its radius.
    expect(reachFromLeft()).toBeCloseTo(26.45, 2)
  })

  it('follows the pivot as a sequence moves it, and the collider rides two metres off', () => {
    const loaded = load(levelOf([node('prop', [...offCentre(), sequence([stage(move(vec3(0, 4, 0), 2)), stage(wait(1))])], { transform: { position: vec3(5, 0, 0) } })]))
    loaded.update(1000)
    loaded.render(1)
    expect(loaded.visuals[0]!.position).toEqual(vec3(5, 2, 0))
    expect(loaded.basePose(loaded.nodes[0]!.colliderHandles[0]!)?.position).toEqual(vec3(7, 2, 0))
  })
})

/** A sign counting down to a platform's stages (ADR 0228), on the clock the platform is posed at. */
describe('a countdown', () => {
  const fadeIn: Step = { id: 'in', kind: 'fade', to: 1, timing: secs(1), ease: 'linear' }
  const fadeOut: Step = { id: 'out', kind: 'fade', to: 0, timing: secs(1), ease: 'linear' }
  const platform = (): Node => node('platform', [...solidBox('platform'), comp('seq', SEQUENCE, { name: '', clock: 'shared', axes: 'object', loop: 'restart', times: 0, offset: 0, stages: [stage(wait(5)), stage(fadeIn), stage(wait(3)), stage(fadeOut)] })])
  const sign = (sequenceRef: unknown): Node =>
    node('sign', [comp('t', TEXT, { text: 'Watch the platform' }), comp('cd', COUNTDOWN, { sequence: sequenceRef, rows: [{ stage: 2, text: 'Appears in {t}' }, { stage: 4, text: 'Gone in {t}' }] })])

  it('says the next stage’s words as the level runs, on its sequence’s clock', () => {
    const loaded = load(levelOf([platform(), sign({ node: 'platform', component: 'seq' })]))
    const text = loaded.texts[0]!
    loaded.update(0)
    expect(text.text).toBe('Appears in 5.0')
    loaded.update(4950)
    expect(text.text).toBe('Appears in 0.1')
    loaded.update(6000)
    expect(text.text).toBe('Gone in 3.0')
  })

  it('says the Text’s own words with nothing to count on', () => {
    const loaded = load(levelOf([platform(), sign(null)]))
    loaded.update(1000)
    expect(loaded.texts[0]!.text).toBe('Watch the platform')
  })
})

/** What a surface is made of (ADR 0229): a Collider's friction and bounciness on the body the player stands on. */
describe('a surface', () => {
  const floor = (params: Record<string, unknown>): Node => node('floor', [comp('fc', COLLIDER, { shape: { kind: 'box', halfExtents: vec3(5, 0.5, 5) }, ...params })])
  const groundOf = (level: Level) => {
    load(level)
    return world.addCharacter({ position: vec3(0, 1.6, 0), radius: 0.4, halfHeight: 0.6 }).probeGround()
  }

  it('is what its Collider says, and Rapier’s own where it says nothing — the number content and physics both call the default', () => {
    expect(groundOf(levelOf([floor({ friction: 0.1, bounciness: 0.6 })]))).toMatchObject({ friction: expect.closeTo(0.1, 6), restitution: expect.closeTo(0.6, 6) })
    expect(groundOf(levelOf([floor({})]))).toMatchObject({ friction: DEFAULT_FRICTION, restitution: 0 })
    expect(COLLIDER_FRICTION).toBe(DEFAULT_FRICTION)
  })
})

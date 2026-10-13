import { characterAccess, createComponentRuntime, Hazard } from '@mp/components'
import { instantiateLevel, TEXT, type ComponentData, type Level, type LoadedLevel, type Node, type WorldNode } from '@mp/content'
import { vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics } from '@mp/physics'

import { beforeAll, describe, expect, it } from 'vitest'

import type { Teleport } from '@mp/mode'

import { KEYBOARD_REGISTRY, STAND_OFFSET, keyboardSession, type KeyboardTeleport } from './rules'
import { StageGate } from './components/stageGate'
import { checkpointsOf, Obstacle, requiresLevelText, shownText } from './components/obstacle'
import { qualifies, StepPad } from './components/stepPad'
import { stepsThisTick } from './components/steps'
import { DEFAULT_CURVE, stepsPerMinute } from './progression'
import { Treadmill, treadmillStepValue } from './components/treadmill'
import { WinsPad, padTop } from './components/wins'

/**
 * Keyboard Escape's rules (ADR 0073): a stage ends on a `WinsPad`, which pays out and sends you back to the
 * spawn. Falling also sends you to the spawn. Nothing else moves the player.
 */

const comp = (id: string, type: string, params: Record<string, unknown> = {}): ComponentData => ({ id, type, params })
const box = (half = 0.5): Record<string, unknown> => ({ shape: { kind: 'box', halfExtents: vec3(half, half, half) } })

/** A node that can be stood on, optionally carrying a rule. */
const pad = (id: string, at: number, rule?: ComponentData): Node => ({
  id,
  transform: { position: vec3(at, 0, 0) },
  components: [comp(`${id}-c`, 'Collider', box()), comp(`${id}-r`, 'Renderer', {}), ...(rule === undefined ? [] : [rule])],
})

const spawnAt = (x: number): Node => ({ id: 'm', transform: { position: vec3(x, 0, 0) }, components: [comp('s', 'Spawn')] })

const levelOf = (nodes: Node[]): Level => ({ id: 'fx', config: { mode: { name: 'keyboard' } }, nodes })

const load = (nodes: Node[]): LoadedLevel =>
  instantiateLevel(createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } }), levelOf(nodes), KEYBOARD_REGISTRY)

const nodeById = (loaded: LoadedLevel, id: string) => loaded.nodes.find((n) => n.id === id)!

describe('keyboard cash-out', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  const oneStage = (): LoadedLevel => load([spawnAt(0), pad('board', 5), pad('end', 10, comp('w', WinsPad.type, { wins: 7 }))])

  it('pays the pad’s wins and teleports to the spawn, once', () => {
    const loaded = oneStage()
    const paid: number[] = []
    const rules = keyboardSession(loaded, { onCashOut: (wins) => paid.push(wins) })
    rules.effects.progress(nodeById(loaded, 'end'))
    expect(paid).toEqual([7])
    expect(rules.takeTeleport!(), 'to the spawn, facing as you were').toEqual({ position: vec3(0, STAND_OFFSET, 0) })
    expect(rules.takeTeleport!(), 'consumed').toBeNull()
  })

  // Standing on the pad reports a contact every tick until the teleport lands; that is one cash-out, not many.
  it('does not pay twice while the teleport is still pending', () => {
    const loaded = oneStage()
    const paid: number[] = []
    const rules = keyboardSession(loaded, { onCashOut: (wins) => paid.push(wins) })
    rules.effects.progress(nodeById(loaded, 'end'))
    rules.effects.progress(nodeById(loaded, 'end'))
    expect(paid).toEqual([7])
    rules.takeTeleport!()
    // Back on the pad after the teleport (a second run) pays again.
    rules.effects.progress(nodeById(loaded, 'end'))
    expect(paid).toEqual([7, 7])
  })

  it('ignores a node that is not a pad', () => {
    const loaded = oneStage()
    const paid: number[] = []
    const rules = keyboardSession(loaded, { onCashOut: (wins) => paid.push(wins) })
    rules.effects.progress(nodeById(loaded, 'board'))
    expect(paid).toEqual([])
    expect(rules.takeTeleport!()).toBeNull()
  })

  it('defaults a pad with no wins set to 1', () => {
    const loaded = load([spawnAt(0), pad('end', 10, comp('w', WinsPad.type))])
    const paid: number[] = []
    keyboardSession(loaded, { onCashOut: (wins) => paid.push(wins) }).effects.progress(nodeById(loaded, 'end'))
    expect(paid).toEqual([1])
  })

  it('reports the pad’s top face, not its centre, for a popup to leave from', () => {
    const loaded = load([{ id: 'p', transform: { position: vec3(1, 2, 3) }, components: [comp('c', 'Collider', box(0.25)), comp('w', WinsPad.type)] }])
    expect(padTop(nodeById(loaded, 'p'))).toEqual(vec3(1, 2.25, 3))
  })
})

describe('keyboard death', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  // No checkpoints, by design: wherever you die, the spawn is where you come back.
  it('respawns at the spawn, after any amount of progress', () => {
    const loaded = load([spawnAt(2), pad('end', 10, comp('w', WinsPad.type)), pad('plane', 0, comp('h', Hazard.type))])
    const rules = keyboardSession(loaded)
    rules.effects.progress(nodeById(loaded, 'end'))
    rules.takeTeleport!()
    rules.effects.kill()
    expect(rules.takeDeath()).toBe(true)
    expect(rules.takeDeath(), 'consumed').toBe(false)
    expect(rules.respawnAt()).toEqual(vec3(2, STAND_OFFSET, 0))
  })

  it('never reports progress, so the client persists nothing through the platform', () => {
    const loaded = load([spawnAt(0), pad('end', 10, comp('w', WinsPad.type))])
    const rules = keyboardSession(loaded, { onProgress: () => expect.unreachable('progress reported') })
    rules.effects.progress(nodeById(loaded, 'end'))
    expect(rules.progress()).toBe(-1)
  })
})

describe('the treadmill (ADR 0080)', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('pays a key’s Experience per step, times the tier', () => {
    expect(treadmillStepValue(1, { multiplier: 1 })).toBe(1)
    expect(treadmillStepValue(1, { multiplier: 9 })).toBe(9)
    expect(treadmillStepValue(2, { multiplier: 25 })).toBe(50)
  })

  it('reports one tick per contact, with the pad’s tier, and never teleports or pays Wins', () => {
    const loaded = load([spawnAt(0), pad('mill', 5, comp('t', Treadmill.type, { multiplier: 9 }))])
    const ticks: { multiplier: number }[] = []
    const paid: number[] = []
    const rules = keyboardSession(loaded, { onTreadmill: (on) => ticks.push(on), onCashOut: (w) => paid.push(w) })
    rules.effects.progress(nodeById(loaded, 'mill'))
    rules.effects.progress(nodeById(loaded, 'mill'))
    expect(ticks).toEqual([{ multiplier: 9 }, { multiplier: 9 }])
    expect(paid).toEqual([])
    expect(rules.takeTeleport!()).toBeNull()
  })

  it('defaults to Chocolate: ×1', () => {
    const loaded = load([spawnAt(0), pad('mill', 5, comp('t', Treadmill.type))])
    const ticks: { multiplier: number }[] = []
    keyboardSession(loaded, { onTreadmill: (on) => ticks.push(on) }).effects.progress(nodeById(loaded, 'mill'))
    expect(ticks).toEqual([{ multiplier: 1 }])
  })
})

describe('a step is a tick of held input, at a cadence set by Level (ADR 0081)', () => {
  // Kodjo's table from the game being cloned: level → steps a minute. The curve is fitted to it, so it is the
  // fixture, with tolerance for a fit rather than a reverse-engineering.
  it('reproduces the measured cadence at every level in the table', () => {
    const table: [number, number][] = [
      [10, 240],
      [20, 240],
      [30, 270],
      [50, 420],
      [85, 540],
      [170, 600],
      [200, 600],
      [300, 600],
    ]
    for (const [level, perMinute] of table) {
      const got = stepsPerMinute(level, DEFAULT_CURVE)
      expect(Math.abs(got - perMinute) / perMinute, `level ${level}: ${got.toFixed(0)} vs ${perMinute}`).toBeLessThan(0.012)
    }
  })

  it('never drops below the floor, and never exceeds the ceiling', () => {
    expect(stepsPerMinute(0, DEFAULT_CURVE)).toBe(240)
    expect(stepsPerMinute(1000, DEFAULT_CURVE)).toBeLessThanOrEqual(600)
    expect(stepsPerMinute(1000, DEFAULT_CURVE)).toBeGreaterThan(599.9)
  })

  it('accrues whenever a direction is held — a wall counts, the air counts, standing still does not', () => {
    // Level 10: 240 a minute, four a second; a quarter second is one step.
    expect(stepsThisTick({ moveX: 0, moveZ: 1 }, 10, DEFAULT_CURVE, 0.25)).toBeCloseTo(1, 9)
    expect(stepsThisTick({ moveX: 0.3, moveZ: 0 }, 10, DEFAULT_CURVE, 0.25)).toBeCloseTo(1, 9)
    expect(stepsThisTick({ moveX: 0, moveZ: 0 }, 10, DEFAULT_CURVE, 0.25)).toBe(0)
    // Level 200: ten a second.
    expect(stepsThisTick({ moveX: 0, moveZ: 1 }, 200, DEFAULT_CURVE, 0.1)).toBeCloseTo(1, 1)
  })
})

describe('stage gates (ADR 0202), listed as checkpoints until replaced', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  const gate = (id: string, x: number, turn = 0): Node => ({ id, transform: { position: vec3(x, 1, 0), rotation: vec3(0, turn, 0) }, components: [comp(`${id}-g`, StageGate.type)] })

  it('lists every gate in Hierarchy order — inside a parent too, collider or not — standing and facing as the node does', () => {
    const area: Node = { id: 'area', transform: { position: vec3(100, 0, 0) }, components: [], children: [gate('inner', 5, Math.PI / 2)] }
    const loaded = load([spawnAt(0), gate('first', 10), area, gate('last', 300)])
    const gates = checkpointsOf(loaded, STAND_OFFSET)
    expect(gates.every((g) => g.alwaysOpen), 'a gate is open without being reached').toBe(true)
    expect(gates.map((g) => [g.number, g.position.x])).toEqual([
      [1, 10],
      [2, 105],
      [3, 300],
    ])
    expect(gates[0]!.position.y).toBeCloseTo(1 + STAND_OFFSET, 9)
    expect(gates[0]!.yaw, 'facing +Z').toBeCloseTo(0, 9)
    expect(gates[1]!.yaw, 'turned a quarter about +Y: facing +X').toBeCloseTo(Math.PI / 2, 9)
  })

  it('is none in a level without one', () => {
    expect(checkpointsOf(load([spawnAt(0), pad('board', 5)]), STAND_OFFSET)).toEqual([])
  })

  it('takes the teleport the game asks for, once, after a cash-out waiting on the same tick', () => {
    const loaded = load([spawnAt(0), gate('g', 50, Math.PI), pad('end', 10, comp('w', WinsPad.type))])
    const [stop] = checkpointsOf(loaded, STAND_OFFSET)
    let asked: Teleport | null = { position: stop!.position, yaw: stop!.yaw }
    const rules = keyboardSession(loaded, {
      requested: () => {
        const t = asked
        asked = null
        return t
      },
    })
    rules.effects.progress(nodeById(loaded, 'end'))
    expect(rules.takeTeleport!(), 'the cash-out first').toEqual({ position: vec3(0, STAND_OFFSET, 0) })
    expect(rules.takeTeleport!(), 'then the gate, facing its way').toEqual({ position: stop!.position, yaw: stop!.yaw })
    expect(rules.takeTeleport!(), 'once').toBeNull()
  })
})

/**
 * The Obstacle (ADR 0211, Kodjo's design): on the InterLevel prefab's root, pointing inside it — where a teleport
 * lands, the trigger that reaches the checkpoint, the pad whose wins it sets, the sign it writes.
 */
describe('obstacles (ADR 0211)', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  const ref = (node: string) => ({ node, component: '' })
  const inter: Node = {
    id: 'inter-root',
    transform: { position: vec3(0, 0, 0) },
    components: [comp('ob', Obstacle.type, { teleport: 'stand', trigger: ref('zone'), winsPad: ref('win'), wins: 10, requiredLevelText: ref('board'), requiredLevel: 3, safeZoneText: ref('safe') })],
    children: [
      { id: 'stand', transform: { position: vec3(0, 1, 5), rotation: vec3(0, Math.PI / 2, 0) }, components: [] },
      { id: 'zone', transform: { position: vec3(0, 1, 10) }, components: [comp('zone-c', 'Collider', { ...box(2), trigger: true })] },
      { id: 'win', transform: { position: vec3(0, 0, 20) }, components: [comp('win-c', 'Collider', box()), comp('win-w', WinsPad.type, { wins: 1 })] },
      { id: 'board', transform: { position: vec3(0, 3, 15) }, components: [comp('board-t', TEXT, { text: 'Text' })] },
      { id: 'safe', transform: { position: vec3(0, 3, 8) }, components: [comp('safe-t', TEXT, { text: 'Safe Zone' })] },
    ],
  }
  const placed = (id: string, x: number, params?: Record<string, unknown>): Node =>
    ({ id, transform: { position: vec3(x, 0, 0) }, components: [], prefab: 'inter', ...(params === undefined ? {} : { overrides: { 'inter-root': { params: { ob: params } } } }) }) as Node
  /** Two placements, the second paying more and asking more; then an obstacle pointing at nothing. */
  const level = (): LoadedLevel =>
    instantiateLevel(
      createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } }),
      {
        ...levelOf([spawnAt(0), placed('a', 100), placed('b', 200, { wins: 25, requiredLevel: 9 }), { id: 'bare', transform: { position: vec3(300, 2, 0) }, components: [comp('bare-o', Obstacle.type)] }]),
        prefabs: { inter },
      },
      KEYBOARD_REGISTRY,
    )
  const copies = (loaded: LoadedLevel, id: string): WorldNode[] => loaded.allNodes.filter((n) => n.id === id)

  it('lists each where its teleport points, facing that way — its own node when it points nowhere — keyed by placement', () => {
    const stops = checkpointsOf(level(), STAND_OFFSET)
    expect(stops.map((s) => [s.number, s.key, s.position.x, s.position.z])).toEqual([
      [1, 'a', 100, 5],
      [2, 'b', 200, 5],
      [3, 'bare', 300, 0],
    ])
    expect(stops[0]!.position.y).toBeCloseTo(1 + STAND_OFFSET, 9)
    expect(stops[0]!.yaw, 'the stand point faces +X').toBeCloseTo(Math.PI / 2, 9)
    expect(stops.some((s) => s.alwaysOpen), 'an obstacle opens once reached').toBe(false)
  })

  it('pays what it says, over the pad’s own, per placement', () => {
    const loaded = level()
    const paid: number[] = []
    for (const win of copies(loaded, 'win')) keyboardSession(loaded, { onCashOut: (wins) => paid.push(wins) }).effects.progress(win)
    expect(paid).toEqual([10, 25])
  })

  it('writes “Requires Level X” on its sign', () => {
    expect(level().texts.filter((t) => t.node === 'board').map((t) => t.text)).toEqual([requiresLevelText(3), requiresLevelText(9)])
    expect(level().texts.filter((t) => t.node === 'safe').map((t) => t.text), 'the safe zone keeps its own words').toEqual(['Safe Zone', 'Safe Zone'])
    expect(requiresLevelText(12)).toBe('Requires Level 12')
  })

  it('is reached by walking into its trigger, and by nothing else', () => {
    const loaded = level()
    const reached: WorldNode[] = []
    const rules = keyboardSession(loaded, { onReached: (node) => reached.push(node) })
    const character = characterAccess({ launch: 0, impulse: vec3(0, 0, 0), vx: 0, vy: 0, vz: 0, carry: vec3(0, 0, 0), grounded: true, body: { translation: () => vec3(0, 0, 0) } })
    const runtime = createComponentRuntime(loaded, KEYBOARD_REGISTRY, { character, effects: rules.effects })
    runtime.attach(0, 0, 1)
    const [zoneA, zoneB] = copies(loaded, 'zone')
    const [winA] = copies(loaded, 'win')
    runtime.contact([winA!.colliderHandles[0]!])
    expect(reached, 'its pad is not its trigger').toEqual([])
    runtime.contact([zoneB!.colliderHandles[0]!])
    runtime.contact([zoneA!.colliderHandles[0]!])
    expect(reached.map((n) => n.id), 'each placement its own').toEqual(['b', 'a'])
  })

  /**
   * Kodjo's calls (ADR 0213): one text shows — the obstacle ahead's Safe zone, its "Requires Level X" inside its
   * trigger — and which one is ahead turns on which side of its trigger you are, along the way its teleport faces.
   */
  it('shows the one text ahead of the player', () => {
    const stops = checkpointsOf(level(), STAND_OFFSET)
    const [a, b, bare] = stops
    expect([a!.safeZoneText?.id, a!.requiredLevelText?.id]).toEqual(['safe', 'board'])
    expect(a!.pivot, 'measured from its trigger').toEqual(vec3(100, 1, 10))
    const shown = (current: WorldNode | null, inside: boolean, x: number) => {
      const s = shownText(stops, current, inside, vec3(x, 0, 10))
      return s === null ? null : [s.stop.key, s.which]
    }
    expect(shown(null, false, 0), 'from the spawn: the first one').toEqual(['a', 'safeZone'])
    expect(shown(a!.node, true, 100), 'inside its trigger').toEqual(['a', 'requiredLevel'])
    expect(shown(a!.node, false, 150), 'out of it, forward: the next').toEqual(['b', 'safeZone'])
    expect(shown(a!.node, false, 90), 'out of it, back: still this one').toEqual(['a', 'safeZone'])
    expect(shown(b!.node, false, 250)).toEqual(['bare', 'safeZone'])
    expect(shown(bare!.node, false, 400), 'nothing ahead of the last').toBeNull()
  })

  /** Kodjo's call (ADR 0212): the obstacle you are on is the last trigger walked into; from the spawn, none. */
  it('knows the obstacle the player is on, and forgets it back at the spawn', () => {
    const loaded = level()
    let asked: KeyboardTeleport | null = null
    const rules = keyboardSession(loaded, {
      requested: () => {
        const t = asked
        asked = null
        return t
      },
    })
    const character = characterAccess({ launch: 0, impulse: vec3(0, 0, 0), vx: 0, vy: 0, vz: 0, carry: vec3(0, 0, 0), grounded: true, body: { translation: () => vec3(0, 0, 0) } })
    const runtime = createComponentRuntime(loaded, KEYBOARD_REGISTRY, { character, effects: rules.effects })
    runtime.attach(0, 0, 1)
    const [a, b] = checkpointsOf(loaded, STAND_OFFSET)
    const [zoneA, zoneB] = copies(loaded, 'zone').map((n) => n.colliderHandles[0]!)
    const [winA] = copies(loaded, 'win')
    expect(rules.currentObstacle(), 'at the start').toBeNull()
    runtime.contact([zoneA!])
    expect(rules.currentObstacle()).toBe(a!.node)
    runtime.contact([zoneB!])
    expect(rules.currentObstacle()).toBe(b!.node)
    runtime.contact([zoneA!])
    expect(rules.currentObstacle(), 'walked back through an earlier one').toBe(a!.node)
    rules.effects.kill()
    expect(rules.takeDeath()).toBe(true)
    expect(rules.currentObstacle(), 'a death').toBeNull()
    runtime.contact([zoneB!])
    rules.effects.progress(winA!)
    expect(rules.currentObstacle(), 'a cash-out').toBeNull()
    rules.takeTeleport!()
    asked = { position: b!.position, yaw: b!.yaw, obstacle: b!.node }
    rules.takeTeleport!()
    expect(rules.currentObstacle(), 'teleported to a checkpoint').toBe(b!.node)
    asked = { position: vec3(0, 0, 0), obstacle: null }
    rules.takeTeleport!()
    expect(rules.currentObstacle(), 'teleported to Start').toBeNull()
    runtime.contact([zoneA!])
    rules.respawnAt()
    expect(rules.currentObstacle(), 'a respawn, or Restart').toBeNull()
  })
})

describe('step pads (ADR 0082)', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('lets you take a pad when your Wins reach what it requires, and not before', () => {
    const pad = { perStep: 5, requiresWins: 15 }
    expect(qualifies(14, pad)).toBe(false)
    expect(qualifies(15, pad)).toBe(true)
    expect(qualifies(0, { perStep: 1, requiresWins: 0 })).toBe(true)
  })

  it('reports the pad’s offer every tick stood on it, and pays no Wins for it', () => {
    const loaded = load([spawnAt(0), pad('sp', 5, comp('p', StepPad.type, { perStep: 25, requiresWins: 100 }))])
    const offers: { perStep: number; requiresWins: number }[] = []
    const paid: number[] = []
    const rules = keyboardSession(loaded, { onStepPad: (o) => offers.push(o), onCashOut: (w) => paid.push(w) })
    rules.effects.progress(nodeById(loaded, 'sp'))
    rules.effects.progress(nodeById(loaded, 'sp'))
    expect(offers).toEqual([
      { perStep: 25, requiresWins: 100 },
      { perStep: 25, requiresWins: 100 },
    ])
    expect(paid).toEqual([])
    expect(rules.takeTeleport!()).toBeNull()
  })

  it('defaults to the free +1 pad', () => {
    const loaded = load([spawnAt(0), pad('sp', 5, comp('p', StepPad.type))])
    const offers: { perStep: number; requiresWins: number }[] = []
    keyboardSession(loaded, { onStepPad: (o) => offers.push(o) }).effects.progress(nodeById(loaded, 'sp'))
    expect(offers).toEqual([{ perStep: 1, requiresWins: 0 }])
  })
})

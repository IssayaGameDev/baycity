import { Hazard } from '@mp/components'
import { instantiateLevel, type ComponentData, type Level, type LoadedLevel, type Node } from '@mp/content'
import { vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics } from '@mp/physics'

import { beforeAll, describe, expect, it } from 'vitest'

import { KEYBOARD_REGISTRY, STAND_OFFSET, keyboardSession } from './rules'
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
    expect(rules.takeTeleport!()).toEqual(vec3(0, STAND_OFFSET, 0))
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

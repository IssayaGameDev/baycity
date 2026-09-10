import { Hazard } from '@mp/components'
import { instantiateLevel, type ComponentData, type Level, type LoadedLevel, type Node } from '@mp/content'
import { vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics } from '@mp/physics'

import { beforeAll, describe, expect, it } from 'vitest'

import { KEYBOARD_REGISTRY, STAND_OFFSET, keyboardSession } from './rules'
import { WinsPad, padTop } from './wins'

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

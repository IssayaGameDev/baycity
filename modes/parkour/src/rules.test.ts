import { Checkpoint, Hazard } from '@mp/components'
import { instantiateLevel, type ComponentData, type Level, type LoadedLevel, type Node } from '@mp/content'
import { vec3 } from '@mp/core'
import { createPhysicsWorld, initPhysics } from '@mp/physics'

import { beforeAll, describe, expect, it } from 'vitest'

import { PARKOUR_REGISTRY, STAND_OFFSET, checkpointsOf, parkourSession, spawnOf } from './rules'

/**
 * Parkour's rules, now that they are a module rather than two hand-written copies (ADR 0052).
 *
 * The bug these exist to stop: `main.ts` and the editor's play-in-place each implemented death, and they had
 * drifted — the editor died on any fall, ignoring the level's fall setting, so a tower killed you in the editor
 * and let you fall in the game. Nothing caught it because neither copy was tested.
 *
 * That setting is gone entirely now (ADR 0053): a kill plane is a `Hazard` on a collider, so death is only
 * ever a rule firing and there is no second path to get wrong.
 */

const comp = (id: string, type: string, params: Record<string, unknown> = {}): ComponentData => ({ id, type, params })
const box = (half = 0.5): Record<string, unknown> => ({ shape: { kind: 'box', halfExtents: vec3(half, half, half) } })

/** A node that can be stood on and touched, optionally carrying a rule. */
const pad = (id: string, at: number, rule?: string): Node => ({
  id,
  transform: { position: vec3(at, 0, 0) },
  components: [comp(`${id}-c`, 'Collider', box()), comp(`${id}-r`, 'Renderer', {}), ...(rule === undefined ? [] : [comp(`${id}-x`, rule)])],
})

const levelOf = (nodes: Node[]): Level => ({ id: 'fx', config: { mode: { name: 'parkour' } }, nodes })

const load = (nodes: Node[]): LoadedLevel =>
  instantiateLevel(createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } }), levelOf(nodes), PARKOUR_REGISTRY)

describe('parkour spawning', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  const withSpawn = (): LoadedLevel =>
    load([pad('ground', 0), { id: 'm', transform: { position: vec3(4, 1, 6) }, components: [comp('s', 'Spawn')] }])

  it('stands the character on the spawn marker rather than inside it', () => {
    expect(spawnOf(withSpawn())).toEqual(vec3(4, 1 + STAND_OFFSET, 6))
  })

  it('falls back above the origin when a level has no spawn', () => {
    expect(spawnOf(load([pad('ground', 0)]))).toEqual(vec3(0, 3, 0))
  })

  // A client spreads arrivals so two players do not appear inside each other; a play-test does not need to.
  it('spreads several players around the marker, at the same height', () => {
    const loaded = withSpawn()
    const a = spawnOf(loaded, 1)
    const b = spawnOf(loaded, 2)
    expect(a).not.toEqual(b)
    expect(a.y).toBe(b.y)
    expect(Math.hypot(a.x - 4, a.z - 6)).toBeCloseTo(2, 6)
  })
})

describe('parkour death', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  /**
   * Death is **only** a rule firing now (ADR 0053). There is no fall check: a level's kill plane is a `Hazard`
   * on a wide collider underneath it, so falling into one reaches here as an ordinary `kill()` — the same call
   * a hazard pad makes. A level with no plane under it is a tower, and nothing needs to say so.
   */
  it('dies when a rule kills, wherever the player is', () => {
    const rules = parkourSession(load([pad('ground', 0), pad('plane', 0, Hazard.type)]))
    rules.effects.kill()
    expect(rules.takeDeath()).toBe(true)
  })

  it('consumes the kill, so one death is not seen twice', () => {
    const rules = parkourSession(load([pad('ground', 0)]))
    rules.effects.kill()
    expect(rules.takeDeath()).toBe(true)
    expect(rules.takeDeath(), 'the flag was cleared').toBe(false)
  })

  it('does not die on its own — no rule, no death, however far below the level you are', () => {
    const rules = parkourSession(load([pad('ground', 0)]))
    expect(rules.takeDeath()).toBe(false)
    expect(rules.takeDeath()).toBe(false)
  })
})

describe('parkour progress', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  const threeCheckpoints = (): LoadedLevel =>
    load([pad('ground', 0), pad('cp0', 2, Checkpoint.type), pad('cp1', 4, Checkpoint.type), pad('cp2', 6, Checkpoint.type)])

  it('indexes only the checkpoints, in tree order', () => {
    expect(checkpointsOf(threeCheckpoints()).map((n) => n.id)).toEqual(['cp0', 'cp1', 'cp2'])
  })

  it('moves the respawn onto a checkpoint when it is reached', () => {
    const loaded = threeCheckpoints()
    const rules = parkourSession(loaded)
    const cps = checkpointsOf(loaded)
    rules.effects.progress(cps[1]!)
    expect(rules.respawnAt()).toEqual(vec3(4, STAND_OFFSET, 0))
    expect(rules.progress()).toBe(1)
  })

  // Touching an earlier checkpoint on the way back must not undo the run.
  it('only ever advances', () => {
    const loaded = threeCheckpoints()
    const rules = parkourSession(loaded)
    const cps = checkpointsOf(loaded)
    rules.effects.progress(cps[2]!)
    rules.effects.progress(cps[0]!)
    expect(rules.progress()).toBe(2)
    expect(rules.respawnAt()).toEqual(vec3(6, STAND_OFFSET, 0))
  })

  it('reports progress once per checkpoint, so a client saves once', () => {
    const loaded = threeCheckpoints()
    const seen: number[] = []
    const rules = parkourSession(loaded, { onProgress: (i) => seen.push(i) })
    const cps = checkpointsOf(loaded)
    rules.effects.progress(cps[0]!)
    rules.effects.progress(cps[0]!)
    rules.effects.progress(cps[1]!)
    expect(seen).toEqual([0, 1])
  })

  it('resumes from a persisted checkpoint, standing on it', () => {
    const loaded = threeCheckpoints()
    const rules = parkourSession(loaded, { from: 1 })
    expect(rules.progress()).toBe(1)
    expect(rules.respawnAt()).toEqual(vec3(4, STAND_OFFSET, 0))
  })

  // A saved index outliving the level it was saved against: the level was edited, or the player switched.
  it('falls back to the spawn when a resumed checkpoint is no longer there', () => {
    const loaded = load([pad('ground', 0), { id: 'm', transform: { position: vec3(9, 0, 0) }, components: [comp('s', 'Spawn')] }])
    expect(parkourSession(loaded, { from: 7 }).respawnAt()).toEqual(vec3(9, STAND_OFFSET, 0))
  })

  it('ignores a node that is not a checkpoint at all', () => {
    const loaded = threeCheckpoints()
    const rules = parkourSession(loaded)
    rules.effects.progress(loaded.nodes.find((n) => n.id === 'ground')!)
    expect(rules.progress()).toBe(-1)
  })
})

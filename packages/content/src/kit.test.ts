import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { beam, checkpointPad, gapJump, goalPad, hazardPad, ledge, movingPlatform, platform, ramp, rotatingBar, spawnPad } from './kit'
import { instantiateLevel } from './loader'
import type { Level, Prefab } from './types'

// Wrap a single prefab in a minimal level so we can exercise the loader against it.
const levelOf = (prefab: Prefab): Level => ({
  id: 'kit-test',
  config: { fallBehavior: 'physical-fall', fallY: -10 },
  instances: [{ prefab, transform: { position: { x: 0, y: 0, z: 0 } } }],
})

describe('greybox kit — shapes', () => {
  it('platform is a single box slab of the requested size', () => {
    const p = platform({ width: 6, depth: 2, thickness: 0.4 })
    expect(p.pieces).toHaveLength(1)
    expect(p.pieces[0]!.collider).toEqual({ kind: 'box', halfExtents: { x: 3, y: 0.2, z: 1 } })
  })

  it('beam is long along +x and narrow along +z', () => {
    const b = beam({ length: 14, width: 0.4 })
    expect(b.pieces).toHaveLength(1)
    // width is the narrowness (z), length the distance you have to hold the line (x).
    expect(b.pieces[0]!.collider).toEqual({ kind: 'box', halfExtents: { x: 7, y: 0.25, z: 0.2 } })
  })

  it('ledge is a thinner, smaller platform preset', () => {
    const l = ledge()
    expect(l.id).toBe('ledge')
    expect(l.pieces[0]!.collider.kind).toBe('box')
  })

  it('ramp tilts a box so it rises `rise` over `run`', () => {
    const r = ramp({ run: 4, rise: 4, width: 3 })
    const piece = r.pieces[0]!
    expect(piece.transform.rotation?.z).toBeCloseTo(Math.PI / 4, 6) // 45° for equal run/rise
    const c = piece.collider
    if (c.kind !== 'box') throw new Error('expected box')
    const length = c.halfExtents.x * 2
    expect(length * Math.cos(Math.PI / 4)).toBeCloseTo(4, 6) // horizontal span == run
  })

  it('gapJump makes two platforms separated by the gap', () => {
    const g = gapJump({ width: 2, gap: 4 })
    expect(g.pieces).toHaveLength(2)
    const dx = Math.abs(g.pieces[1]!.transform.position.x - g.pieces[0]!.transform.position.x)
    expect(dx).toBeCloseTo(6, 6) // width + gap = centre-to-centre
  })

  it('movingPlatform carries a move behavior; rotatingBar a rotate behavior', () => {
    expect(movingPlatform().behavior?.kind).toBe('move')
    expect(rotatingBar().behavior?.kind).toBe('rotate')
  })

  it('spawn uses a marker; checkpoint/goal/hazard tag their piece collider as a trigger', () => {
    expect(spawnPad().markers?.[0]?.kind).toBe('spawn')
    expect(checkpointPad().pieces[0]?.trigger).toBe('checkpoint')
    expect(goalPad().pieces[0]?.trigger).toBe('goal')
    expect(hazardPad().pieces[0]?.trigger).toBe('hazard')
  })
})

describe('greybox kit — loads into a world', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('a moving platform instantiates and moves on the clock', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateLevel(world, levelOf(movingPlatform({ axis: { x: 0, y: 1, z: 0 }, distance: 2, periodMs: 4000 })))
    loaded.update(0)
    const y0 = loaded.visuals[0]!.position.y // home (at rest)
    loaded.update(2000) // half period → far end (peak travel)
    expect(Math.abs(loaded.visuals[0]!.position.y - y0)).toBeGreaterThan(1)
    world.free()
  })

  it('a checkpoint pad instantiates as a physics trigger', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateLevel(world, levelOf(checkpointPad()))
    expect(loaded.triggers.find((t) => t.kind === 'checkpoint')).toBeDefined()
    world.free()
  })
})

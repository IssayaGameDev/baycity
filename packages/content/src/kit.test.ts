import { createPhysicsWorld, initPhysics } from '@mp/physics'
import { beforeAll, describe, expect, it } from 'vitest'

import { checkpointPad, gapJump, goalPad, hazardPad, ledge, movingPlatform, platform, ramp, rotatingBar, spawnPad } from './kit'
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

  it('pads emit the right marker kind', () => {
    expect(spawnPad().markers?.[0]?.kind).toBe('spawn')
    expect(checkpointPad().markers?.[0]?.kind).toBe('checkpoint')
    expect(goalPad().markers?.[0]?.kind).toBe('goal')
    expect(hazardPad().markers?.[0]?.kind).toBe('hazard')
  })
})

describe('greybox kit — loads into a world', () => {
  beforeAll(async () => {
    await initPhysics()
  })

  it('a moving platform instantiates and moves on the clock', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateLevel(world, levelOf(movingPlatform({ axis: { x: 0, y: 1, z: 0 }, amplitude: 2, periodMs: 4000 })))
    loaded.update(0)
    const y0 = loaded.visuals[0]!.position.y
    loaded.update(1000)
    expect(Math.abs(loaded.visuals[0]!.position.y - y0)).toBeGreaterThan(1)
    world.free()
  })

  it('a checkpoint pad surfaces a checkpoint marker with its radius', () => {
    const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
    const loaded = instantiateLevel(world, levelOf(checkpointPad({ radius: 2 })))
    expect(loaded.markers.find((m) => m.kind === 'checkpoint')?.radius).toBe(2)
    world.free()
  })
})

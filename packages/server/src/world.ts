import { entityId, type EntityId, type Vec3 } from '@mp/core'
import type { Snapshot } from '@mp/net'
import { createPhysicsWorld, type PhysicsBody } from '@mp/physics'

/**
 * Throwaway M3 content: a Rapier3d world — a fixed ground with several dynamic
 * balls dropped from staggered heights, re-dropped on a cycle so the demo keeps
 * moving instead of settling once. Exists to exercise physics in the tick and
 * 3D rendering, not to be a game (SEED §7, M3). `initPhysics()` must have
 * resolved before this is called.
 */
const BALL_COUNT = 8
const BALL_RADIUS = 0.5
const REDROP_PERIOD_MS = 4000

export interface SimWorld {
  step: (dtSeconds: number) => void
  /**
   * Per-client snapshot construction — no global broadcast (SEED §3). `connId`
   * is unused now (no AOI); it is the seam bandwidth levers hook into later.
   * Only the dynamic balls are replicated; the ground is static scenery the
   * client draws on its own.
   */
  snapshotFor: (connId: number, simTimeMs: number) => Snapshot
}

export const createSimWorld = (): SimWorld => {
  const world = createPhysicsWorld({ gravity: { x: 0, y: -9.81, z: 0 } })

  world.addFixedBody({
    position: { x: 0, y: 0, z: 0 },
    shape: { kind: 'cuboid', halfExtents: { x: 20, y: 0.1, z: 20 } },
  })

  const balls: { id: EntityId; body: PhysicsBody; start: Vec3 }[] = []
  for (let i = 0; i < BALL_COUNT; i++) {
    const start: Vec3 = { x: (i - (BALL_COUNT - 1) / 2) * 1.5, y: 6 + i * 0.8, z: (i % 3) - 1 }
    const body = world.addDynamicBody({
      position: start,
      shape: { kind: 'ball', radius: BALL_RADIUS },
      restitution: 0.6,
    })
    balls.push({ id: entityId(i + 1), body, start })
  }

  let sinceRedropMs = 0

  return {
    step: (dtSeconds) => {
      world.step(dtSeconds)
      sinceRedropMs += dtSeconds * 1000
      if (sinceRedropMs >= REDROP_PERIOD_MS) {
        sinceRedropMs = 0
        for (const b of balls) b.body.teleport(b.start)
      }
    },
    snapshotFor: (_connId, simTimeMs) => ({
      serverTimeMs: simTimeMs >>> 0,
      entities: balls.map((b) => ({ id: b.id, position: b.body.translation() })),
    }),
  }
}

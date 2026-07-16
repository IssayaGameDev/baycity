import { entityId, type EntityState } from '@mp/core'
import type { Snapshot } from '@mp/net'

/**
 * Throwaway M2 content: a single sphere orbiting the origin in the XZ plane.
 * Pure kinematics, no physics — it exists only to exercise the net path
 * (SEED §7, M2). Real simulation arrives with Rapier in M3.
 */
const SPHERE_ID = entityId(1)
const ORBIT_RADIUS = 5
const ORBIT_PERIOD_S = 6

export interface SphereWorld {
  update: (simTimeMs: number) => void
  /**
   * Per-client snapshot construction — no global broadcast, even though M2 has
   * no per-client filtering yet (SEED §3). `connId` is unused for now; AOI and
   * other levers hook in here later without restructuring.
   */
  snapshotFor: (connId: number, simTimeMs: number) => Snapshot
}

export const createSphereWorld = (): SphereWorld => {
  let sphere: EntityState = { id: SPHERE_ID, position: { x: ORBIT_RADIUS, y: 1, z: 0 } }
  return {
    update: (simTimeMs) => {
      const theta = (simTimeMs / 1000 / ORBIT_PERIOD_S) * Math.PI * 2
      sphere = {
        id: SPHERE_ID,
        position: { x: Math.cos(theta) * ORBIT_RADIUS, y: 1, z: Math.sin(theta) * ORBIT_RADIUS },
      }
    },
    snapshotFor: (_connId, simTimeMs) => ({
      serverTimeMs: simTimeMs >>> 0,
      entities: [{ id: sphere.id, position: sphere.position }],
    }),
  }
}

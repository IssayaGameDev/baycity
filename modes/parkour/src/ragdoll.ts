import { PART_NAMES, RIG, type PartName, type PartTransform } from '@mp/character'
import { clamp, slerpQuat, vec3, type Vec3 } from '@mp/core'
import type { PhysicsBody, PhysicsWorld } from '@mp/physics'
import { createLooseParts, THREE, type CharacterRigOptions } from '@mp/render-three'

/**
 * Death ragdoll: each of the ten rig parts becomes its own dynamic rigid body at the pose it was already
 * in, keeping the character's velocity. Physics does the rest.
 *
 * It lives in the mode rather than in a package because it is the only layer that owns both the physics
 * world and the scene. `@mp/render-three` deliberately has no physics dependency — that is what keeps
 * Rapier's WASM out of the render bundle — and `@mp/character` imports physics types only.
 *
 * **Local and visual only.** Nothing about this goes on the wire, so each client ragdolls its own death and
 * peers simply see that player stop moving.
 */
export interface Ragdoll {
  /** The ten parts' collider handles. A query that must ignore the player's own body — the camera's
   * occlusion probe — needs these as well as the capsule's. */
  colliders: readonly number[]
  /**
   * Snapshot the bodies. Call once per **sim tick**, after the world has stepped.
   *
   * Rapier only moves these on a tick, so writing their poses straight to the meshes shows the 30 Hz sim
   * rate on a 60–144 Hz screen, which reads as a handful of updates a second on parts moving this fast.
   * Everything else in the scene is already interpolated between ticks — the level via `loaded.render`, the
   * player via `renderPositions` — and this is the ragdoll's version of that.
   */
  capture: () => void
  /** Write the meshes, interpolated `alpha` of the way from the previous tick to the last one. */
  sync: (alpha: number) => void
  /** Remove the bodies and the meshes. */
  dispose: () => void
}

export interface RagdollOptions {
  world: PhysicsWorld
  scene: THREE.Scene
  /** Where every part was at the instant of death — from `partTransforms`, so nothing jumps. */
  transforms: Record<PartName, PartTransform>
  /** The character's velocity at death, inherited by every part so momentum carries through. */
  velocity: Vec3
  look?: CharacterRigOptions
}

export const createRagdoll = (opts: RagdollOptions): Ragdoll => {
  const { world, scene, transforms, velocity } = opts

  const parts = createLooseParts(opts.look)
  scene.add(parts.group)

  const bodies = {} as Record<PartName, PhysicsBody>
  // The last two ticks' poses, to interpolate the render between. Both seeded from the death pose so the
  // first frame has something to interpolate and does not jump from the origin.
  const prev = {} as Record<PartName, PartTransform>
  const curr = {} as Record<PartName, PartTransform>
  for (const name of PART_NAMES) {
    const t = transforms[name]
    const size = RIG[name].size
    const body = world.addDynamicBody({
      position: t.position,
      rotation: t.rotation,
      shape: { kind: 'cuboid', halfExtents: vec3(size.x / 2, size.y / 2, size.z / 2) },
    })
    body.setLinvel(velocity)
    bodies[name] = body
    prev[name] = { position: { ...t.position }, rotation: { ...t.rotation } }
    curr[name] = { position: { ...t.position }, rotation: { ...t.rotation } }
  }

  return {
    colliders: PART_NAMES.map((name) => bodies[name].colliderHandle),
    capture: () => {
      for (const name of PART_NAMES) {
        prev[name] = curr[name]
        curr[name] = { position: bodies[name].translation(), rotation: bodies[name].rotation() }
      }
    },
    sync: (alpha) => {
      const a = clamp(alpha, 0, 1)
      for (const name of PART_NAMES) {
        const p = prev[name]
        const c = curr[name]
        const m = parts.mesh[name]
        m.position.set(p.position.x + (c.position.x - p.position.x) * a, p.position.y + (c.position.y - p.position.y) * a, p.position.z + (c.position.z - p.position.z) * a)
        // Slerp, not lerp: a tumbling part turns far enough per tick that the shortest-arc path matters.
        const q = slerpQuat(p.rotation, c.rotation, a)
        m.quaternion.set(q.x, q.y, q.z, q.w)
      }
    },
    dispose: () => {
      for (const name of PART_NAMES) bodies[name].remove()
      parts.dispose()
    },
  }
}

import { createAnimator, type Animator } from '@mp/character'
import type { EntityId, Vec3 } from '@mp/core'
import { createCharacterRig, THREE, type CharacterRig } from '@mp/render-three'

import { makeNameLabel } from './nametag'

/**
 * Per-player views: the blocky rig from `@mp/render-three`, driven by the procedural animator from
 * `@mp/character`, plus a billboard nametag. This file is now only an **adapter** — it fills the
 * animator's input from what the mode knows and hands the result to the rig.
 *
 * Facing and speed are derived here when the caller does not know them (peers), from the *rendered*
 * position, which is already interpolated — differencing raw snapshots would be jittery at 20 Hz.
 * Grounded and rising cannot be derived at all (vertical velocity crosses zero at every jump apex),
 * so they arrive on the wire as state flags and are passed straight through.
 */
interface Rendered {
  rig: CharacterRig
  animator: Animator
  last: Vec3
  /** Smoothed derived planar speed (m/s), for peers. */
  speed: number
  yaw: number
  label?: THREE.Sprite
  labelText?: string
}

export interface CharacterPlacement {
  isSelf: boolean
  position: Vec3
  /** Facing target; `null` derives it from movement. */
  yaw: number | null
  /** Locomotion speed (m/s); `null` derives it from movement. */
  speed: number | null
  grounded: boolean
  rising: boolean
  name: string
}

export interface CharacterViews {
  /** Create or update a player's view for this frame. */
  upsert: (id: EntityId, placement: CharacterPlacement, dt: number) => void
  /** Remove any players whose id isn't in `keep` (left the room). */
  prune: (keep: Set<EntityId>) => void
}

const SELF_COLORS = { shirt: 0xfacc15, trousers: 0x422006 }
const PEER_COLORS = { shirt: 0xf97316, trousers: 0x2b1503 }

export const createCharacterViews = (scene: THREE.Scene): CharacterViews => {
  const chars = new Map<EntityId, Rendered>()

  const charFor = (id: EntityId, isSelf: boolean, position: Vec3): Rendered => {
    let r = chars.get(id)
    if (r === undefined) {
      const rig = createCharacterRig({ colors: isSelf ? SELF_COLORS : PEER_COLORS })
      scene.add(rig.root)
      r = { rig, animator: createAnimator(), last: { ...position }, speed: 0, yaw: 0 }
      chars.set(id, r)
    }
    return r
  }

  const setLabel = (r: Rendered, name: string): void => {
    if (r.labelText === name) return
    if (r.label !== undefined) {
      r.rig.root.remove(r.label)
      r.label.material.map?.dispose()
      r.label.material.dispose()
    }
    r.label = makeNameLabel(name)
    r.rig.root.add(r.label)
    r.labelText = name
  }

  return {
    upsert: (id, { isSelf, position, yaw, speed, grounded, rising, name }, dt) => {
      const r = charFor(id, isSelf, position)

      // Derived motion, from the interpolated render position.
      const dx = position.x - r.last.x
      const dz = position.z - r.last.z
      const moved = Math.hypot(dx, dz)
      if (dt > 0) {
        const observed = moved / dt
        // Light smoothing: interpolation is smooth but snapshot boundaries still step a little.
        r.speed += (observed - r.speed) * Math.min(1, dt * 12)
      }
      if (moved > 1e-4) r.yaw = Math.atan2(dx, dz)
      r.last = { ...position }

      const pose = r.animator.step(
        {
          position,
          yaw: yaw ?? r.yaw,
          speed: speed ?? r.speed,
          grounded,
          rising,
        },
        dt,
      )
      r.rig.apply(pose)
      r.rig.root.position.set(position.x, position.y, position.z)
      setLabel(r, name)
    },
    prune: (keep) => {
      for (const [id, r] of chars)
        if (!keep.has(id)) {
          r.rig.dispose()
          chars.delete(id)
        }
    },
  }
}

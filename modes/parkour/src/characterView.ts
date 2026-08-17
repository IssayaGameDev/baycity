import { createAnimator, DEFAULT_GAIT, type Animator, type GaitTuning, type Pose } from '@mp/character'
import type { EntityId, Vec3 } from '@mp/core'
import { createCharacterRig, THREE, type CharacterRig } from '@mp/render-three'

import { makeNameLabel } from './nametag'

/**
 * Per-player views: the blocky rig from `@mp/render-three`, driven by the procedural animator from
 * `@mp/character`, plus a billboard nametag. This file is now only an **adapter** — it fills the
 * animator's input from what the mode knows and hands the result to the rig.
 *
 * Facing, speed, grounded and rising all arrive on the wire now (v8/v9) and are passed straight
 * through: none of them can be derived from a position curve — facing follows the input, speed would
 * include a platform's carry, and vertical velocity crosses zero at every jump apex. Only the vertical
 * is still derived for peers, from the *rendered* position, which is already interpolated (differencing
 * raw snapshots would be jittery at 20 Hz). The derived facing and speed remain as the fallback for a
 * caller that passes `null`, and as what `velocityOf` reports — a corpse should inherit the world
 * velocity it appeared to have, carry included.
 */
interface Rendered {
  rig: CharacterRig
  animator: Animator
  /** The pose written this frame. The animator reuses one object, so this is a live reference to it. */
  pose: Pose | null
  last: Vec3
  /** Smoothed derived planar speed (m/s), for peers. */
  speed: number
  /** Smoothed derived vertical velocity (m/s), for peers. */
  vy: number
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
  /**
   * World vertical velocity (m/s), excluding anything carrying the character; `null` derives it from the
   * rendered position. What the joint lag needs to trail a jump — without it there is no vertical trail at
   * all, since a platform ride is the only other vertical signal.
   */
  vy: number | null
  grounded: boolean
  rising: boolean
  /**
   * World velocity being applied to the character that its own locomotion did not ask for
   * (`CharacterState.carry`) — what the inertial layer reacts to. `null` for peers: the wire carries
   * position and two flags, and separating a peer's carry from its walking would need either its
   * locomotion speed on the wire or a ground probe here. So peers brace for nothing, for now.
   */
  carry: Vec3 | null
  name: string
}

export interface CharacterViews {
  /** Create or update a player's view for this frame. */
  upsert: (id: EntityId, placement: CharacterPlacement, dt: number) => void
  /**
   * The pose last written for a player, or `null` if it has no view yet. A ragdoll is seeded from this,
   * so its rigid bodies start in exactly the pose the animated rig was in and nothing jumps.
   */
  poseOf: (id: EntityId) => Pose | null
  /**
   * The velocity last derived for a player, or `null` if it has no view yet. Reconstructed from the
   * smoothed planar speed and facing plus the smoothed vertical, which is what a peer's motion is known
   * as here — a peer's ragdoll inherits it so the corpse carries the momentum the body had.
   */
  velocityOf: (id: EntityId) => Vec3 | null
  /** Show or hide a player's rig — hidden while its ragdoll or its spawn assembly has the floor. */
  setVisible: (id: EntityId, visible: boolean) => void
  /**
   * Forget a player's derived motion and re-anchor it at `position`. For peers, whose speed and facing
   * come from differencing the rendered position: a respawn is a teleport of many metres, and
   * differenced it reads as a sprint for as long as the smoothing takes to decay. Called when a peer
   * comes back, so their body assembles around an idle rig rather than a running one.
   */
  resetMotion: (id: EntityId, position: Vec3) => void
  /** Remove any players whose id isn't in `keep` (left the room). */
  prune: (keep: Set<EntityId>) => void
}

/** Shared, read-only: the animator treats zero carry exactly as it treats none. */
const NO_CARRY: Vec3 = { x: 0, y: 0, z: 0 }

/** Exported so a ragdoll's loose parts are the same colours the rig they came from was. */
export const SELF_COLORS = { shirt: 0xfacc15, trousers: 0x422006 }
export const PEER_COLORS = { shirt: 0xf97316, trousers: 0x2b1503 }

/**
 * `gait` is shared by every character's animator and read fresh each frame, so mutating it — from
 * the debug pane — retunes everyone live. Feel is Kodjo's call, and describing it in words is a slow
 * way to converge; sliders are not.
 */
export const createCharacterViews = (scene: THREE.Scene, gait: GaitTuning = DEFAULT_GAIT): CharacterViews => {
  const chars = new Map<EntityId, Rendered>()

  const charFor = (id: EntityId, isSelf: boolean, position: Vec3): Rendered => {
    let r = chars.get(id)
    if (r === undefined) {
      const rig = createCharacterRig({ colors: isSelf ? SELF_COLORS : PEER_COLORS })
      scene.add(rig.root)
      // Seed from the entity id so a session is reproducible, and so two characters do not roll the
      // same sequence of steps — the variation is still per movement, not a fixed personality.
      r = { rig, animator: createAnimator(gait, (id as number) * 2654435761), pose: null, last: { ...position }, speed: 0, vy: 0, yaw: 0 }
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
    upsert: (id, { isSelf, position, yaw, speed, vy, grounded, rising, carry, name }, dt) => {
      const r = charFor(id, isSelf, position)

      // Derived motion, from the interpolated render position.
      const dx = position.x - r.last.x
      const dy = position.y - r.last.y
      const dz = position.z - r.last.z
      const moved = Math.hypot(dx, dz)
      if (dt > 0) {
        const observed = moved / dt
        // Light smoothing: interpolation is smooth but snapshot boundaries still step a little.
        r.speed += (observed - r.speed) * Math.min(1, dt * 12)
        // Same for the vertical, which peers have no other source for. Signed, unlike the speed, and it
        // includes any platform carrying them — separating the two needs a quantity the wire does not have.
        r.vy += (dy / dt - r.vy) * Math.min(1, dt * 12)
      }
      if (moved > 1e-4) r.yaw = Math.atan2(dx, dz)
      r.last = { ...position }

      const pose = r.animator.step(
        {
          yaw: yaw ?? r.yaw,
          speed: speed ?? r.speed,
          vy: vy ?? r.vy,
          grounded,
          rising,
          carry: carry ?? NO_CARRY,
        },
        dt,
      )
      r.pose = pose
      r.rig.apply(pose)
      r.rig.root.position.set(position.x, position.y, position.z)
      // No nametag over your own head: you know who you are, and the camera sits directly behind it.
      if (!isSelf) setLabel(r, name)
    },
    poseOf: (id) => chars.get(id)?.pose ?? null,
    velocityOf: (id) => {
      const r = chars.get(id)
      return r === undefined ? null : { x: Math.sin(r.yaw) * r.speed, y: r.vy, z: Math.cos(r.yaw) * r.speed }
    },
    setVisible: (id, visible) => {
      const r = chars.get(id)
      if (r !== undefined) r.rig.root.visible = visible
    },
    resetMotion: (id, position) => {
      const r = chars.get(id)
      if (r === undefined) return
      r.last = { ...position }
      r.speed = 0
      r.vy = 0
      // Facing is left alone: it is where they were looking, which is a better guess than the direction
      // the teleport happened to point.
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

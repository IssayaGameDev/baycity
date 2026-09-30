import { rotateVec3, type Quat, type Vec3 } from '@mp/core'
import { defineComponent } from '../define'
import { Collider } from '../engine/collider'

const FORWARD: Vec3 = { x: 0, y: 0, z: 1 }

/** Drop the Y and re-normalise. A zone pitched off level still means the same direction on the ground. */
const flatten = (v: Vec3): Vec3 => {
  const length = Math.hypot(v.x, v.z)
  return length < 1e-6 ? FORWARD : { x: v.x / length, y: 0, z: v.z / length }
}

/** Is a world point inside a box given by its centre, rotation and world half-extents. */
const inBox = (p: Vec3, centre: Vec3, rotation: Quat, half: Vec3): boolean => {
  // Into the box's own frame: rotating by the conjugate is the inverse for a unit quaternion.
  const d = { x: p.x - centre.x, y: p.y - centre.y, z: p.z - centre.z }
  const local = rotateVec3({ x: -rotation.x, y: -rotation.y, z: -rotation.z, w: rotation.w }, d)
  return Math.abs(local.x) <= half.x && Math.abs(local.y) <= half.y && Math.abs(local.z) <= half.z
}

/** Step `from` toward `to` by at most `limit` radians, the short way round. */
const turnToward = (from: number, to: number, limit: number): number => {
  const TAU = Math.PI * 2
  let delta = (((to - from) % TAU) + TAU + Math.PI) % TAU - Math.PI
  if (delta > limit) delta = limit
  else if (delta < -limit) delta = -limit
  return from + delta
}

/**
 * A chaser that wakes when someone enters its zone, hunts whoever is furthest through it, and parks itself
 * back home when the zone empties (ADR 0095).
 *
 * The rule is only the motion. **It does not kill** — put a `Collider` with `trigger` **on** and a `Hazard`
 * on the same node, and touching it kills, exactly as the kill plane does (ADR 0053). Writing a second way to
 * die here would be two rules for one thing.
 *
 * The collider must be a **trigger**, and that is not a style preference. A solid one is resolved by the
 * character controller, so it *shoves* the player instead of killing them, and it only ever reaches the
 * `Hazard` when the **player** moves into **it** — a boss driving into somebody standing still reports
 * nothing at all. A trigger is found by `CharacterBody.overlaps()`, an explicit query run every tick at
 * wherever the capsule is, so it does not care who moved (ADR 0054).
 *
 * ### The zone
 *
 * `zone` is a box `Collider` (a component field, ADR 0177), normally a `trigger` so it is felt and not stood on. Membership
 * is tested **geometrically**, against that box's world oriented extents — not by contact. It has to be:
 * a sensor only ever reports the local player, because peers are relayed positions and were never in this
 * client's physics world at all (ADR 0011). A box test sees everybody `ctx.players()` sees.
 *
 * The zone's **forward** (`+Z` after its rotation) is which way "through" is, so rotating the zone in the
 * editor aims it. That is the convention the transform gizmo already draws, and it means there is no second
 * place for the direction to disagree with the volume.
 *
 * ### Who it picks
 *
 * The living player furthest along that forward axis: the one closest to the exit, which is the one about
 * to escape. The dead are skipped — a corpse keeps the position it fell at, and a boss that chased them
 * would orbit a body until it respawned. Ties go to whoever `ctx.players()` lists first, which puts the local player first — a tie needs
 * *some* answer and this one costs nothing.
 *
 * Two clients can pick different targets for a moment, because peers arrive interpolated (see
 * `Ctx.players`). That is survivable here and nowhere near as bad as it sounds: each client decides its own
 * death, so a boss a few centimetres apart on two screens still kills exactly the player whose own client
 * says it touched them — the same bargain every `Hazard` already makes.
 *
 * ### Moving
 *
 * `speed` is m/s along the heading; `turn` is how fast the heading may swing, in degrees a second, which is
 * what stops it snapping round and makes running past it a real dodge. It drives in the horizontal plane
 * only and keeps its authored height: a boss that chased you upward would climb its own level.
 *
 * With the zone empty it drives home at the same speed and stops there, so a lane clears itself and a parked
 * boss reads as a safe lane. Home is where it was authored — `self.offset` is a live offset from the
 * authored transform (ADR 0058), so home is simply an offset of zero.
 *
 * **Put it at the level root.** The offset is in the node's *parent* space, so a boss parented under a
 * rotated or scaled node would chase along skewed axes. Nothing stops you; it just will not aim where you
 * expect.
 */
export const Boss = defineComponent({
  type: 'Boss',
  menu: 'Gameplay',
  params: {
    zone: { kind: 'componentRef', of: Collider.type, label: 'zone' },
    speed: { kind: 'number', default: 8, min: 0.5, max: 60, step: 0.5, label: 'speed (m/s)' },
    turn: { kind: 'number', default: 180, min: 15, max: 720, step: 15, label: 'turn (°/s)' },
  },
  singleton: true,
  moves: true,
  /** `heading` is null until the first tick that has a zone, so it can start out facing the way through. */
  init: () => ({ heading: null as number | null }),
  onFixedUpdate: (self, ctx) => {
    const drive = self.offset
    if (drive === undefined) return // declared `moves`, so this cannot happen; the honest guard is free

    const found = self.findComponent(self.params.zone, Collider)
    const zone = found?.node
    const shape = found?.collider
    const box = shape?.kind === 'box' ? shape : undefined
    // No zone, or a zone that is not a box: go home and stay there rather than hunt the whole level.
    const forward = zone === undefined ? FORWARD : flatten(rotateVec3(zone.rotation, FORWARD))
    if (self.state.heading === null) self.state.heading = Math.atan2(forward.x, forward.z)

    // Where we are now, in the same space the offset is written in.
    const at = { x: self.node.position.x + drive.position.x, y: self.node.position.y, z: self.node.position.z + drive.position.z }

    let goal: Vec3 | null = null
    if (zone !== undefined && box !== undefined) {
      let best = -Infinity
      for (const p of ctx.players()) {
        // A corpse lies where it fell and keeps a position, so without this the boss circles a dead body
        // until it respawns rather than going home or picking whoever is still running.
        if (!p.alive) continue
        if (!inBox(p.position, zone.position, zone.rotation, box.halfExtents)) continue
        // Distance along the zone's forward: the exit is the far end, so the largest wins.
        const along = (p.position.x - zone.position.x) * forward.x + (p.position.z - zone.position.z) * forward.z
        if (along > best) {
          best = along
          goal = p.position
        }
      }
    }

    // Nobody in the zone: home is the goal, and arriving means stopping dead rather than circling it.
    const home = self.node.position
    const target = goal ?? home
    const dx = target.x - at.x
    const dz = target.z - at.z
    const distance = Math.hypot(dx, dz)
    const step = self.params.speed * ctx.dt
    // Arrived. Stopping inside one step's reach rather than at zero is what keeps it from overshooting the
    // target and swinging back through it every tick — which, on a body it cannot kill, reads as circling.
    if (distance <= step) {
      if (goal === null) {
        drive.position.x = 0
        drive.position.z = 0
      }
      drive.rotation.y = self.state.heading
      return
    }

    // Swing the heading toward the goal, no faster than `turn`, then walk that way. Turning first is what
    // makes a sharp change cost time instead of being free.
    const wanted = Math.atan2(dx, dz)
    const limit = (self.params.turn * Math.PI) / 180 * ctx.dt
    self.state.heading = turnToward(self.state.heading, wanted, limit)
    drive.position.x += Math.sin(self.state.heading) * step
    drive.position.z += Math.cos(self.state.heading) * step
    drive.rotation.y = self.state.heading
  },
})

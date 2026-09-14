import { rotateVec3, type Quat, type Vec3 } from '@mp/core'
import { TRACK } from '@mp/content'
import { defineComponent } from './define'

/**
 * Gameplay rules and motion — what a **mode** reads. The loader never looks at these.
 *
 * Three of them **own their own reaction** since stage C2: `onContact` fires when a collider on the same node
 * is touched, and the mode supplies only what dying and making progress mean for it (`Effects`). The branches
 * that used to sit in `modes/parkour/src/main.ts` are gone.
 *
 * `Goal` has no hook, because the mode has no goal rule — nothing ends a run yet, and writing one here would
 * be a design decision wearing an implementation's clothes.
 *
 * `Track` has no hook either, and that is not an omission: the loader's frame tree evaluates it as a pure
 * function of the synced clock, so a late joiner needs no catch-up and a static subtree costs nothing. An
 * accumulating hook would trade both away for nothing.
 *
 * A rule fires on **contact with any `Collider` on the same node**, no wiring between the two. That is
 * Unity's model: the contact is delivered to the node and every component on it hears about it. The
 * rejected alternative — a rule holding a pointer to its collider — has a dangling state this cannot have.
 *
 * The rules are `singleton` because a second copy on one node is redundant rather than expressive (two
 * hazards kill once; two bumpers resolve to the stronger, which is the same as deleting the weaker).
 * Colliders are the repeatable ones. Reversible if a rule ever grows a per-copy parameter that stacks.
 */

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

/** Touching it saves this as the respawn point. Ordered by tree walk, which is what indexes them. */
export const Checkpoint = defineComponent({
  type: 'Checkpoint',
  params: {},
  singleton: true,
  // The node, not an index: what counts as progress is the mode's business, and it is the mode that holds the
  // ordered list a saved index means anything against.
  onContact: (_self, ctx, hit) => ctx.effects.progress(hit.node),
})

/** Touching it completes the level. No hook: the mode has no goal rule yet. */
export const Goal = defineComponent({
  type: 'Goal',
  params: {},
  singleton: true,
})

/** Touching it kills. Distinct from falling past the level's `fallY`, which is config, not a component. */
export const Hazard = defineComponent({
  type: 'Hazard',
  params: {},
  singleton: true,
  onContact: (_self, ctx) => ctx.effects.kill(),
})

/**
 * Launches whatever lands on it.
 *
 * `power` is an upward speed in m/s, replacing the character's vertical velocity. Apex is
 * `power² / (2·gravity)`; at the tuned gravity of 55 a jump leaves the ground at `√(2·55·3) ≈ 18.2` m/s,
 * so **anything below 18 throws you lower than your own jump**. 26 gives about 6.1 m, roughly twice a
 * jump (ADR 0032).
 *
 * The default lives here rather than in the editor, which is where `DEFAULT_BUMPER_POWER` sat: a schema
 * value defaulted by the tool means hand-written JSON has no default at all.
 */
export const Bumper = defineComponent({
  type: 'Bumper',
  params: {
    power: { kind: 'number', default: 26, min: 1, max: 60, step: 1, label: 'launch (m/s)' },
  },
  singleton: true,
  /**
   * `self.params.power` is a `number` here with no cast and no lookup — the payoff of declaring parameters.
   *
   * The request goes through the character's `launch` field rather than onto `vy`, because leaving a surface
   * is five decisions in `stepCharacter` and not one (ADR 0032). `CharacterAccess.launch` keeps the strongest
   * request in a tick, so a stack of bumpers throws you as hard as the hardest one.
   */
  onContact: (self, ctx) => ctx.character.launch(self.params.power),
})

/**
 * Clock-driven keyed motion — a pure function of synced time, so no per-object networking (ADR 0013/0021,
 * ADR 0029). **Offsets** the node's local pose per channel rather than replacing it (ADR 0050).
 *
 * The motion comes from one of two places, and both are supported on purpose (ADR 0050):
 *
 * - `keys` — this node's own track. What a one-off mover wants: no file, nothing shared.
 * - `clip` — an animation asset every user of it shares. Edit the clip, every platform playing it changes.
 *
 * **Inline keys win** when a file somehow has both; the editor keeps them exclusive. Duration is the last
 * key's `t`, derived rather than stored so the two cannot disagree.
 *
 * `loop` and `phaseMs` stay here rather than moving into the clip, because they are per-placement: a
 * staggered row of pistons is one clip and six phases.
 */
export const Track = defineComponent({
  type: TRACK,
  params: {
    clip: { kind: 'asset', of: 'animation', default: '', label: 'clip' },
    keys: { kind: 'keys', clip: 'clip' },
    loop: { kind: 'enum', options: ['loop', 'pingPong', 'once'], default: 'loop' },
    phaseMs: { kind: 'number', default: 0, step: 50, label: 'phase (ms)' },
  },
  singleton: true,
})

/**
 * What dying looks like — the reaction, not the rule (ADR 0059).
 *
 * The rule is already a component: a `Hazard` fires `effects.kill` and the game's session decides whether
 * that counts. What was left hardcoded in the shared game client was everything *after* that: the rig falls
 * apart into loose bodies, you wait for a click, and the body drops back in two parts at a time on a fixed
 * timing. Every game got the same one whether it suited them or not.
 *
 * **Data, with no hooks**, and read by the client — the same arrangement as `Collider` and `Renderer`, which
 * are components the *loader* reads. It has to be: a ragdoll is ten dynamic Rapier bodies and ten Three
 * meshes built from the rig's live pose, so a headless component cannot produce one. It does not need to —
 * the client already knows the death happened, and what it was missing was the game's opinion about it.
 *
 * **On the player**, so it is declared by the game rather than dragged onto a platform.
 *
 * Its defaults are exactly what the client hardcoded, so a game that says nothing dies the way it always did.
 */
export const Death = defineComponent({
  type: 'Death',
  label: 'Death reaction',
  attachesTo: 'player',
  singleton: true,
  params: {
    /**
     * Break the rig into loose bodies on death. Off leaves the body where it fell and skips straight to the
     * wait — which is what a game whose character is not a jointed figure wants.
     */
    ragdoll: { kind: 'bool', default: true },
    /** Seconds between each pair of parts arriving as the body reassembles. */
    assembleStagger: { kind: 'number', default: 0.05, min: 0, max: 0.4 },
    /** Seconds a part takes to fall into place. */
    assembleFall: { kind: 'number', default: 0.18, min: 0.02, max: 1 },
    /** Metres above its final position a part starts from. */
    assembleHeight: { kind: 'number', default: 2.5, min: 0.2, max: 8 },
  },
})

/**
 * A chaser that wakes when someone enters its zone, hunts whoever is furthest through it, and parks itself
 * back home when the zone empties (ADR 0095).
 *
 * The rule is only the motion. **It does not kill** — put a `Collider` and a `Hazard` on the same node and
 * touching it kills, exactly as any other hazard does, because that is already a component and writing a
 * second way to die here would be two rules for one thing.
 *
 * ### The zone
 *
 * `zone` names a node with a box `Collider`, normally a `trigger` so it is felt and not stood on. Membership
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
 * The player furthest along that forward axis: the one closest to the exit, which is the one about to
 * escape. Ties go to whoever `ctx.players()` lists first, which puts the local player first — a tie needs
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
  params: {
    zone: { kind: 'nodeRef', label: 'zone' },
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

    const zone = self.find(self.params.zone)
    const box = zone === undefined ? undefined : zone.colliders.find((c) => c.kind === 'box')
    // No zone, or a zone that is not a box: go home and stay there rather than hunt the whole level.
    const forward = zone === undefined ? FORWARD : flatten(rotateVec3(zone.rotation, FORWARD))
    if (self.state.heading === null) self.state.heading = Math.atan2(forward.x, forward.z)

    // Where we are now, in the same space the offset is written in.
    const at = { x: self.node.position.x + drive.position.x, y: self.node.position.y, z: self.node.position.z + drive.position.z }

    let goal: Vec3 | null = null
    if (zone !== undefined && box !== undefined) {
      let best = -Infinity
      for (const p of ctx.players()) {
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
    if (distance <= 1e-4 || (goal === null && distance <= step)) {
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

export const GAMEPLAY_COMPONENTS = [Checkpoint, Goal, Hazard, Bumper, Track, Boss]

/**
 * Components a game puts on its **player** rather than in a level (ADR 0059).
 *
 * Separate from `GAMEPLAY_COMPONENTS` because the two are offered in different places: those go in the
 * editor's Add Component menu, these go in a `ModeDescriptor.player` list. A game still has to list them in
 * its registry, which is what validates their parameters.
 */
export const PLAYER_COMPONENTS = [Death]

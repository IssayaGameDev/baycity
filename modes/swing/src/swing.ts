import { defineComponent, type ComponentDef } from '@mp/components'
import { vec3, type Vec3 } from '@mp/core'
import { CHAR_HALF_HEIGHT, CHAR_RADIUS, stepCharacter } from '@mp/humanoid'
import type { PlayerHost } from '@mp/mode'
import type { PhysicsWorld } from '@mp/physics'

import { bestAnchor, ropeForce, type Rope, type RopeTuning } from './rope'

/**
 * The swing, as this game's locomotion (ADR 0067).
 *
 * **It replaces `Locomotion` rather than sitting beside it**, and that is not the same as replacing the
 * controller. `stepCharacter` still runs, every tick, attached or not — it is what supplies gravity, which is
 * what drives the pendulum, and it is what resolves collisions. What this owns is the *slot* (ADR 0061): the
 * chance to add a force before the step and to decide what the stick means during it.
 *
 * Two components could not do it. `onLocomote` handlers run in definition order, so a second one adding a force
 * after `Locomotion` had already stepped would be a tick late, and neither could stop the other's air control
 * from fighting the rope.
 *
 * Held, not toggled: the key holds the rope and letting go releases it with the momentum you had. Nothing can
 * get stuck attached, and the release timing is the skill.
 */

/** The action name this game declares. `ModeDescriptor.actions` maps a key to it; nothing else knows it. */
export const SWING_ACTION = 'swing'

/**
 * The state name that travels, in bit order (ADR 0064).
 *
 * One boolean, and it is free: bits 3..7 of the flags byte are the game's and were already being transmitted.
 * It is the whole of what a peer's rope costs — the anchor itself is re-derived by each viewer rather than sent
 * (ADR 0068).
 */
export const SWINGING_STATE = 'swinging'

/** What is currently attached, if anything. Shared with the drawing, which is why it is not a closure. */
export interface SwingState {
  rope: Rope | null
  /** The last anchor considered good enough, whether or not the key was held. What a reticle would show. */
  candidate: Vec3 | null
}

export const newSwingState = (): SwingState => ({ rope: null, candidate: null })

/**
 * How the sky is searched for something to hold.
 *
 * A fan of casts rather than a list of authored anchors, because Kodjo asked for **any surface**: a level does
 * not have to be prepared to be swingable, and the geometry that is already there is the geometry you swing
 * from. Each cast returns the *first* thing along it, so the clear-line requirement comes free — a hit is by
 * definition not through a wall.
 *
 * **Only cast while the key is held and nothing is attached**, which is what makes the fan affordable. Searching
 * every tick regardless cost 25 casts a second per player for an answer nobody was asking for; searching only
 * while reaching costs nothing at all the rest of the time, and still grabs the instant something comes into
 * range mid-hold.
 *
 * The pitches start at 25°, not 35°. The first test beam sits at 33.7° from a standing player and a fan
 * starting at 35° went over the top of it by a tenth of a metre — a sampled fan misses things that are exactly
 * between its rays, and the cheapest guard is to sample where a person would actually be looking.
 */
const FAN_YAW_DEG = [0, -20, 20, -40, 40]
const FAN_PITCH_DEG = [25, 35, 45, 60, 75]
const PROBE_RADIUS = 0.2

/**
 * How far above a character's origin the rope leaves from.
 *
 * Just clear of the capsule's crown (`0.6 + 0.4`), and the clearance is what makes it work for **other
 * players** as well as for yourself (ADR 0068): your own cast can exclude your own collider, but a viewer
 * re-deriving a peer's anchor has no handle for the capsule standing in for them, so the ray has to start
 * outside it or every ray in the fan returns that capsule and nothing else.
 *
 * One constant for both, so a viewer's re-derived anchor comes from the same geometry the owner grabbed from.
 */
const SHOULDER = CHAR_HALF_HEIGHT + CHAR_RADIUS + 0.3

/** A facing angle as a flat direction. What a peer's `yaw` off the wire means (ADR 0068). */
export const headingFromYaw = (yaw: number): Vec3 => vec3(Math.sin(yaw), 0, Math.cos(yaw))

/**
 * Where the search is centred: the way you are moving, or the way you are asking to move.
 *
 * Velocity first, because at any speed that is where you are going and where the swing should carry you. The
 * stick second, for the case of reaching from a standstill — you press a direction and grab, and the two happen
 * on the same tick.
 *
 * Facing would be the third fallback and is **not available**: `CharacterState` has no yaw, and the client's
 * `ownFacing` is the client's. Standing dead still with no direction held therefore searches nowhere, which is
 * the honest answer — there is no direction to search along.
 */
const headingOf = (vx: number, vz: number, move: { x: number; z: number }): Vec3 | null => {
  const speed = Math.hypot(vx, vz)
  if (speed >= 0.2) return vec3(vx / speed, 0, vz / speed)
  const push = Math.hypot(move.x, move.z)
  if (push >= 0.05) return vec3(move.x / push, 0, move.z / push)
  return null
}

/** One direction in the fan: `heading` turned by `yawDeg` and lifted by `pitchDeg`. */
const fanDirection = (heading: Vec3, yawDeg: number, pitchDeg: number): Vec3 => {
  const yaw = (yawDeg * Math.PI) / 180
  const pitch = (pitchDeg * Math.PI) / 180
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const x = heading.x * cy - heading.z * sy
  const z = heading.x * sy + heading.z * cy
  const flat = Math.cos(pitch)
  return vec3(x * flat, Math.sin(pitch), z * flat)
}

export interface SwingDeps {
  host: PlayerHost
  state: SwingState
  /** Live, so the debug pane retunes the feel without a reload. */
  tuning: () => RopeTuning
}

export const createSwing = ({ host, state, tuning }: SwingDeps): ComponentDef<Record<string, never>> =>
  defineComponent({
    type: 'Swing',
    label: 'Swing',
    attachesTo: 'player',
    singleton: true,
    params: {},
    onLocomote: (_self, ctx, cmd) => {
      const char = host.character()
      if (char === null) return
      const rope = tuning()

      const held = cmd.actions?.has(SWING_ACTION) ?? false
      const at = char.body.translation()
      const from = vec3(at.x, at.y + SHOULDER, at.z)

      // Only while reaching for one: 25 casts on the ticks you are holding the key with nothing attached, and
      // none at all otherwise. Still grabs the moment something comes into range mid-hold.
      const world = host.world()
      const heading = world === null ? null : headingOf(char.vx, char.vz, { x: cmd.moveX, z: cmd.moveZ })
      state.candidate =
        held && state.rope === null && world !== null && heading !== null
          ? castForAnchor(world, from, heading, rope, [char.body.colliderHandle])
          : null

      if (!held) state.rope = null
      else if (state.rope === null && state.candidate !== null) {
        const d = state.candidate
        state.rope = {
          anchor: d,
          // Fixed at attach: the rope is the length it was when you grabbed it, so grabbing high and falling
          // gives a long arc and grabbing close gives a tight one.
          restLength: Math.hypot(d.x - from.x, d.y - from.y, d.z - from.z),
        }
      }

      if (state.rope !== null) {
        const f = ropeForce(state.rope, from, vec3(char.vx, char.vy, char.vz), { x: cmd.moveX, z: cmd.moveZ }, ctx.dt, rope)
        char.vx += f.dvx
        char.vy += f.dvy
        char.vz += f.dvz
      }

      /**
       * The step, always — and with the stick **taken away** while attached.
       *
       * Air control steers toward `moveSpeed` in whatever direction the stick points, which on a rope is a
       * second thing pulling the character and the two just fight. The stick still does something: it pumped
       * the swing above. This is the whole of what "on top of the controller" means in practice.
       */
      const suppressed = state.rope === null ? cmd : { ...cmd, moveX: 0, moveZ: 0 }
      stepCharacter(char, suppressed, ctx.dt, host.tuning(), host.platforms())
    },
  })

/**
 * Cast the fan, keep what it hit, and let the scoring choose.
 *
 * Exported and taking a **world** rather than a host, because a viewer runs exactly this to work out where
 * another player's rope is tied (ADR 0068): same fan, same scoring, same geometry — which is the only reason
 * the two ever agree.
 */
export const castForAnchor = (
  world: PhysicsWorld,
  from: Vec3,
  heading: Vec3,
  tuning: RopeTuning,
  exclude: readonly number[],
): Vec3 | null => {
  const found: Vec3[] = []
  for (const yawDeg of FAN_YAW_DEG)
    for (const pitchDeg of FAN_PITCH_DEG) {
      const dir = fanDirection(heading, yawDeg, pitchDeg)
      const hit = world.castSphere({
        origin: from,
        direction: dir,
        maxDistance: tuning.maxLength,
        radius: PROBE_RADIUS,
        exclude,
      })
      if (hit === undefined) continue
      found.push(vec3(from.x + dir.x * hit.distance, from.y + dir.y * hit.distance, from.z + dir.z * hit.distance))
    }
  return bestAnchor(from, heading, found, tuning)
}

/** Where a rope leaves a body, for a viewer re-deriving a peer's (ADR 0068). */
export { SHOULDER as SWING_SHOULDER }

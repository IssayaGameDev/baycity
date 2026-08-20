import { conjQuat, rotateVec3, vec3, type Quat, type Vec3 } from '@mp/core'
import type { InputCommand } from '@mp/net'
import { type CharacterBody, type CharacterOptions, type CollisionLayers, type PhysicsWorld } from '@mp/physics'

/**
 * Kinematic character-controller library (stack-level, mode-agnostic — ADR pending).
 * Roblox-like locomotion (ADR 0012): fixed-apex jump, ground accel/decel, force-limited
 * air control. Run by each client for its own body (client-authoritative, ADR 0011).
 * Feel is data (`CharacterTuning`) — a mode/level can scale it per player at runtime.
 * Relocated out of `@mp/server/tps`; world *content* now comes from `@mp/content`.
 */
export const TICK_RATE_HZ = 30
export const TICK_DT = 1 / TICK_RATE_HZ
export const CHAR_RADIUS = 0.4
export const CHAR_HALF_HEIGHT = 0.6

export interface CharacterTuning {
  moveSpeed: number // m/s target ground speed (Roblox WalkSpeed 16 studs ≈ 4.5)
  jumpHeight: number // m apex above launch (Roblox JumpHeight 7.2 studs ≈ 2)
  gravity: number // m/s² downward magnitude (Roblox 196.2 studs/s² ≈ 55; high = snappy)
  // Kodjo's values are deliberately above the Roblox reference: see DEFAULT_TUNING.
  groundAccelTime: number // s to reach full speed from rest
  groundStopTime: number // s to brake to a stop when input is released
  airControl: number // 0..1 air steering strength relative to ground accel
  maxFallSpeed: number // m/s cap on downward speed (terminal velocity); rising is never capped
  coyoteTime: number // s of grace after losing footing in which a jump still fires (0 = off)
}

/**
 * Kodjo's call. Faster and higher than the Roblox reference (4.5 / 2), which widens the obstacle
 * envelope: 3.6 m maximum gap and 3.1 m maximum step-up, measured. Gravity is unchanged, so the
 * higher apex also means a longer hang — 0.66 s of air per jump against 0.54 s before.
 */
export const DEFAULT_TUNING: CharacterTuning = {
  moveSpeed: 5.5,
  jumpHeight: 3,
  gravity: 55,
  groundAccelTime: 0.1,
  groundStopTime: 0.08,
  airControl: 0.3,
  // A safety net, not a feel value — deliberately above anything the shipped levels can reach (the
  // longest fall to a kill plane peaks near 30 m/s), so today it never engages. It exists for a
  // `physical-fall` level, which has no kill plane at all: there the fall grows without bound, and at
  // 30 Hz a step of 2 m is already past the controller's snap-to-ground reach and thicker than most
  // slabs, leaving the swept resolve as the only thing between the character and the floor.
  // 60 m/s is that 2 m/tick. Lower is safer and changes how a long drop feels — Kodjo's number.
  maxFallSpeed: 60,
  // 100 ms, three ticks at 30 Hz. The standard grace; Kodjo's number, live on the pane.
  coyoteTime: 0.1,
}

/** World pose of a moving surface — the frame a rider's position is kept in. */
export interface PlatformFrame {
  readonly position: Vec3
  readonly rotation: Quat
}

/**
 * Current pose of the moving piece owning `colliderHandle`, or `undefined` when that collider
 * is static (nothing to ride). `@mp/content`'s `LoadedLevel.basePose` implements this; the
 * character stays content-agnostic (docs/workspace.md §Dependency laws).
 */
export type PlatformPoseLookup = (colliderHandle: number) => PlatformFrame | undefined

/** The surface the character is riding, and where it stands **in that surface's frame**. Keeping the
 * position in local space is what makes riding exact: each tick the character moves to where that
 * local point has gone, so translation and spin are both followed and no per-tick error
 * accumulates. Held for as long as the ground probe still finds that collider underfoot — not on
 * the controller's `grounded` flag, which flickers false for isolated ticks while resting, and
 * releasing the base on it costs a whole tick of ride (the once-or-twice-a-second lurch). */
export interface MovementBase {
  colliderHandle: number
  localPos: Vec3
}

/** Character state beyond position: horizontal velocity (momentum + accel), vertical
 * velocity, grounded, and the moving surface it is riding (if any). */
export interface CharacterState {
  body: CharacterBody
  vx: number
  vz: number
  vy: number
  grounded: boolean
  /** Set while standing on a moving piece; `undefined` on static ground or in the air. */
  base: MovementBase | undefined
  /**
   * World velocity (m/s) the character received that its own locomotion did not ask for: a platform
   * carrying it, a sweeping piece shoving it, a wall taking its momentum away. Purely an output —
   * nothing in the step reads it — and the signal an animator needs to show inertia, since none of
   * this appears in `vx`/`vy`/`vz`.
   */
  carry: Vec3
  /**
   * An upward speed (m/s) something outside locomotion wants applied on the next step, then **consumed**.
   *
   * The mode sets it when the character's contacts include a bumper (ADR 0032). It has to go through the step
   * rather than being written onto `vy` from outside, because leaving a surface is five decisions here and not
   * one: the ride must stop owning the vertical, gravity must apply, footing must be released, and the movement
   * base must be dropped. `jumping` already threads all five, so a launch joins it — otherwise a trampoline
   * mounted on a moving platform would have its bounce zeroed by the ride on the very next tick.
   *
   * Consumed rather than latched so a single contact fires once, and 0 means nothing pending.
   */
  launch: number
  /**
   * Seconds of jump grace left — coyote time. Refilled to `coyoteTime` on every tick that has footing,
   * counted down on every tick that does not, and **spent to 0** the moment a jump or a launch leaves the
   * surface. That last part is what stops one ledge from yielding two jumps to a held button.
   *
   * Separate from `grounded`, which stays the honest answer to "is there ground under us" — it is what the
   * animation and the wire flag read (`STATE_GROUNDED`), and a character in its coyote window is in the air.
   */
  coyote: number
}

const addVec = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z)
const subVec = (a: Vec3, b: Vec3): Vec3 => vec3(a.x - b.x, a.y - b.y, a.z - b.z)
/** World point → the frame's local space. */
const toLocal = (f: PlatformFrame, world: Vec3): Vec3 => rotateVec3(conjQuat(f.rotation), subVec(world, f.position))
/** Local point → world space under the frame's current pose. */
const toWorld = (f: PlatformFrame, local: Vec3): Vec3 => addVec(f.position, rotateVec3(f.rotation, local))

/** Deterministic fallback spawn spread around the origin by id (used when a level has
 * no spawn marker). */
export const playerSpawn = (playerId: number): Vec3 => {
  const a = playerId * 2.399963
  return vec3(Math.cos(a) * 5, 2, Math.sin(a) * 5)
}

/** `addCharacter` with the controller's collision parameters overridden — for experiments and
 * tests that need to probe the controller's behaviour. Modes should use `addCharacter`. */
export const addCharacterWith = (world: PhysicsWorld, spawn: Vec3, opts: Partial<CharacterOptions>): CharacterState => ({
  body: world.addCharacter({ position: spawn, radius: CHAR_RADIUS, halfHeight: CHAR_HALF_HEIGHT, ...opts }),
  vx: 0,
  vz: 0,
  vy: 0,
  launch: 0,
  coyote: 0,
  grounded: false,
  base: undefined,
  carry: vec3(0, 0, 0),
})

/** `layers` is the mode's, not the controller's: which collision layers this capsule takes part in. */
export const addCharacter = (world: PhysicsWorld, spawn: Vec3, layers?: CollisionLayers): CharacterState => ({
  body: world.addCharacter({
    position: spawn,
    radius: CHAR_RADIUS,
    halfHeight: CHAR_HALF_HEIGHT,
    ...(layers === undefined ? {} : { layers }),
  }),
  vx: 0,
  vz: 0,
  vy: 0,
  launch: 0,
  coyote: 0,
  grounded: false,
  base: undefined,
  carry: vec3(0, 0, 0),
})

// Move `cur` toward `target` by at most `maxDelta` (frame-rate-independent accel).
const approach = (cur: number, target: number, maxDelta: number): number => {
  const d = target - cur
  return Math.abs(d) <= maxDelta ? target : cur + Math.sign(d) * maxDelta
}

/**
 * Advance one character by one fixed step (ADR 0012). Deterministic.
 * - Jump: fixed-apex impulse, v₀ = √(2·g·h) → reaches exactly `jumpHeight`. Still fires for
 *   `coyoteTime` after footing is lost, spent on the way out so one ledge is one jump.
 * - Ground: eases toward the input over `groundAccelTime`; brakes over `groundStopTime`.
 * - Air: `airControl`× steering, momentum otherwise preserved.
 * - Jumping off a moving platform inherits its velocity, so a jump from a fast mover is flung
 *   along with it (Kodjo's call). Walking off inherits nothing.
 *
 * **Riding a moving platform is ours to do** (`platforms`), the way engines do it — Unreal's
 * movement base, Godot's platform floor, Quake's ground entity. The character remembers which
 * surface it stands on and its position *in that surface's frame*, and each tick is placed where
 * that local point has moved to. Because the position is re-derived from the frame rather than
 * nudged by a delta, it cannot drift and cannot double-apply.
 *
 * This requires that nothing else also moves the character. Rapier's controller will happily add a
 * kinematic ground body's velocity itself — but only on some ticks — so the piece being ridden is
 * posed with zero derived velocity, which keeps the controller out of it. Pass
 * `CharacterState.base?.colliderHandle` to `LoadedLevel.update` to arrange that; every *other*
 * piece keeps its velocity, which is what still lets a moving piece shove a character it sweeps
 * into. The two halves belong together: see `update` in the loader.
 *
 * Call after the platforms have been advanced and stepped for this tick, so the ground probe and
 * `platforms` both see where they are now.
 */
export const stepCharacter = (
  state: CharacterState,
  cmd: InputCommand,
  dt: number,
  tuning: CharacterTuning = DEFAULT_TUNING,
  platforms?: PlatformPoseLookup,
): void => {
  // --- footing ------------------------------------------------------------------------------
  // Decided by an explicit downward probe, not the controller's `grounded` flag: that flag
  // reports false for isolated ticks while resting (measured on a moving platform), which would
  // drop jumps and release the ride. The probe runs first, from where the character is now — the
  // platforms have already moved this tick — so `frame` is the pose to measure against.
  const under = state.body.probeGround()
  const frame = under !== undefined && platforms !== undefined ? platforms(under.colliderHandle) : undefined
  // Where the character *should* be: its stored local point under the surface's new pose. The
  // difference from where it is now is handed to the controller together with the character's own
  // movement below, and never applied as a teleport — moving the collider behind the controller's
  // back leaves Rapier's query pipeline stale, and `computeColliderMovement` then resolves to
  // nothing (the character silently cannot walk, and gets shoved through walls).
  let ride: Vec3 | undefined
  if (frame !== undefined && under !== undefined && state.base?.colliderHandle === under.colliderHandle) {
    ride = subVec(toWorld(frame, state.base.localPos), state.body.translation())
  }

  // Coyote time: for `coyoteTime` after footing is lost, a jump still fires. Without it a press at the
  // very edge of a ledge is simply gone — one tick is 33 ms at 30 Hz and the gate below reads footing as
  // of the end of the previous step, so there is no grace at all. `coyote` is refreshed at the bottom of
  // this function alongside `grounded`, so both describe the same instant.
  const jumping = cmd.jump && (state.grounded || state.coyote > 0)
  // A launch leaves the surface exactly as a jump does, so every decision below keys off `leaving` rather than
  // off `jumping`. A bumper does not require footing: you can be thrown by clipping one in the air.
  const launching = state.launch > 0
  const leaving = jumping || launching
  // Spend the grace on the way out. Without this the counter keeps running while airborne and a held
  // button gets a second jump out of the same ledge, two ticks after the first.
  if (leaving) state.coyote = 0
  const riding = ride !== undefined && !leaving

  // A launch outranks a jump on the tick both land: the bumper is the bigger, more deliberate event, and
  // taking the larger of the two would let a jump silently weaken a weak bumper.
  if (launching) state.vy = state.launch
  else if (jumping) state.vy = Math.sqrt(2 * tuning.gravity * tuning.jumpHeight)
  state.launch = 0
  // While riding, the surface owns our vertical. Gravity must not fight a rising platform: it
  // loses by the difference each tick, and the character is left behind and drops off the edge
  // (measured: applying gravity while riding a 3 m/s elevator falls through to y ≈ −1085).
  if (riding) state.vy = 0
  else state.vy -= tuning.gravity * dt
  // Terminal velocity. Clamped after gravity and before the ride inherit below, so it bounds the fall
  // itself and never clips a launch or a jump — both of those are a positive `vy`.
  if (state.vy < -tuning.maxFallSpeed) state.vy = -tuning.maxFallSpeed

  const len = Math.hypot(cmd.moveX, cmd.moveZ)
  const scale = len > 1 ? 1 / len : 1
  const targetX = cmd.moveX * scale * tuning.moveSpeed
  const targetZ = cmd.moveZ * scale * tuning.moveSpeed
  const hasInput = cmd.moveX !== 0 || cmd.moveZ !== 0

  const accel = tuning.moveSpeed / Math.max(tuning.groundAccelTime, 1e-3)
  if (state.grounded) {
    const rate = hasInput ? accel : tuning.moveSpeed / Math.max(tuning.groundStopTime, 1e-3)
    state.vx = approach(state.vx, targetX, rate * dt)
    state.vz = approach(state.vz, targetZ, rate * dt)
  } else if (hasInput) {
    const rate = accel * tuning.airControl
    state.vx = approach(state.vx, targetX, rate * dt)
    state.vz = approach(state.vz, targetZ, rate * dt)
  }

  // Jumping off a mover inherits its velocity: the distance it would have carried us, over dt.
  // Added *after* the horizontal solve — this tick still counts as grounded, so doing it earlier
  // would let the ground brake (no input → stop in `groundStopTime`) eat most of it again. The
  // ride is then dropped for this tick: velocity carries the motion instead, and doing both would
  // move us twice.
  if (leaving && ride !== undefined) {
    state.vx += ride.x / dt
    state.vy += ride.y / dt
    state.vz += ride.z / dt
  }

  // One translation for the controller to resolve: our own movement plus the surface's. The ridden
  // piece is posed without velocity, so the controller adds nothing of its own for that surface and
  // this is the only thing carrying us. The vertical while riding is the surface's alone — see the
  // gravity note above.
  const desired = {
    x: state.vx * dt + (riding ? ride!.x : 0),
    y: riding ? ride!.y : state.vy * dt,
    z: state.vz * dt + (riding ? ride!.z : 0),
  }

  const { grounded, applied, ceiling } = state.body.move(desired)

  // Everything the controller resolved horizontally that locomotion did not ask for: the ride, a
  // sweeping piece's shove, and a wall taking momentum away. Vertically it is the ride alone —
  // `applied.y` also cancels the gravity nudge on every grounded tick, and taking that difference
  // would report a permanent upward push from the floor holding us up. Snap-to-ground and autostep
  // land in `applied.y` for the same reason, which is the other half of why only x/z come from it.
  state.carry = vec3((applied.x - state.vx * dt) / dt, riding ? ride!.y / dt : 0, (applied.z - state.vz * dt) / dt)

  // Either signal counts as footing: the probe covers the controller's flicker, and the controller
  // covers surfaces the probe's narrow ray misses (standing on an edge, wedged against geometry).
  // The probe was taken before this step ran, so it must not vouch for a tick that jumped away.
  state.grounded = grounded || (under !== undefined && !leaving)
  // Refill the grace whenever there is footing, count it down otherwise. Not while leaving: the first tick
  // of a jump can still report footing (the sweep starts on the surface it is pushing off), and refilling
  // there would hand a held button that second jump the line above just took away.
  state.coyote = state.grounded && !leaving ? tuning.coyoteTime : Math.max(0, state.coyote - dt)
  if (state.grounded && state.vy < 0) state.vy = 0
  // A roof ends the rise, the way footing ends the fall on the line above. Without it `vy` stays
  // positive with nowhere to go: the character hangs under the ceiling for the rest of its hang time,
  // pushing into it every tick, and reports itself as rising the whole way up (the `STATE_RISING`
  // flag, so the animation says so too). Skipped while riding — there the vertical belongs to the
  // surface and `vy` is already 0, so a rising platform pressing us into a roof is the surface's
  // problem to resolve, not a jump to cancel.
  if (ceiling && !riding && state.vy > 0) state.vy = 0

  // Re-anchor in the base's frame. `move` only sets the body's target for this tick's step, so the
  // final position is where we are plus what it resolved. Doing this every tick is what lets
  // walking (and being pushed, and being blocked by a wall) change where on the platform we stand,
  // while the ride itself stays exact. A jump releases the base outright; otherwise it lives as
  // long as the probe still finds that surface underfoot.
  if (frame !== undefined && under !== undefined && !leaving) {
    const finalPos = addVec(state.body.translation(), applied)
    state.base = { colliderHandle: under.colliderHandle, localPos: toLocal(frame, finalPos) }
  } else {
    state.base = undefined
  }
}

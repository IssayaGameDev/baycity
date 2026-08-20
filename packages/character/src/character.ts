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
  jumpBufferTime: number // s a jump press is held pending, so a press before landing still fires (0 = off)
  liftStoreTime: number // s a departed mover's velocity stays available to a late jump (0 = off)
  /**
   * Arc shaping — what turns the plain parabola into a jump with a character. Each has an inert value
   * (`fallGravityScale` 1 mirrors the fall to the rise, `apexGravityScale` 1 cancels the apex window
   * whatever `apexSpeed` says, `jumpCutScale` 1 leaves a released jump alone), so any one of them can be
   * switched off on its own without touching the others.
   */
  fallGravityScale: number // gravity multiplier while falling (1 = symmetric arc; 1.5–2.5 is the usual range)
  apexGravityScale: number // gravity multiplier while |vy| < apexSpeed (1 = off; Celeste uses 0.5)
  apexSpeed: number // m/s of vertical speed under which the arc counts as "at the apex"
  jumpCutScale: number // vy multiplier when the jump button is released while rising (1 = off, 0 = hard stop)
}

/**
 * Kodjo's call. Faster and higher than the Roblox reference (4.5 / 2), which widens the obstacle
 * envelope: 3.6 m maximum gap and 3.1 m maximum step-up, measured. Gravity is unchanged, so the
 * higher apex also means a longer hang — 0.66 s of air per jump against 0.54 s before.
 *
 * **`jumpHeight` reads 2.7 where it used to read 3, and the jump did not change.** It could not mean
 * what it said until the vertical integration was exact (see `stepCharacter`): the old
 * `y += v·dt` undershot every apex by `½·v₀·dt` — half a tick of take-off speed, 0.30 m here — so a
 * configured 3 produced a measured 2.700. The integration is now exact and the apex is the number,
 * so the number was set to the apex that has always been flying. Typing 3.0 back in is a real
 * change for the first time: +0.30 m of apex, +0.18 m of reach, one more tick of air.
 */
export const DEFAULT_TUNING: CharacterTuning = {
  moveSpeed: 5.5,
  jumpHeight: 2.7,
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
  // 100 ms of buffer: Celeste uses 4 frames (67 ms), the survey demos ~116 ms.
  jumpBufferTime: 0.1,
  // Matched to `coyoteTime` on purpose — its whole job is to make a coyote jump off a mover behave like
  // a normal one, and a different number would just move the inconsistency somewhere else.
  liftStoreTime: 0.1,
  // The three arc values below are **the literature's starting points, switched on** (ADR 0041). They are
  // where a tuning pass begins, not where it ends: Kodjo tunes by playing, and each reverts on its own to
  // the inert value noted in the interface above. Shipping them at inert was the wrong call — it delivered
  // sliders at zero and no way to feel the arc they were built for.
  // Fall heavier than the rise: the single most common shaping change, usual range 1.5–2.5.
  fallGravityScale: 1.6,
  // Half gravity near the top, which is Celeste's value. Buys time to aim a landing.
  apexGravityScale: 0.5,
  // The window that counts as "the apex": 4 m/s is the last ~0.07 s either side of the top.
  apexSpeed: 4,
  // **Off.** Variable jump height needs input resolution this stack does not have: at 30 Hz a tap is one
  // latched tick, so the cut is two-valued (tap or hold) rather than a range, and at 0.4 the tap landed at
  // 0.89 m against a 2.7 m hold — a third of the jump for the *default* way people press a button. On a
  // fast riser a cut jump barely cleared the deck before the platform collected it again. The reference
  // 3D platformer (Mario 64) has no release-cut at all. The mechanism stays; doing it properly needs a
  // minimum-jump-time guard so a tap still buys a decent floor, which is not built.
  jumpCutScale: 1,
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
  /**
   * Seconds a jump press stays pending. Refilled to `jumpBufferTime` on every tick the button is down,
   * counted down otherwise, and spent when the jump fires. The mirror of `coyote`: that one forgives a
   * press made slightly *late*, this one forgives a press made slightly *early*, and between them a
   * press near a landing or a ledge lands instead of disappearing.
   */
  jumpBuffer: number
  /**
   * Is the current rise a jump that the player may still cut short by releasing the button? Set when a
   * jump fires, cleared by the cut, by a launch, and by landing. A launch clears it because cutting a
   * bumper would let the player cancel the level's own throw.
   */
  jumpCut: boolean
  /**
   * The last velocity (m/s) a ridden surface was imparting, and how long it stays on offer. A jump that
   * still has a live `ride` takes the velocity from that directly; this covers the case where footing
   * was lost first and the jump comes out of the coyote window, which would otherwise silently drop the
   * mover's momentum (Celeste calls it lift momentum storage).
   */
  liftVel: Vec3
  liftStore: number
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
  jumpBuffer: 0,
  jumpCut: false,
  liftVel: vec3(0, 0, 0),
  liftStore: 0,
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
  jumpBuffer: 0,
  jumpCut: false,
  liftVel: vec3(0, 0, 0),
  liftStore: 0,
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
  let under = state.body.probeGround()
  // A platform can descend faster than the probe reaches. The ray covers the snap distance — 0.4 m below
  // the feet — while a rider sits up to about a tick of travel behind a descending deck, so from roughly
  // 7 m/s down the lag plus one tick of drop is further than the ray goes: footing vanishes, gravity takes
  // over, the character free-falls until it catches the deck, locks on, and loses it again. That is the
  // bounce-falling report. Take a second, longer look — but only when the first one missed, only for the
  // surface we were already riding, and only as far as that surface's own speed justifies (`liftVel` is
  // the ride velocity from last tick). Nothing changes on static ground, where `liftVel` is zero.
  if (under === undefined && state.base !== undefined && platforms !== undefined) {
    const baseFrame = platforms(state.base.colliderHandle)
    if (baseFrame !== undefined) {
      // Exactly how far the point we were standing on has dropped away from us. Not a velocity estimate:
      // `liftVel` only fills in after a full tick of riding, and a fast descender takes the base away
      // before that, so the estimate read zero on precisely the ticks it was needed.
      const away = -subVec(toWorld(baseFrame, state.base.localPos), state.body.translation()).y
      if (away > 0) {
        const deeper = state.body.probeGround(away)
        if (deeper !== undefined && deeper.colliderHandle === state.base.colliderHandle) under = deeper
      }
    }
  }
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

  // The press is held pending for `jumpBufferTime` rather than read as a level. Two reasons, and the
  // buffer is the only thing that answers either: a press made just before landing is otherwise thrown
  // away, and a press shorter than one tick is otherwise never seen at all (33 ms at 30 Hz — the mode
  // latches the keydown, and this is what keeps that latch alive long enough to be spent).
  if (cmd.jump) state.jumpBuffer = tuning.jumpBufferTime
  else state.jumpBuffer = Math.max(0, state.jumpBuffer - dt)

  // Coyote time: for `coyoteTime` after footing is lost, a jump still fires. Without it a press at the
  // very edge of a ledge is simply gone, since the gate below reads footing as of the end of the
  // previous step. `coyote` is refreshed at the bottom of this function alongside `grounded`, so both
  // describe the same instant. The two forgivenesses meet here: the buffer forgives early, coyote late.
  const jumping = state.jumpBuffer > 0 && (state.grounded || state.coyote > 0)
  // A launch leaves the surface exactly as a jump does, so every decision below keys off `leaving` rather than
  // off `jumping`. A bumper does not require footing: you can be thrown by clipping one in the air.
  const launching = state.launch > 0
  const leaving = jumping || launching
  // Spend both windows on the way out. Without this the counters keep running while airborne and a held
  // button gets a second jump out of the same ledge, two ticks after the first.
  if (leaving) {
    state.coyote = 0
    state.jumpBuffer = 0
  }
  const riding = ride !== undefined && !leaving

  // A launch outranks a jump on the tick both land: the bumper is the bigger, more deliberate event, and
  // taking the larger of the two would let a jump silently weaken a weak bumper.
  if (launching) state.vy = state.launch
  else if (jumping) state.vy = Math.sqrt(2 * tuning.gravity * tuning.jumpHeight)
  // Only a jump is the player's to cut short. A launch clears the flag instead of setting it, because
  // letting go of the button must not cancel a throw the level gave you.
  if (launching) state.jumpCut = false
  else if (jumping) state.jumpCut = true
  state.launch = 0

  // Variable jump height: releasing the button mid-rise keeps the fraction of the climb still to come.
  // Gated on `!jumping` so the jump's own tick is never cut — with the buffer, a tap is `cmd.jump` for a
  // single tick and the release lands on the very next one, which is exactly the short hop being asked
  // for; a held button never satisfies this at all, and gets the full arc.
  if (state.jumpCut && !jumping && !cmd.jump && state.vy > 0) {
    state.vy *= tuning.jumpCutScale
    state.jumpCut = false
  }

  // Vertical velocity at the start of this tick's integration, kept for the exact position update below.
  let vyStart = state.vy
  // While riding, the surface owns our vertical. Gravity must not fight a rising platform: it
  // loses by the difference each tick, and the character is left behind and drops off the edge
  // (measured: applying gravity while riding a 3 m/s elevator falls through to y ≈ −1085).
  if (riding) {
    state.vy = 0
    vyStart = 0
  } else {
    // Gravity is a curve, not a constant: heavier on the way down than the way up shortens the fall
    // without lowering the apex, and lighter near the top buys hang time to aim a landing. Decided from
    // the speed at the *start* of the tick, so a tick is never half in one regime and half in another.
    //
    // Only ever applied to an **arc**, which is why it is gated on having no ground underfoot. A resting
    // character sits at `vy = 0`, which is inside any apex window, so an ungated version quietly halved
    // gravity while standing still — and that number is the nudge holding the capsule in contact, so
    // halving it destabilised the controller's horizontal resolve exactly as the settling case below
    // describes (platform carry crept 33 mm over 3 s). The apex of a jump is not the top of a stand.
    const airborne = under === undefined || leaving
    const scale = !airborne
      ? 1
      : Math.abs(vyStart) < tuning.apexSpeed
        ? tuning.apexGravityScale
        : vyStart < 0
          ? tuning.fallGravityScale
          : 1
    state.vy -= tuning.gravity * scale * dt
    // Terminal velocity. Clamped after gravity and before the ride inherit below, so it bounds the fall
    // itself and never clips a launch or a jump — both of those are a positive `vy`.
    if (state.vy < -tuning.maxFallSpeed) state.vy = -tuning.maxFallSpeed
  }

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
    // Air input steers and accelerates. It must never *brake* a character already travelling faster
    // than `moveSpeed`, which is what a plain approach toward a `moveSpeed`-sized target does: launched
    // off a fast mover at 12 m/s, holding the direction of flight measured 5.02 m of travel against
    // 8.40 m for letting go of the stick. Pressing the way you are going cost you three and a half
    // metres, which nobody would guess and which reads as the mover being unreliable.
    //
    // The rule is that speed above `moveSpeed` is not air control's to spend. Air control owns
    // `moveSpeed` worth of velocity and steers it exactly as before; anything on top — a mover's fling,
    // a bumper — rides along untouched. Four properties, all of them wanted:
    // - pressing the way you are going is now free: the steered part is already there, so it neither
    //   accelerates nor brakes, and holding forward matches letting go to the millimetre;
    // - pressing *against* the motion still brakes and turns at the full rate, which is the correction
    //   the player is reaching for. It just cannot cancel the fling itself;
    // - speed can never exceed what you came in with, since the most air control can do is align its
    //   own `moveSpeed` with the excess. Quake's projection cap *does* exceed it — that is air-strafing,
    //   and the skill ceiling with it — at the price of every reach number in `docs/obstacles.md`, so it
    //   stays rejected;
    // - turning costs speed, monotonically: the excess stays pointed where it was while the steered part
    //   swings away from it, so the two partly cancel. An earlier version stretched the *target* to the
    //   current speed instead, which fed back on itself and conserved speed through a 90° turn — a fast
    //   mover could be redirected losslessly, which is air-strafing arriving by the back door;
    // - below the cap the branch does not fire at all, so ordinary jumps are bit-for-bit as before.
    const speed = Math.hypot(state.vx, state.vz)
    if (speed > tuning.moveSpeed) {
      // Split the velocity into `moveSpeed` worth of it, which air control steers exactly as it always
      // has, and the **excess** above that, which it may not touch. The excess is carried through the
      // tick unchanged and added back along the direction it came in on.
      const excess = speed - tuning.moveSpeed
      const ex = (state.vx / speed) * excess
      const ez = (state.vz / speed) * excess
      state.vx = approach(state.vx - ex, targetX, rate * dt) + ex
      state.vz = approach(state.vz - ez, targetZ, rate * dt) + ez
    } else {
      state.vx = approach(state.vx, targetX, rate * dt)
      state.vz = approach(state.vz, targetZ, rate * dt)
    }
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
    vyStart += ride.y / dt
    state.liftStore = 0
  } else if (leaving && state.liftStore > 0) {
    // Lift momentum storage: the jump came out of the coyote window, so footing — and with it the live
    // `ride` the branch above reads — was already gone. Without this the mover's momentum vanishes for
    // exactly the late jumps coyote time exists to allow, and the fast platform reads as randomly eating
    // your jump. Consumed, so one departure hands it over once.
    state.vx += state.liftVel.x
    state.vy += state.liftVel.y
    state.vz += state.liftVel.z
    vyStart += state.liftVel.y
    state.liftStore = 0
  }

  // One translation for the controller to resolve: our own movement plus the surface's. The ridden
  // piece is posed without velocity, so the controller adds nothing of its own for that surface and
  // this is the only thing carrying us. The vertical while riding is the surface's alone — see the
  // gravity note above.
  //
  // The vertical is the **trapezoid** `½(v₀+v₁)·dt`, not `v₁·dt`, and that is not a refinement: for a
  // constant acceleration it is the exact integral, where `v₁·dt` undershoots by `½·g·dt²` every single
  // tick. Accumulated over a rise that is `½·v₀·dt` — half a tick of take-off speed, 0.30 m at these
  // numbers — so `jumpHeight` used to be short by 10% and the slider could not mean what it said.
  // Same closed form as the `½at²` term; written as an average because the clamp above can bend `v₁`,
  // and the average of the endpoints stays right when it does.
  //
  // Except while **settling** — resting on a surface, going nowhere. There `vy` is clamped back to 0 at
  // the end of every tick, so no fall is being integrated and the downward number is not motion at all:
  // it is the nudge that keeps the capsule in contact. Halving it to the "exact" value measurably
  // destabilises the controller's resolve — Rapier starts dropping slices of the *horizontal* step
  // (`CONTACT_NUDGE` in the physics wrapper: the start has to not be touching), which showed up as
  // platform carry creeping 33 mm over 3 s where it used to hold to the millimetre. So a settling tick
  // keeps pressing down by the full `v·dt`. Every tick of an actual arc — the jump's own tick, which is
  // `leaving`, and all the airborne ones — takes the exact form, so the apex is unaffected.
  // Keyed on the **probe**, not on `state.grounded`: the flag is last tick's answer and is `false` on a
  // freshly spawned character, so a capsule settling onto a surface for the first time took the exact
  // value, seated at a different depth, and stayed flaky from then on. `under` is this tick's ground.
  const settling = under !== undefined && !leaving && state.vy <= 0
  const desired = {
    x: state.vx * dt + (riding ? ride!.x : 0),
    y: riding ? ride!.y : (settling ? state.vy : 0.5 * (vyStart + state.vy)) * dt,
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
  // Rising away from a surface is not standing on it, and both footing and the movement base have to say
  // so. A fast riser is still well inside the ground probe's reach one tick after take-off, so without
  // this the deck re-captures the character while `vy` is still 20+ m/s upward: a held button re-jumps
  // and discards the platform velocity it had just inherited (measured 24.4 -> 15.4 m/s off a 9 m/s
  // riser, exactly the platform's speed thrown away), and a released one has `riding` zero the climb
  // outright. Either way the jump dies a tick after it started and the deck collects you.
  const standing = under !== undefined && !leaving && state.vy <= 0
  state.grounded = (grounded && state.vy <= 0) || standing
  // Refill the grace whenever there is footing, count it down otherwise. Not while leaving: the first tick
  // of a jump can still report footing (the sweep starts on the surface it is pushing off), and refilling
  // there would hand a held button that second jump the line above just took away.
  state.coyote = state.grounded && !leaving ? tuning.coyoteTime : Math.max(0, state.coyote - dt)
  // What the surface underfoot was imparting, kept on offer for `liftStoreTime` after it is gone. Read
  // from `ride`, which is the ride actually resolved this tick, so it is the same quantity the live
  // branch above would have used — a late jump and an on-time one inherit the same thing.
  if (ride !== undefined && !leaving) {
    state.liftVel = vec3(ride.x / dt, ride.y / dt, ride.z / dt)
    state.liftStore = tuning.liftStoreTime
  } else if (!leaving) state.liftStore = Math.max(0, state.liftStore - dt)
  if (state.grounded && state.vy < 0) state.vy = 0
  // Landing ends the rise, so there is no jump left to cut.
  if (state.grounded) state.jumpCut = false
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
  let baseHandle = under?.colliderHandle
  let baseFrame = frame
  // Footing the probe could not see. The controller resolves against the capsule's whole surface while the
  // probe is a single ray from its centre, so on a surface dropping away fast the controller reports
  // contact a tick or two before the ray reaches it. In that window `grounded` clamps the fall to zero
  // while no base is acquired — the fall is cancelled and nothing is gained for it, the platform pulls
  // further away, and the character re-accelerates into the same wall next tick. That is the bounce-fall
  // on a fast descender. So when the probe missed and the controller says otherwise, take the base from
  // the collider it actually touched.
  if (baseFrame === undefined && grounded && !leaving && platforms !== undefined) {
    for (const h of state.body.collisions()) {
      const touched = platforms(h)
      if (touched !== undefined) {
        baseHandle = h
        baseFrame = touched
        break
      }
    }
  }
  if (baseFrame !== undefined && baseHandle !== undefined && !leaving && state.vy <= 0) {
    const finalPos = addVec(state.body.translation(), applied)
    state.base = { colliderHandle: baseHandle, localPos: toLocal(baseFrame, finalPos) }
  } else {
    state.base = undefined
  }
}

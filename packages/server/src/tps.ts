import { vec3, type Vec3 } from '@mp/core'
import type { InputCommand } from '@mp/net'
import { createPhysicsWorld, type CharacterBody, type PhysicsWorld } from '@mp/physics'

/**
 * Deterministic TPS character simulation. Client-authoritative (ADR 0011): each
 * client runs this to drive its own character (the authority for its body). The
 * server no longer simulates, and bots synthesize positions rather than run this.
 * Despite the `@mp/server` home (a historical wart from M10; relocation is future
 * cleanup), it has no server-only deps and is imported via the `@mp/server/tps` subpath.
 *
 * Locomotion is Roblox-like and kinematic (ADR 0012); feel lives in `CharacterTuning`
 * and is tuned live in the demo. Camera feel is client-only (tunable there).
 */
export const TICK_RATE_HZ = 30
export const TICK_DT = 1 / TICK_RATE_HZ
export const CHAR_RADIUS = 0.4
export const CHAR_HALF_HEIGHT = 0.6
export const FIRST_PLAYER_ID = 1000

/**
 * Roblox-like locomotion feel (ADR 0012). Client-authoritative (ADR 0011), so
 * these are pure client-side values — safe to tune live and not a prediction
 * contract. `DEFAULT_TUNING` is Roblox's defaults converted from studs
 * (~0.28 m/stud); the demo exposes them as debug sliders. Provisional — Kodjo tunes.
 */
export interface CharacterTuning {
  moveSpeed: number // m/s target ground speed (Roblox WalkSpeed 16 studs ≈ 4.5)
  jumpHeight: number // m apex above launch (Roblox JumpHeight 7.2 studs ≈ 2)
  gravity: number // m/s² downward magnitude (Roblox 196.2 studs/s² ≈ 55; high = snappy)
  groundAccelTime: number // s to reach full speed from rest
  groundStopTime: number // s to brake to a stop when input is released
  airControl: number // 0..1 air steering strength relative to ground accel
}

export const DEFAULT_TUNING: CharacterTuning = {
  moveSpeed: 4.5,
  jumpHeight: 2,
  gravity: 55,
  groundAccelTime: 0.1,
  groundStopTime: 0.08,
  airControl: 0.3,
}

/** Character state beyond position: horizontal velocity (for momentum + accel),
 * vertical velocity, and grounded (for gravity/jump). */
export interface CharacterState {
  body: CharacterBody
  vx: number
  vz: number
  vy: number
  grounded: boolean
}

/** Deterministic spawn from the player's entity id, spread around the origin. */
export const playerSpawn = (playerId: number): Vec3 => {
  const a = playerId * 2.399963
  return vec3(Math.cos(a) * 5, 2, Math.sin(a) * 5)
}

/** A static box: `position` (center) + `halfExtents`. Shared so the client renders
 * the same geometry the server/client simulate against. */
export interface Box {
  position: Vec3
  halfExtents: Vec3
}

export const GROUND: Box = { position: { x: 0, y: 0, z: 0 }, halfExtents: { x: 25, y: 0.1, z: 25 } }

/** Throwaway obstacle course: a box to jump on, a low step to walk up, a wall to block.
 * No ramps — the wrapper has no collider rotation. */
export const TPS_OBSTACLES: Box[] = [
  { position: { x: 5, y: 0.5, z: 0 }, halfExtents: { x: 1, y: 0.5, z: 1 } },
  { position: { x: -4, y: 0.15, z: 3 }, halfExtents: { x: 3, y: 0.15, z: 2 } },
  { position: { x: 0, y: 1, z: -8 }, halfExtents: { x: 6, y: 1, z: 0.3 } },
]

/**
 * A vertical elevator that oscillates on the shared clock. Its height is a pure
 * function of server time, so every client computes the same position from
 * `serverNow()` with no per-platform state on the wire (ADR 0013 — validates the
 * clock foundation for synced world objects). Throwaway demo content.
 */
export const MOVING_PLATFORM = {
  center: { x: -4, y: 1.4, z: -3 } as Vec3,
  halfExtents: { x: 1.5, y: 0.2, z: 1.5 } as Vec3,
  amplitudeY: 1.2,
  periodMs: 4000,
}
export const platformY = (serverTimeMs: number): number =>
  MOVING_PLATFORM.center.y + MOVING_PLATFORM.amplitudeY * Math.sin((serverTimeMs / MOVING_PLATFORM.periodMs) * Math.PI * 2)

/** Checkpoints (client-detected, locally persisted): the player respawns at the last
 * one they touched. Placement is game design; two throwaway spots for now (ADR 0013). */
export const CHECKPOINTS: readonly Vec3[] = [
  { x: 8, y: 1.5, z: 8 },
  { x: -8, y: 1.5, z: -6 },
]
export const CHECKPOINT_RADIUS = 1.5

export const createTpsWorld = (): PhysicsWorld => {
  // Nothing dynamic reads world gravity here (kinematic character + static course
  // + kinematic remote mirrors), so it's zero; the character integrates its own
  // gravity in stepCharacter (tunable, ADR 0012).
  const world = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } })
  for (const b of [GROUND, ...TPS_OBSTACLES]) {
    world.addFixedBody({ position: b.position, shape: { kind: 'cuboid', halfExtents: b.halfExtents } })
  }
  return world
}

export const addCharacter = (world: PhysicsWorld, spawn: Vec3): CharacterState => ({
  body: world.addCharacter({ position: spawn, radius: CHAR_RADIUS, halfHeight: CHAR_HALF_HEIGHT }),
  vx: 0,
  vz: 0,
  vy: 0,
  grounded: false,
})

// Move `cur` toward `target` by at most `maxDelta` (frame-rate-independent accel).
const approach = (cur: number, target: number, maxDelta: number): number => {
  const d = target - cur
  return Math.abs(d) <= maxDelta ? target : cur + Math.sign(d) * maxDelta
}

/**
 * Advance one character by one fixed step, Roblox-like (ADR 0012). Deterministic.
 * - Jump: a fixed-apex impulse — v₀ = √(2·g·h) so releasing on the ground reaches
 *   exactly `jumpHeight`, independent of gravity.
 * - Ground: horizontal velocity eases toward the input direction over
 *   `groundAccelTime`, and brakes to a stop over `groundStopTime` when idle.
 * - Air: `airControl` scales the steering rate and momentum is otherwise preserved
 *   (no braking) — you can nudge your trajectory mid-jump but not stop or reverse it.
 */
export const stepCharacter = (
  state: CharacterState,
  cmd: InputCommand,
  dt: number,
  tuning: CharacterTuning = DEFAULT_TUNING,
): void => {
  // Vertical: fixed-apex jump, then integrate gravity.
  if (cmd.jump && state.grounded) state.vy = Math.sqrt(2 * tuning.gravity * tuning.jumpHeight)
  state.vy -= tuning.gravity * dt

  // Horizontal target from the (world-space) input direction, clamped to unit length.
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
  } // else airborne + no input: keep vx/vz (momentum)

  const { grounded } = state.body.move({ x: state.vx * dt, y: state.vy * dt, z: state.vz * dt })
  state.grounded = grounded
  if (grounded && state.vy < 0) state.vy = 0
}

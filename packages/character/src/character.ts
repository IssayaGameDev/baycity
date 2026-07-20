import { vec3, type Vec3 } from '@mp/core'
import type { InputCommand } from '@mp/net'
import { type CharacterBody, type PhysicsWorld } from '@mp/physics'

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

/** Character state beyond position: horizontal velocity (momentum + accel), vertical
 * velocity, and grounded. */
export interface CharacterState {
  body: CharacterBody
  vx: number
  vz: number
  vy: number
  grounded: boolean
}

/** Deterministic fallback spawn spread around the origin by id (used when a level has
 * no spawn marker). */
export const playerSpawn = (playerId: number): Vec3 => {
  const a = playerId * 2.399963
  return vec3(Math.cos(a) * 5, 2, Math.sin(a) * 5)
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
 * Advance one character by one fixed step (ADR 0012). Deterministic.
 * - Jump: fixed-apex impulse, v₀ = √(2·g·h) → reaches exactly `jumpHeight`.
 * - Ground: eases toward the input over `groundAccelTime`; brakes over `groundStopTime`.
 * - Air: `airControl`× steering, momentum otherwise preserved.
 */
export const stepCharacter = (
  state: CharacterState,
  cmd: InputCommand,
  dt: number,
  tuning: CharacterTuning = DEFAULT_TUNING,
): void => {
  if (cmd.jump && state.grounded) state.vy = Math.sqrt(2 * tuning.gravity * tuning.jumpHeight)
  state.vy -= tuning.gravity * dt

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

  const { grounded } = state.body.move({ x: state.vx * dt, y: state.vy * dt, z: state.vz * dt })
  state.grounded = grounded
  if (grounded && state.vy < 0) state.vy = 0
}

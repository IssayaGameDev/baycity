import { vec3, type Vec3 } from '@mp/core'
import type { InputCommand } from '@mp/net'
import { createPhysicsWorld, type CharacterBody, type PhysicsWorld } from '@mp/physics'

/**
 * Deterministic TPS character simulation. Client-authoritative (ADR 0011): each
 * client runs this to drive its own character (the authority for its body); bots
 * run it headless too. The server no longer simulates. Despite the `@mp/server`
 * home (a historical wart from M10; relocation is future cleanup), it has no
 * server-only deps and is imported via the `@mp/server/tps` subpath.
 *
 * Movement/jump feel values are shared constants so every client's own body moves
 * identically. Camera feel is client-only (tunable there).
 */
export const TICK_RATE_HZ = 30
export const TICK_DT = 1 / TICK_RATE_HZ
export const GRAVITY = -20 // stronger than -9.81 for a snappier jump (feel)
export const MOVE_SPEED = 6 // units/s
export const JUMP_SPEED = 8 // units/s initial (apex ≈ 1.6 units)
export const CHAR_RADIUS = 0.4
export const CHAR_HALF_HEIGHT = 0.6
export const FIRST_PLAYER_ID = 1000

/** Character state beyond position: vertical velocity + grounded (for gravity/jump). */
export interface CharacterState {
  body: CharacterBody
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

export const createTpsWorld = (): PhysicsWorld => {
  const world = createPhysicsWorld({ gravity: { x: 0, y: GRAVITY, z: 0 } })
  for (const b of [GROUND, ...TPS_OBSTACLES]) {
    world.addFixedBody({ position: b.position, shape: { kind: 'cuboid', halfExtents: b.halfExtents } })
  }
  return world
}

export const addCharacter = (world: PhysicsWorld, spawn: Vec3): CharacterState => ({
  body: world.addCharacter({ position: spawn, radius: CHAR_RADIUS, halfHeight: CHAR_HALF_HEIGHT }),
  vy: 0,
  grounded: false,
})

/**
 * Advance one character by one fixed step: vertical velocity from gravity + jump,
 * horizontal from the (world-space) input direction. Deterministic — identical on
 * server and client.
 */
export const stepCharacter = (state: CharacterState, cmd: InputCommand, dt: number): void => {
  if (cmd.jump && state.grounded) state.vy = JUMP_SPEED
  state.vy += GRAVITY * dt

  const len = Math.hypot(cmd.moveX, cmd.moveZ)
  const scale = len > 1 ? 1 / len : 1
  const desired: Vec3 = {
    x: cmd.moveX * scale * MOVE_SPEED * dt,
    y: state.vy * dt,
    z: cmd.moveZ * scale * MOVE_SPEED * dt,
  }
  const { grounded } = state.body.move(desired)
  state.grounded = grounded
  if (grounded && state.vy < 0) state.vy = 0
}

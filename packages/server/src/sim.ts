import { entityId, vec3, type EntityId, type Vec3 } from '@mp/core'
import type { InputCommand } from '@mp/net'
import { type PhysicsBody, type PhysicsWorld } from '@mp/physics'

/**
 * Shared, deterministic player simulation — the single source of truth used by
 * both the server (authoritative) and the client (prediction). Same values,
 * same step, so replaying inputs reproduces the server state (SEED §4).
 *
 * Throwaway M4 content. It lives under @mp/server for now and is imported by
 * the demo via the `@mp/server/sim` subpath (no server-only deps here — no
 * transport/uWS). Generalising @mp/server to host a game-owned shared sim is a
 * later step (SEED §6, law 3); see ADR-0004.
 */

export const TICK_RATE_HZ = 30
export const TICK_DT = 1 / TICK_RATE_HZ
export const GRAVITY: Vec3 = { x: 0, y: -9.81, z: 0 }
export const GROUND_HALF_EXTENTS: Vec3 = { x: 20, y: 0.1, z: 20 }
export const PLAYER_RADIUS = 0.5
export const PLAYER_SPEED = 6 // units/second

/** Deterministic spawn from the player's entity id, spread around the origin. */
export const playerSpawn = (playerId: number): Vec3 => {
  const angle = playerId * 2.399963 // ~golden angle, spreads ids apart
  return vec3(Math.cos(angle) * 4, PLAYER_RADIUS + 0.3, Math.sin(angle) * 4)
}

export const addGround = (world: PhysicsWorld): void => {
  world.addFixedBody({
    position: { x: 0, y: 0, z: 0 },
    shape: { kind: 'cuboid', halfExtents: GROUND_HALF_EXTENTS },
  })
}

export const addPlayerBody = (world: PhysicsWorld, spawn: Vec3): PhysicsBody =>
  world.addDynamicBody({ position: spawn, shape: { kind: 'ball', radius: PLAYER_RADIUS } })

// Pushable props: inert balls resting on the ground, spread in a row. Damped so a
// shove settles quickly (keeps position-only reconciliation clean). Entity ids
// 1..BALL_COUNT (players use ids >= 1000). Predicted client-side (SEED §4).
export const BALL_COUNT = 6
export const BALL_RADIUS = 0.5
const BALL_DAMPING = 1.4

/** Entity ids: balls use 1..BALL_COUNT, players use >= FIRST_PLAYER_ID. */
export const FIRST_PLAYER_ID = 1000
export const isBallId = (id: number): boolean => id < FIRST_PLAYER_ID

export const ballId = (index: number): EntityId => entityId(index + 1)

export const ballSpawn = (index: number): Vec3 =>
  vec3((index - (BALL_COUNT - 1) / 2) * 3, BALL_RADIUS, -4)

export interface Ball {
  readonly id: EntityId
  readonly body: PhysicsBody
}

export const addBalls = (world: PhysicsWorld): Ball[] => {
  const balls: Ball[] = []
  for (let i = 0; i < BALL_COUNT; i++) {
    balls.push({
      id: ballId(i),
      body: world.addDynamicBody({
        position: ballSpawn(i),
        shape: { kind: 'ball', radius: BALL_RADIUS },
        restitution: 0.3,
        linearDamping: BALL_DAMPING,
      }),
    })
  }
  return balls
}

const normalizeXZ = (x: number, z: number): { x: number; z: number } => {
  const len = Math.hypot(x, z)
  return len > 1 ? { x: x / len, z: z / len } : { x, z }
}

/**
 * Apply one input to a player body: set horizontal velocity from the command,
 * preserving vertical velocity (gravity). Call once per fixed step, then step
 * the world. Deterministic — identical on server and client.
 */
export const applyPlayerInput = (body: PhysicsBody, cmd: InputCommand): void => {
  const dir = normalizeXZ(cmd.moveX, cmd.moveZ)
  const v = body.linvel()
  body.setLinvel({ x: dir.x * PLAYER_SPEED, y: v.y, z: dir.z * PLAYER_SPEED })
}

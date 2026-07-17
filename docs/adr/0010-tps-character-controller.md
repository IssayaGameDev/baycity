# ADR 0010 — TPS character-controller prototype + pluggable game

Status: accepted (M10)

## Context

M10 re-scopes the deferred reference-game slot into "a very simple prototype of a 3D
TPS character controller." Kodjo's design decisions: orbit/mouselook camera;
camera-relative movement with the character facing its movement direction; walk + jump;
no shooting yet.

## Decision

- **Pluggable game (partial).** The room is now game-agnostic — a `GameSim`
  (`addPlayer` / `step` / `entities` / `hittablePositions` / `hitRadius`) owns the world
  and players; the room owns the generic netcode (connections, input queues, per-client
  delta snapshots, ping/pong, lag-comp rewind). Two games implement it: `ballGame`
  (M2–M8 demo) and `tpsGame`. `startServer({ mode })` selects one; the ball demo keeps
  working. Full pluggability (each game's shared sim in its own package) stays future
  work — the shared sims still live under `@mp/server`.
- **Kinematic character controller** (`@mp/physics`): Rapier's controller on a capsule,
  with autostep + snap-to-ground — crisp, non-bouncy control resolved against
  walls/steps. The caller owns vertical velocity (gravity + jump).
- **Shared TPS sim** (`@mp/server/tps`): world + obstacle course + deterministic
  `stepCharacter` (world-space move + jump/gravity), run by both server (authority) and
  client (prediction). Reconciliation restores position but keeps the character's
  vertical velocity, so jump arcs survive corrections.
- **Camera-relative input:** the client rotates WASD by the camera yaw into a world-space
  direction and sends that (server stays camera-agnostic); **protocol v5** adds a `jump`
  flag. The character faces its movement direction (client-derived; not on the wire).
- **Client:** orbit/mouselook camera (pointer lock) following the predicted character;
  capsule + facing-nose meshes; the obstacle course rendered from the shared geometry defs.

## Consequences / prototype limitations

- Movement/jump feel are shared constants (client-tuning would desync prediction from
  authority); camera feel is client-only and tunable. No camera-wall collision; no
  player↔player collision prediction; desktop kb/m only; no fall-off respawn (bounded
  ground). Facing is derived, not networked.

## Rejected

- **Full pluggable-server package split now** — larger than a prototype needs; deferred.
- **Dynamic-rigidbody character** — bouncy/imprecise; a kinematic controller is standard for TPS.
- **Networking facing/rotation** — client-derived facing suffices for the prototype (position-only wire).

## Update — playtest fixes

- "Reconciliation keeps the character's vertical velocity" proved wrong (20 Hz jump
  wobble): replay must start from the **acked** tick's `vy`/`grounded`, not the latest.
  `PredictedWorld` gained `saveAux`/`restoreAux`; `CharacterBody.setPosition` now also
  syncs the collider (body→collider sync otherwise only happens inside `world.step`,
  and `computeColliderMovement` runs outside it). See docs/netcode.md.
- Player↔player collision prediction implemented (limitation removed): the TPS client
  mirrors remote players into the predicted world as kinematic capsules (`ShapeDesc`
  gained `capsule`), same pattern as the ball demo's remote obstacles.

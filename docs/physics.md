# Physics (`@mp/physics`)

Thin wrapper over Rapier3d. **3D only** (SEED §2). Headless — runs in the browser (each
client's own sim + the viewer) and in Node (tests), sharing one pinned Rapier version,
timestep, and world config (SEED §4). The server runs **no** physics (content-free relay,
ADR 0011/0014).

## Dependency

`@dimforge/rapier3d-compat` — the SIMD build with base64-inlined WASM, so it
loads in Node and via Vite with no bundler-specific `.wasm` asset handling.
Version is pinned in `packages/physics/package.json` (SEED §4).

## API

- `initPhysics(): Promise<void>` — loads the WASM module. Idempotent; **must
  resolve before** `createPhysicsWorld`.
- `createPhysicsWorld({ gravity? }): PhysicsWorld`
  - `addDynamicBody({ position, shape, restitution? })` / `addFixedBody(...)` → `PhysicsBody`
  - `step(dtSeconds)` — sets `world.timestep = dtSeconds`, then one `world.step()`
  - `free()` — releases the WASM world
- `ShapeDesc`: `{ kind: 'ball', radius }` | `{ kind: 'cuboid', halfExtents }` | `{ kind: 'capsule', halfHeight, radius }`
- `BodyOptions`: `{ position, shape, rotation?: Quat, restitution?, linearDamping? }` — `rotation` sets the initial orientation (tilted colliders like ramps; a rotating body's start pose)
- `PhysicsBody.translation()` → `Vec3` / `rotation()` → `Quat`; `colliderHandle` (matches `CharacterBody.collisions()`)
- `PhysicsBody.linvel()` / `setLinvel(v)` — read/set linear velocity
- `PhysicsBody.teleport(position)` — moves the body and zeros its velocities · `setPosition(position)` — moves but keeps velocity
- `PhysicsBody.remove()` — remove the body from the world
- `world.addKinematicBody(...)` + `setNextKinematicTranslation(p)` / `setNextKinematicRotation(q)` — a
  position-based kinematic body moved each step; mirrors remote players and drives content's
  moving/rotating pieces (ADR 0014)
- `BodyOptions.linearDamping` — velocity damping; pushable props settle quickly

- `world.addCharacter({ position, radius, halfHeight })` → `CharacterBody` — a Rapier
  **kinematic character controller** (capsule, autostep + snap-to-ground). `move(desired)`
  applies a collision-resolved translation and returns `{ grounded }`; the caller owns vertical
  velocity (gravity/jump). `collisions()` returns the collider handles the capsule contacted
  during the last `move` — **gameplay triggers key off these** (real contact, not distance; ADR 0014).

`rapier3d-compat`'s inlined WASM makes the same wrapper work in the browser and Node.

## Notes

- **Fixed timestep:** clients step at 30 Hz (`dt = 1/30`); the server runs no physics
  (content-free relay, ADR 0011/0014). Rapier uses `world.timestep`; the wrapper sets it per step.
- **No cross-platform determinism** (SEED §2). Under client authority each client owns its own
  sim, so cross-client float drift is never reconciled and never shows — lockstep stays rejected.
- **Rotation** is read from Rapier and used locally for content (tilted/rotating colliders, their
  visuals, and contact triggers — ADR 0014). Still **position-only on the wire** (v7); orientation
  would only join the protocol if a replicated body needed it.
- Correctness covered by `packages/physics/src/world.test.ts`: gravity drop/rest, fixed-body
  placement, kinematic obstacles, character grounding/walls, initial + kinematic rotation, and
  contact reporting (the resting collider is reported, an untouched one is not).

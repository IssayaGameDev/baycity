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
- `CharacterBody.probeGround()` → `GroundContact | undefined` — a downward ray from the capsule
  centre (`castRayAndGetNormal`, own collider excluded), rejected if the surface normal is steeper
  than the 50° climb angle. Returns which collider is underfoot, the hit point, and the normal.
  Separate from `move` on purpose: the controller only reports contacts it actually resolved, and
  its `grounded` flag flickers false while resting, so anything needing footing *every* tick
  (platform carry) asks here instead. Reach below the feet is the **snap-to-ground distance** — the
  controller will hold the capsule to ground that far away, so ground that far away is its footing,
  and it must exceed how far a surface moves in one tick (a platform descending at 3 m/s drops
  0.1 m per tick; a tighter margin loses the floor and the rider bounce-falls after it).
- `CharacterBody.colliderHandle` — the capsule's own collider, for queries cast *from* the character
  that must not hit it (the camera's occlusion probe starts inside it).
- `CharacterOptions.offset` / `snapToGround` / `autostep` — controller collision parameters, so its
  behaviour can be probed rather than guessed at. Defaults are the values above.
- `world.castSphere({ origin, direction, maxDistance, radius, exclude? })` → `CastHit | undefined` —
  sweeps a sphere and reports `{ distance, colliderHandle }` for the first collider touched, or
  `undefined` if it gets `maxDistance` clear. `direction` is normalized internally, so `distance` is
  always metres. `exclude` is collider handles to ignore (what the caster counts as itself). A sphere
  rather than a ray because the caller puts something with volume where the result says: stopped by a
  ray, a camera sits flush with the wall and its near plane cuts through it; a sphere leaves exactly
  `radius` of clearance. An overlap at the origin reports `distance: 0` only when the sweep heads
  *further in*; on a path out of the overlap it is ignored (Rapier's `stopAtPenetration: false`), so a
  probe whose origin grazes a surface is not pinned to zero regardless of where it was going.
  Used by the parkour camera (ADR 0020).
- `move` returns `applied`, the translation actually resolved. It differs from what was asked
  wherever the step was blocked or slid, and it is how a caller can tell what the controller did.
  `move` also **retries once** when it discards an entire step while resting (see `CONTACT_NUDGE`).

`rapier3d-compat`'s inlined WASM makes the same wrapper work in the browser and Node.

## Notes

- **Fixed timestep:** clients step at 30 Hz (`dt = 1/30`); the server runs no physics
  (content-free relay, ADR 0011/0014). Rapier uses `world.timestep`; the wrapper sets it per step.
- **No cross-platform determinism** (SEED §2). Under client authority each client owns its own
  sim, so cross-client float drift is never reconciled and never shows — lockstep stays rejected.
- **Scene queries read an index that only `step()` refreshes.** A collider created, removed or
  repositioned since the last step is not in it, so a cast reports geometry that has moved and misses
  geometry that has arrived — the same staleness that makes a teleported platform stop resolving
  movement (see carry, point 4). The wrapper tracks it: any add / remove / `setPosition` / `teleport` /
  `setRotation` marks the index stale, and `castSphere`/`probeGround` call Rapier's
  `updateSceneQueries()` before casting if it is. On demand, not per cast — the refresh walks the
  collider set and most frames change nothing. Relevant because the camera casts from the **render**
  loop, which runs up to 144 Hz against a 30 Hz sim.
- **Rotation** is read from Rapier and used locally for content (tilted/rotating colliders, their
  visuals, and contact triggers — ADR 0014). Still **position-only on the wire** (v7); orientation
  would only join the protocol if a replicated body needed it.
- **Moving-platform interaction (two-phase step):** the KCC is not pushed by kinematic bodies on
  its own. To ride / get pushed by clock-driven pieces, step the platforms first, then the
  character, in **separate `world.step` calls** — the controller then resolves against the pieces'
  current positions, so depenetration carries it up a rising platform and off a sweeping bar, and
  snap-to-ground holds it on a descending one. See `modes/parkour` and the viewer's play loop;
  covered by `world.test.ts`.
- **Platform carry (`@mp/character` movement base + `@mp/content` frozen posing).** Riding a moving
  piece is implemented here, the way engines do it — Unreal's movement base, Godot's platform
  floor, Quake's ground entity. The character stores which collider it stands on plus its position
  *in that surface's frame*, and each tick asks where that local point has moved to; the difference
  goes to the controller together with the character's own movement. Deriving the position from the
  frame rather than accumulating a delta is what makes it drift-free.
  Verified by `character/src/platformCarry.test.ts` (12 cases) and end-to-end on the real level by
  `modes/parkour/src/gym.test.ts`: worst single-tick slip **< 5 mm** at 1/3/4.5/9 m/s, no creep over
  8 s, turntable riders orbit at constant radius, elevator feet stay within 15 cm.

  Four things it depends on, each of which was a real failure when violated:
  1. **The ridden piece — and only that one — is posed with zero derived velocity** (set the pose
     *and* target the same pose; pass `CharacterState.base?.colliderHandle` to `LoadedLevel.update`).
     A kinematic body with a velocity makes the controller add that velocity to a rider itself, on
     *some* ticks only (strictly all-or-nothing, ~13% dropped on a 4 m platform, worse the smaller
     the collider), so riding cannot be built on top of it; frozen, the controller contributes
     exactly nothing (measured: one distinct value, zero) and the piece still travels the same
     distance. Every other piece **keeps** its velocity, because that velocity is also what makes a
     moving piece *push* a character it sweeps into — freezing all of them made the spinning bar
     pass straight through the player. Pinned by `gym.test.ts` ("shoved sideways by the spinning
     bar").
  2. **The base is held by `probeGround`, not by `grounded`.** The controller's flag reports false
     for isolated ticks while resting; releasing the base on it costs a full tick of ride, which is
     the once-or-twice-a-second lurch.
  3. **Only the horizontal is handed to the controller as movement; the vertical is the surface's
     alone, with gravity suppressed while riding.** Gravity fighting a rising platform loses by the
     difference each tick and the rider is left behind (measured: falls to y ≈ −1085).
  4. **The ride is never a teleport.** Moving the collider behind the controller's back leaves
     Rapier's query pipeline stale and `computeColliderMovement` then resolves to *nothing* — the
     character silently cannot walk, and gets pushed through walls.
- Jumping off a mover inherits its velocity (the ride distance over dt) — the engine hands over
  nothing here either. See `docs/netcode.md` for the feel values.
- Platform time advances **one fixed step per sim step** (`createSimClock`): a multi-tick loop wake
  otherwise stalls the platform while the character keeps advancing. The loader also primes its
  first step to zero motion, so a mid-cycle start is never reported as travel.
- Correctness covered by `packages/physics/src/world.test.ts`: gravity drop/rest, fixed-body
  placement, kinematic obstacles, character grounding/walls, initial + kinematic rotation, contact
  reporting (the resting collider is reported, an untouched one is not), and `castSphere` (radius
  clearance, clear sweep, exclusion, direction normalization, initial overlap, casting out of the
  character capsule).

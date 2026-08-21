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
  during the last `move` — **gameplay rules key off these** (real contact, not distance; ADR 0014).
- `CharacterBody.overlaps()` → the handles of the **sensors** the capsule is inside (ADR 0054).
  A separate list because it has to be: a sensor resolves no movement, so it never reaches
  `collisions()`, which is the record of what the capsule *pushed against*. An explicit
  `intersectionsWithShape` with `EXCLUDE_SOLIDS` — no `step()` needed since the capsule moved, and
  sensors only, so the two lists are disjoint and a host concatenates them for every contact.
- **A trigger is `BodyOptions.sensor`** (`Collider.trigger` in content). Detected on overlap,
  resolving nothing: `EXCLUDE_SENSORS` goes on the controller's `computeColliderMovement` (without
  it Rapier resolves against sensors and a trigger wall stops the capsule like a solid one — this
  was measured, not assumed), on `probeGround` (a trigger is not footing) and on `castSphere` (a
  trigger does not move the camera).
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
- `BodyOptions.layers` / `CharacterOptions.layers` → `CollisionLayers` = `{ belongsTo, collidesWith }`,
  16 bits each (Rapier interaction groups, packed into one u32 by the wrapper). Two colliders interact
  only if each one's membership intersects the other's filter, so switching an interaction off takes one
  side, not both. Omit for the default: in every layer, colliding with every layer. **Write filters as
  "everything except"** — a collider that lists the layers it wants silently stops colliding with
  anything added later that forgot to claim one. **A capsule's layers also filter the controller's own
  queries** (`move`, `probeGround`): Rapier's character controller does not read its collider's layers,
  it takes groups per call, so the wrapper passes them to both — a capsule that ignores a layer is
  neither blocked by it nor stands on it. Used by `modes/parkour/src/layers.ts` to keep corpses and
  character capsules apart (ADR 0019).
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
- `world.sphereOverlaps({ center, radius, exclude? })` → `boolean` — is a sphere at `center` inside solid
  geometry right now. `intersectionsWithShape` with `EXCLUDE_SENSORS`, stopping at the first hit. This is
  the question `castSphere` structurally cannot answer: a sweep that starts already penetrating and heads
  *out* of the overlap ignores it by design (above), so from inside a wall a cast reports clear air. The
  camera needs a straight yes before it may keep its distance and let the shader dither the obstruction
  away (ADR 0055). Triggers are not solid (ADR 0054), so they never block it either.
- `move` returns `applied`, the translation actually resolved. It differs from what was asked
  wherever the step was blocked or slid, and it is how a caller can tell what the controller did.
  `move` also **retries once** when it discards an entire step while resting (see `CONTACT_NUDGE`).
- `move` returns `ceiling` alongside `grounded`: the step asked to rise and a contact overhead
  (outward normal pointing down past `CEILING_NORMAL_MAX_Y`) was in the way. Read off contact normals
  rather than from `applied.y` falling short of `desired.y`, because autostep and snap-to-ground both
  move the capsule vertically on their own, so a shortfall alone cannot tell a roof from either.
  `@mp/character` uses it to end a jump's rise — without it `vy` stays positive under the roof and the
  character hangs there for the rest of its hang time.

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
  `setRotation` marks the index stale, and `castSphere`/`sphereOverlaps`/`probeGround` call Rapier's
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

  Six things it depends on, each of which was a real failure when violated:
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
  4. **Footing is not just a downward ray, and rising is not standing** (ADR 0042). Three separate
     failures on fast vertical movers, all measured. The probe reaches the snap distance past the feet
     (0.4 m) while a rider sits about a tick of travel behind a descending deck, so from ~7 m/s down it
     lost the surface and bounce-fell after it — fixed by a second, longer probe, bounded by how far the
     stored anchor point actually dropped and accepted only for the same collider. `move` reports
     `grounded` before that ray can reach a surface dropping away, so the fall was clamped to zero with
     no base gained — fixed by taking the base from `collisions()` when the ray misses. And a riser stays
     inside the probe's reach after take-off, so it re-collected the character mid-climb — fixed by gating
     footing and the base on `vy <= 0`.
  5. **The ride is never a teleport.** Moving the collider behind the controller's back leaves
     Rapier's query pipeline stale and `computeColliderMovement` then resolves to *nothing* — the
     character silently cannot walk, and gets pushed through walls.
- `probeGround(extraReach?)` lengthens the ray past the snap distance, for a caller tracking a surface
  that moves further in one tick than the default reach covers. A longer ray also reaches floors the
  character is not standing on, so the caller must check the returned `colliderHandle` (ADR 0042).
- Jumping off a mover inherits its velocity (the ride distance over dt) — the engine hands over
  nothing here either. See `docs/netcode.md` for the feel values.
- Platform time advances **one fixed step per sim step** (`createSimClock`): a multi-tick loop wake
  otherwise stalls the platform while the character keeps advancing. The loader also primes its
  first step to zero motion, so a mid-cycle start is never reported as travel.
- Correctness covered by `packages/physics/src/world.test.ts`: gravity drop/rest, fixed-body
  placement, kinematic obstacles, character grounding/walls, initial + kinematic rotation, contact
  reporting (the resting collider is reported, an untouched one is not), `castSphere` (radius
  clearance, clear sweep, exclusion, direction normalization, initial overlap, casting out of the
  character capsule), and collision layers (a dynamic body falls through an excluded slab and still
  lands on a default-layer floor; a capsule is neither blocked by nor grounded on an excluded layer).

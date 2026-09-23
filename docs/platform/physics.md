# Physics (`@mp/physics`)

Thin wrapper over Rapier3d. 3D only. Headless: same code in the browser and in Node (tests). The server runs no physics (ADR 0011). Source: `packages/physics/src/world.ts`; exports in `packages/physics/src/index.ts` (`PHYSICS_BACKEND = 'rapier3d'`).

## Dependency

`@dimforge/rapier3d-compat` `^0.14.0` (`packages/physics/package.json`) — WASM inlined as base64, so no bundler asset handling.

## Lifecycle

```ts
initPhysics(): Promise<void>                       // RAPIER.init(); idempotent
createPhysicsWorld({ gravity?: Vec3 }): PhysicsWorld  // throws if initPhysics has not resolved
```

Default gravity `{ x: 0, y: -9.81, z: 0 }`. `@mp/tps` passes `{ y: -tuning.gravity }` (`packages/tps/src/client.ts`).

## `PhysicsWorld`

| Method | Returns | Notes |
|---|---|---|
| `addDynamicBody(BodyOptions)` | `PhysicsBody` | |
| `addFixedBody(BodyOptions)` | `PhysicsBody` | |
| `addKinematicBody(BodyOptions)` | `PhysicsBody` | position-based kinematic; moved via `setNextKinematic*` |
| `addCharacter(CharacterOptions)` | `CharacterBody` | Rapier kinematic character controller, capsule |
| `castSphere(SphereCastOptions)` | `CastHit \| undefined` | `stopAtPenetration: false`, `EXCLUDE_SENSORS`; direction normalized so `distance` is metres |
| `sphereOverlaps(SphereOverlapOptions)` | `boolean` | `intersectionsWithShape`, `EXCLUDE_SENSORS`, stops at first hit |
| `step(dtSeconds)` | | `world.timestep = dt; world.step()` |
| `free()` | | releases the WASM world |

### Shapes

```ts
type ShapeDesc =
  | { kind: 'ball'; radius }
  | { kind: 'cuboid'; halfExtents: Vec3 }
  | { kind: 'capsule'; halfHeight; radius }
  | { kind: 'convex'; points: readonly Vec3[] }   // convexHull; throws on degenerate points (ADR 0017)
```

### `BodyOptions`

`{ position, shape, rotation?: Quat, restitution?, linearDamping?, layers?: CollisionLayers, sensor?: boolean }`

### `PhysicsBody`

`handle`, `colliderHandle`, `translation()`, `rotation()`, `linvel()`, `setLinvel(v)`, `setAngvel(v)`, `teleport(p)` (zeros lin+ang velocity), `setPosition(p)` (keeps velocity), `setRotation(q)`, `setNextKinematicTranslation(p)`, `setNextKinematicRotation(q)`, `remove()`.

## Character controller

```ts
interface CharacterOptions { position; radius; halfHeight; offset?; snapToGround?: number | false; autostep?: { maxHeight; minWidth } | false; layers? }
interface CharacterBody {
  colliderHandle
  translation(); setPosition(p)          // setPosition also syncs the collider immediately
  move(desired: Vec3, snapAtLeast?: number): { grounded; applied: Vec3; ceiling }
  probeGround(extraReach?): GroundContact | undefined   // { colliderHandle, point, normal }
  collisions(): number[]                 // solids contacted during the last move
  overlaps(): number[]                   // sensors currently overlapped (ADR 0054)
  remove()
}
```

Defaults and constants (`world.ts`):

| Constant | Value |
|---|---|
| `CHAR_OFFSET` | 0.02 m |
| `snapToGround` | 0.4 m |
| `autostep` | `{ maxHeight: 0.4, minWidth: 0.2 }`, dynamic bodies included |
| `MAX_SLOPE_CLIMB_RAD` | 50° (also `probeGround`'s floor-normal threshold) |
| min slope slide angle | 45° |
| `CEILING_NORMAL_MAX_Y` | −0.5 — `ceiling` only while `desired.y > 0` |
| `CONTACT_NUDGE` | 0.0005 m — `move` retries once with this vertical when a resting step resolves to < 90 % of its horizontal and nothing is blocking along it; the nudge is **subtracted** from the result, not clamped to zero (ADR 0127) |
| `GROUND_PROBE_FALLBACK` | 0.05 m reach when `snapToGround === false` |

- `probeGround` reach = `halfHeight + radius + snap + extraReach`, ray from the capsule centre, own collider excluded. Caller must check `colliderHandle` when passing `extraReach` (ADR 0042).
- `move`'s `snapAtLeast` raises snap-to-ground for that one call and is restored afterwards; only ever widened, never narrowed. For a caller asking for a descent a shortfall in would cost it its footing — a character following a slope downhill (ADR 0127). Unset, the configured distance stands.
- **A step's resolve is not reliable.** Rapier returns part of a step intermittently — `CONTACT_NUDGE` has it at 33 of 200 ticks on the horizontal, and it happens on the vertical too (half of a 1.14 m descent, once in a 120-tick run). Anything asking for a large single-tick translation needs a recovery path; snap-to-ground is it, which is what `snapAtLeast` exists to size.
- `collisions()` and `overlaps()` are disjoint; hosts concatenate them (`packages/tps/src/client.ts`: `components.contact([...collisions(), ...overlaps()])`).

## Sensors / triggers (ADR 0054)

`BodyOptions.sensor: true` → `ColliderDesc.setSensor(true)`. Content maps `Collider.trigger` to it (`packages/content/src/loader.ts`). Paths that ignore sensors: `move` (`computeColliderMovement` with `EXCLUDE_SENSORS`), `probeGround`, `castSphere`, `sphereOverlaps`. `overlaps()` uses `EXCLUDE_SOLIDS`, so it returns sensors only, without a `step()`.

## Layers

`CollisionLayers = { belongsTo: u16, collidesWith: u16 }`, packed `(belongsTo << 16) | collidesWith` into Rapier's interaction groups. Two colliders interact iff each one's membership intersects the other's filter. Omit = Rapier default (all/all). `CharacterOptions.layers` is also passed per call to `move`, `probeGround`, `overlaps` — Rapier's controller does not read the collider's groups.

## Scene-query staleness

Rapier's query index refreshes only in `step()`. The wrapper sets `queriesStale` on any add/remove/`setPosition`/`teleport`/`setRotation`, and `castSphere`/`sphereOverlaps`/`probeGround`/`overlaps` call `world.updateSceneQueries()` first if stale. `move` does not refresh.

## Timestep conventions

- Sim rate is `TICK_RATE_HZ = 30` (`packages/core/src/tick.ts`).
- `@mp/tps` steps twice per tick with `half = TICK_DT / 2`: `loaded.update(nowMs, ridingHandle)` → `world.step(half)` (platforms move) → `components.locomote(...)` → `world.step(half)`. Two full steps made dynamic bodies (ragdoll parts) integrate at double speed. The character's translation is computed for the full `TICK_DT` and applied through `move`.
- Kinematic pieces are posed via `setNextKinematicTranslation/Rotation` each tick; the ridden piece is posed with zero derived velocity (`LoadedLevel.update` second argument).
- No cross-platform determinism is required or claimed; each client owns its own body.

## Where the character helpers live

| Symbol | Package |
|---|---|
| `world.addCharacter(CharacterOptions)` | `@mp/physics` |
| `addCharacter(world, spawn, layers?)`, `addCharacterWith(world, spawn, opts)` → `CharacterState` | `@mp/humanoid` (`packages/humanoid/src/groundController.ts`) |
| `stepCharacter(state, cmd, dt, tuning?, platforms?)`, `CHAR_RADIUS = 0.4`, `CHAR_HALF_HEIGHT = 0.6`, movement base / platform carry | `@mp/humanoid` |
| `worldFromBase` (peer positions) | `@mp/game-client` |

Content loader: `f.animated ? world.addKinematicBody(desc) : world.addFixedBody(desc)`, `sensor: true` when `trigger` (`packages/content/src/loader.ts`).

## Tests

`packages/physics/src/world.test.ts`: gravity/rest, teleport vs setPosition, kinematic blocking, controller grounding/walls/kinematic capsule, replay after setPosition, initial and kinematic rotation, contact reporting, two-phase platform ride, `castSphere` (6 cases), `sphereOverlaps` (7), collision layers (2), trigger collider (5). `packages/physics/src/index.test.ts`: backend banner. Platform carry: `packages/humanoid/src/platformCarry.test.ts`.

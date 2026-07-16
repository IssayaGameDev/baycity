# Physics (`@mp/physics`)

Thin wrapper over Rapier3d. **3D only** (SEED §2). Headless — runs in Node on the
server today and (from M4) in the browser for client prediction, sharing one
pinned Rapier version, timestep, and world config (SEED §4).

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
- `ShapeDesc`: `{ kind: 'ball', radius }` | `{ kind: 'cuboid', halfExtents }`
- `PhysicsBody.translation()` → `Vec3` (rotation not read yet — see below)
- `PhysicsBody.teleport(position)` — moves the body and zeros its velocities (used by the demo's periodic re-drop)

## Notes

- **Fixed timestep:** the server steps at 30 Hz (`dt = 1/30`). Rapier uses
  `world.timestep`; the wrapper sets it per step so the passed `dt` governs.
- **No cross-platform determinism** (SEED §2). Server and client run the same
  pinned build/timestep/config, but float results differ across platforms;
  reconciliation (M4) corrects the drift — this is why lockstep was rejected.
- **Position only on the wire** (protocol v1). Rotation is available from Rapier
  but not yet read or replicated; it joins when an oriented body needs it
  (player capsule in M4, or quantization in M6).
- Correctness covered by `packages/physics/src/world.test.ts` (a ball drops under
  gravity and rests on a fixed ground; a fixed body stays put).

# ADR 0014 — Data-driven content pipeline + modes layering

Status: accepted. Builds on client-authoritative rooms (ADR 0011 + 0013) and the Roblox-like
controller (ADR 0012).

## Context

The world was hardcoded (`@mp/server/tps`: ground, obstacles, elevator, checkpoints). The
product is an "extremely simplified Roblox" — a platform hosting a few well-scoped **modes**
that share one stack (controller, content, kit, renderer, netcode). **Parkour** is the first
mode (obstacle courses / towers). We need to author greybox content efficiently with no
artist and no Blender yet, reuse it across modes, and inspect it locally. Polish comes from
rendering and feel, not art.

## Decision

- **Content is data** (`@mp/content`), a shared resource any mode loads. Schema: `Prefab`,
  `Level`, `ColliderDesc`, `Piece`, `Marker`, `Behavior`, `Visual`, `LevelConfig`. Authored as
  JSON (`content/levels/*.json`) or TS.
- **Visual ≠ collision.** Collision is authored primitives (`box`/`capsule`/`ball` — crisp and
  cheap for the KCC); the visual is a swappable layer (`primitive` greybox now, `gltf` later —
  schema supports both, only primitives built). A ramp is a rotated box, never a trimesh.
- **Loader** (`instantiateLevel(world, level) → LoadedLevel`): builds Rapier colliders (fixed
  for static, kinematic for clock-driven), collects world markers + physics-backed triggers,
  emits a **renderer-agnostic visual list**, and `update(now)` advances clock-driven behaviors
  (`move`/`rotate`) as pure functions of synced time — no per-object networking. Headless;
  shared by game, viewer, (and available to bots).
- **Greybox kit** (`@mp/content/kit`, `/generators`): parametric prefab constructors (platform,
  ledge, ramp, gap-jump, moving platform, rotating bar, spawn/checkpoint/goal/hazard pads) and
  procedural generators (`staircase`, `spiralStaircase`). Palette is the "High-contrast dev"
  visual language (Kodjo's pick). **Deleted by ADR 0027: geometry is authored data now.** The style
  palette survives in `@mp/render-three`.
- **Rotation** added end-to-end: quaternion math in `@mp/core` (`eulerToQuat`, `axisAngleToQuat`,
  `mulQuat`, `rotateVec3`); collider rotation + `setNextKinematicRotation` in `@mp/physics`;
  transforms compose (instance × piece) in the loader. Enables ramps + rotating bars.
- **Gameplay triggers are a piece's own collider.** A `Piece.trigger` (`checkpoint`/`goal`/
  `hazard`) marks its collider; the loader exposes it as a `WorldTrigger` (collider handle).
  Contact is the character controller's **real collisions** (`CharacterBody.collisions()` — the
  KCC's computed collisions), matched by handle — **not distance heuristics**. Touch the
  collider from any side/height → fire; don't touch it → nothing.
- **Renderer** (`@mp/render-three`): a polished greybox pipeline — `RoomEnvironment` IBL, ACES
  tone mapping, soft shadows, and GTAO + SMAA + optional bloom post-FX; a `style → material`
  visual language; and a level-view that realizes the loader's visual list into shadowed meshes
  (`sync()` re-poses clock-driven pieces). **Shared by the game and the viewer.**
- **Controller is stack-level** (`@mp/character`): the `stepCharacter` KCC relocated out of
  `@mp/server/tps`. Modes pick a controller; feel is data (`CharacterTuning`).
- **Modes layering:** `games/tps` → `modes/parkour`; `TpsRoom` → `ParkourRoom`. A mode owns its
  rules, controller choice, and room behavior; the stack is shared. **Mode-readiness seams**
  (built clean for parkour, other modes not built): level/mode config (`fallBehavior`),
  per-player state + a **pluggable persistence adapter** (`PersistenceAdapter<T>`, `local` now),
  controller live-params, and content shared across modes.
- **Viewer** (`tools/viewer`, `pnpm dev:viewer`): a localhost inspector on the shared renderer —
  element/prefab/level picker, orbit camera, collider/marker/trigger overlays, a jump-
  reachability gizmo (from `CharacterTuning`), and **play-in-place** (a real controller, no
  networking). View-only + play; a full editor is deferred — **built since, see ADR 0023.**
- **Server stays content-free** (client-auth): the loader runs in the game + viewer only.

## Technical calls / deviations

- **Post-FX ships with `three`** (`three/examples/jsm/postprocessing/*`, `controls/OrbitControls`)
  — re-exported from `@mp/render-three`; **no new runtime dependency**.
- **Trigger detection uses the KCC's `computedCollisions`, not the contact graph.** Rapier skips
  `KINEMATIC_FIXED` contacts by default; the character-controller movement solve reports what the
  capsule pushed against regardless, which is exactly "on contact."
- **Persistence** is a `PersistenceAdapter<T>` seam; `localParkourPersistence` (localStorage)
  now, account-backed later behind the same interface.
- `render-three` gains a type-only dep on `@mp/content` (the visual/trigger types). `vitest` now
  also scans `modes/`.

## Consequences

- New packages: `@mp/content`, `@mp/character`, `tools/viewer`. `@mp/server/tps` and its sim/world
  defs are gone (controller → `@mp/character`; world → `content/levels/level1.json`).
- Protocol unchanged (v7); the server is unchanged (content-free). Checkpoints/spawn/fall/hazard
  and moving platforms are now data + mode rules on `serverNow()`.
- The parkour demo loads a throwaway kit sampler; `level1.json` is the ported original world.
- Gate: 102 tests (kit, generators, rotation math, loader triggers, sensor→contact, persistence).

## Rejected

- **Blender / glTF art now** — no artist; greybox from rendering + feel. glTF is in the schema,
  not built. **Built since: ADR 0026 consumes the seam** (models, textures, materials by asset id).
- **Trimesh colliders from the art mesh** — authored primitives instead (crisp/cheap for the KCC).
- **Distance-based triggers** — replaced by real engine contact after distance heuristics kept
  mis-firing (fired under a floating pad, missed side contact).
- **Full in-viewer edit/save** — **superseded by ADR 0023: `tools/editor` is built and is the content
  path.** As judged at the time: view-only + play-in-place now; a content editor is a post-release
  stretch (SEED §7).
- **`@colyseus/schema` for moving platforms** — clock-driven `f(serverNow())` keeps them off the
  wire (ADR 0013).

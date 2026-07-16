# ADR 0003 — Physics wrapper and Three.js renderer

Status: accepted (M3)

## Context

M3 puts physics in the loop: the server simulates with Rapier3d and the client
renders via Three.js. The physics wrapper must also run in the browser later
(client prediction, M4), and the renderer must not absorb game-visual decisions
(SEED §6, law 3).

## Decision

- **`@dimforge/rapier3d-compat`** (SIMD, base64-inlined WASM). One package runs
  headless in Node and in the browser with no per-bundler `.wasm` asset handling.
  `initPhysics()` is async + idempotent.
- **Thin physics wrapper** — init / world / add body / step / free, with ball and
  cuboid shapes. Not dimension-agnostic (3D only). It centralises the pinned
  Rapier version, timestep, and world config that server and client must share
  (SEED §4).
- **Fixed timestep** via `world.timestep`, set to the loop's `dt` (1/30) each step.
- **`@mp/render-three` is unopinionated plumbing** — WebGL2 renderer + scene +
  camera + rAF loop + resize. Scene content (lights, ground, meshes) stays in the
  game. It re-exports `THREE` so games pin one Three.js version through the stack.
- **Position-only replication retained** — the throwaway content is spheres, so
  rotation is not put on the wire yet.

## Rejected

- **`@dimforge/rapier3d`** (bundler-target, separate `.wasm`) — needs per-bundler
  wasm asset wiring; `-compat` avoids that for both Node and Vite.
- **An opinionated renderer** (entity→mesh mapping, built-in lights/ground) — would
  move game-visual decisions into the stack. Kept in the demo instead.
- **Adding rotation to the wire now** — unnecessary for spheres; deferred to avoid
  premature schema growth (revisit at M4/M6).

## Note

Cross-platform physics determinism is not relied upon (SEED §2); reconciliation
handles the drift once client prediction lands (M4).

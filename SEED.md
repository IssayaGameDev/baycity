# SEED — Multiplayer Web Stack

Requirements handoff from Kodjo. This is **input** to the project, not documentation of it.
Documentation of the system is created by the coding agent as the system is built (see CLAUDE.md, documentation policy).
If code and this file conflict on a *decision*, ask Kodjo. Decisions here are locked unless he changes them.

**Lifecycle:** this file is consumed, not maintained. As decisions get implemented, their rationale moves to ADRs and their current state to system docs; live constraints (budgets, design/technical boundary) migrate to permanent docs early. When everything here is implemented-and-documented or superseded, propose deletion to Kodjo — git keeps the history.

## 1. What is being built

A reusable **multiplayer game stack** for HTML5/TypeScript browser games. Games are built *on top of* the stack as thin compositions.

**Current scope:** 3D games — Three.js world rendering (WebGL2) + PixiJS 2D HUD overlay. Physics is **3D only** (Rapier3d).

**Deferred (not now, not rejected):** a 2D game path (PixiJS-only rendering + 2D physics). PixiJS is in scope today *solely* as the 2D renderer for the HUD. Kodjo scopes this when relevant.

The stack is the product of this phase. A reference/sandbox game is **out of scope for now** (Kodjo defines it later); milestones are exercised with throwaway content only.

## 2. Locked technical decisions

| Area | Decision | Notes |
|---|---|---|
| Language | TypeScript, strict | — |
| Client build | Vite | — |
| 3D rendering | Three.js on **WebGL2** | WebGPU rejected for now: mobile Safari reach |
| 2D rendering / HUD | PixiJS | Stacked canvas over the Three.js canvas (not shared context) |
| Physics | Rapier3d (WASM), **standard SIMD build** | **3D only for now.** Thin wrapper over Rapier3d (shared world/stepping/lifecycle) — not a dimension-agnostic 2D/3D surface. 2D flavor deferred; wrapper must not preclude adding rapier2d later |
| Determinism | **None.** No lockstep, no deterministic build | Rejected deliberately — see §4 rationale |
| Server runtime | Node (Bun acceptable if justified) | Headless Rapier, no rendering imports |
| Server tick | 30 Hz fixed timestep | Starting point; raising it is a design/budget question |
| Snapshot rate | 15–20 Hz, interpolated on client | — |
| Transport | WebSockets (uWebSockets.js) behind a transport interface | UDP-like transport (e.g. geckos.io) is a possible later swap; the interface must make that swap cheap |
| Protocol | Binary. No JSON on the hot path | Schema carries a version byte from day one |
| Repo | Monorepo (pnpm workspaces or equivalent) | Structural laws in §6 |

> **Transport superseded by ADR 0013 (Kodjo's sign-off):** rooms now run on **Colyseus**
> (open-source, optional managed Cloud) for lifecycle/matchmaking/scale-out. It uses its
> default `ws` transport; the uWebSockets transport is a later perf swap. Our binary protocol
> rides inside Colyseus messages (no `@colyseus/schema`).

## 3. Requirements

- **Players per room:** 5–20
- **Mobile browsers in scope** — mid-range Android and iOS Safari are first-class targets
- **Lag-compensated hit validation (rewind)** — server keeps ~1s ring buffer of player collider transforms; hit claims validated against the shooter-perceived past state; requires client↔server clock sync
- **Input abstraction** — touch and keyboard/mouse behind one interface from day one
- **Per-client snapshot construction** — never one global broadcast, even before any filtering exists. This keeps every bandwidth lever (AOI, rate, quantization) available cheaply without committing to any

## 4. Netcode model (locked)

> **Superseded by ADR 0011 (2026-07-17), with Kodjo's sign-off.** The target game
> class was re-scoped (scarce player-to-player interaction, cheating tolerated, no
> rewind needed), so the stack is now **client-authoritative**: each client owns and
> simulates its own entity and sends state; the server relays. Prediction/
> reconciliation, predicted props, and rewind/lag-comp are retired; clock sync is
> kept for peer interpolation. The original locked model is recorded below for
> history — see `docs/netcode.md` for current behaviour.

**Server-authoritative.** Clients send inputs only; server owns all state.

- Client predicts **its own body** locally; inputs carry sequence numbers; server echoes last-processed sequence; client rewinds and replays unacknowledged inputs on mismatch
- Remote players and props are rendered in the past via snapshot interpolation
- Props are **not** predicted by default. Whether a specific object enters the prediction loop is a per-game **design decision** (rule of thumb: the more gameplay-critical an object's instant response, the more it needs prediction). The stack must support pulling a contacted body into the prediction loop; games decide when
- Corrections are smoothed over time, not snapped, wherever a smoothing window exists
- **Why no determinism:** with an authoritative server, drift is corrected by reconciliation. Determinism only pays for lockstep, which was rejected (input delay incompatible with fast action; rollback of large physics worlds is CPU-prohibitive; desync fragility). What matters instead: client and server run the **same Rapier version, timestep, and world config** — pinned and shared

## 5. The five budgets

These are **tripwires, not targets**. Exceeding one is never resolved silently — mitigation choice belongs to Kodjo. Report: which budget, by how much, measured how, and the mitigation options with their costs. Staying comfortably under budget requires no conversation.

| # | Budget | Number | Notes |
|---|---|---|---|
| 1 | Client frame time | ~16 ms/frame on mid-range Android | Rapier step scales with awake bodies + contact pairs; hundreds awake on mobile, not thousands |
| 2 | Downstream bandwidth per client | ~20–30 kB/s sustained (mobile) | Cost ≈ changed replicated entities × ~15 B × snapshot rate |
| 3 | Server tick time | Physics step + snapshot build < 33 ms per room | Scales with world complexity and player count |
| 4 | Latency floor | 30–150 ms RTT + jitter on mobile networks | Cannot be engineered away; interpolation buffer and rewind windows are design sliders |
| 5 | Client memory | ~1–1.5 GB before mobile Safari kills the tab | WASM heap + textures + geometry share it |

Known mitigations (menu, not mandates — each application is a design question): AOI filtering, sleeping-body culling, delta compression, quantization (~16 bit/axis positions, smallest-three quaternions), snapshot rate reduction, room size reduction, adaptive per-connection interpolation buffers.

## 6. Monorepo structural laws

1. **One-way dependency flow.** `games → packages`, never the reverse. `core` imports nothing from sibling packages
2. **Simulation never imports rendering.** Any game's sim must run headless in Node (this is also what makes bots free)
3. **Games are thin compositions.** If a new game requires modifying `packages/`, that is a stack gap to fix, not a workaround to write

Package layout agreed as a starting point (agent may propose changes — ask first):
`core` (fixed-timestep loop, entity model, math, transport interface) · `net` (schemas, binary serialization, quantization, clock sync) · `physics` (Rapier3d wrapper, headless-capable) · `server` (rooms, tick, per-client snapshots, rewind) · `client` (prediction/reconciliation, interpolation, input) · `render-pixi` · `render-three` · plus `games/`, `tools/` (netsim, bots), `infra/`.

## 7. Build order (proposed milestones — vertical slices, adjustable with Kodjo's sign-off)

1. **Scaffold** — monorepo, TS strict config, test runner, package skeletons
2. **Walking skeleton** — `core` loop + `net` serialization + minimal `server`/`client`: one sphere position syncing server→client over WebSocket, interpolated. No physics, no prediction. End-to-end first
3. **Physics in the loop** — Rapier wrapper (3D first), server simulates, client renders via `render-three`
4. **Prediction & reconciliation** — local player predicted, corrections smoothed; `tools/netsim` built in the same milestone (netcode is never validated on localhost conditions alone)
5. **Rewind** — history ring buffer, clock sync, lag-compensated queries
6. **Per-client snapshots & binary protocol hardening** — delta encoding, quantization plumbing (present but unconfigured), schema versioning
7. **HUD & input** — `render-pixi` overlay, touch + kb/m abstraction
8. **Bots & load validation** — headless clients, measure budgets 2 and 3 with 20 bots
9. **[Deferred] 2D path** — `physics` 2D flavor + Pixi-only game proving the stack isn't 3D-coupled — out of scope now (2D dropped)
10. **[Deferred] Reference sandbox game + deploy** — reference game out of scope now; deploy (Dockerfile + single-VPS) re-scoped with Kodjo when a deploy target exists

**Active program is M1–M8.** M9–M10 deferred per scope above. Milestones exercised with throwaway content, not a reference game.

Each milestone ends with: tests passing, docs updated (same commit), and a runnable demonstration.

## 8. Human-owned tasks (never the agent's)

Hosting account + payment (Hetzner/Fly.io class, single VPS), domain + DNS + TLS setup, secrets custody (agent gets scoped CI tokens only, never root credentials), physical test devices (mid-range Android, iPhone), human playtests on real networks, budget/region/ship judgment calls — and **all design decisions** (CLAUDE.md, prime directive).

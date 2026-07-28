# Netcode (current: client-authoritative relay in Colyseus rooms, ADR 0011 + 0013)

Client-authoritative. Each client owns and simulates its **own** entity and sends its
position; the server owns no simulation and **relays** peers' positions. Remote players
are interpolated on a clock-synced timeline. No prediction/reconciliation, no rewind, no
lag-comp (retired with the server-authoritative model — SEED §4 superseded by ADR 0011).
Positions only on the wire (no rotation yet).

Rooms run on **Colyseus** (ADR 0013): it owns the transport (default `ws`), room lifecycle,
matchmaking and the scale-out path; our binary relay is the payload inside each room — **no
`@colyseus/schema`**. Clients `joinOrCreate('parkour')` (fill-then-create, `maxClients = 20`, solo
→ own room); `joinById` handles join-by-code. Versions are pinned to Colyseus **0.16** (server
`colyseus@0.16.5` + client `colyseus.js@0.16.22` — the matched stable pair).

## Client (`packages/client`, composed in `modes/parkour`)

- **Local authority (`localController.ts`):** `createLocalController` drives the owned
  entity's sim one fixed step per tick and render-interpolates between the last two ticks
  for display smoothness. Its position IS the truth — there is no server correction, so no
  unacked queue, no reconciliation, no eased offsets. Each tick the client sends `STATE`
  (its authoritative position).
- **Peers:** remote players are mirrored into the local physics world as kinematic capsules
  (so walking into one collides locally) and rendered by interpolation ~`interpolationDelayMs`
  in the past on the **clock-synced** timeline (`serverNow`).
- **Reassembly + interpolation:** `createSnapshotReassembler` rebuilds full snapshots from
  full/delta messages; `snapshotClient` samples the interpolated peer view. The client's own
  entity is never in a snapshot (the server excludes the recipient), so the reassembled set
  is purely peers.
- **Clock sync (`clockSync.ts`, retained from M5):** from `PING`/`PONG` round-trips it keeps
  a smoothed estimate of `serverTime − localTime`. `serverNow()` drives peer interpolation
  playback. (Its former second job — timestamping lag-comp hit claims — is gone.)

## Server (`packages/server`) — Colyseus relay room (`rooms.ts`)

- **`ParkourRoom`** (a Colyseus `Room`, `maxClients = 20`, no `@colyseus/schema`): on `onJoin` it
  assigns an `EntityId`, stores the join name, sends `WELCOME`, and broadcasts the `ROSTER`.
  `onMessage(NET_CHANNEL)` receives our binary frames: `STATE` → store the client's last
  position (it owns its own body); `PING` → `PONG`. `onLeave` drops the player and re-broadcasts
  the roster.
- **Relay tick:** `setSimulationInterval` at 20 Hz advances `serverTimeMs` (the interpolation
  timeline) and sends each client its snapshot. **No physics.** Per-room tick time is aggregated
  for budget 3 (`getRoomStats`).
- **Per-client snapshots (SEED §3) + delta:** each client's message contains only its **peers'**
  positions (never its own). First send is full, then **deltas** vs the last positions sent —
  only entities whose *quantized* position changed, plus removed ids. Quantized u16/axis.
  Delta-vs-last-sent is safe on the reliable, ordered transport. The pure delta logic
  (`deltaSnapshot`) is unit-tested; the live path is proven by a tsx check + the load harness
  (a Colyseus server can't boot under vitest — `@pm2/io` corrupts its IPC).
- **Names:** each client sends an auto-random name as a join option; the room relays the peer
  roster (id → name) via `ROSTER`. Chosen names + accounts come later (platform SDK).

## Character controller (`@mp/character`) + content (`@mp/content`)

`stepCharacter` (Roblox-like kinematic locomotion — ground accel/decel, force-limited air
control, fixed-apex jump; ADR 0012) is now a stack-level, mode-agnostic library, run by each
client for its own character. Feel lives in `CharacterTuning` (`DEFAULT_TUNING`), tuned live in
the demo. The world is **data** (`@mp/content`, ADR 0014): the client loads a level
(`instantiateLevel`) into its local physics world — colliders, markers, physics-backed triggers,
and clock-driven pieces. Checkpoints/hazard/goal are a piece's own collider, detected by the
controller's real contacts (`CharacterBody.collisions()`).

## Ownership of shared objects (policy, not yet built — ADR 0011 D1=B)

The parkour demo has no shared dynamic props (each client owns only its character; the course
is static/clock-driven). When a mode adds shared props, each is owned by one client that simulates and relays
it, with handoff-on-contact, server-refereed claim arbitration, and reassignment on owner
disconnect. Accepted tradeoff: contested objects diverge/snap on handoff.

## Clock-driven world objects + checkpoints (ADR 0013)

The room's authoritative shared state is essentially just its **clock**. Moving world
objects are pure functions of `serverNow()` (the loader's `move`/`rotate` behaviors), so all
clients agree with no per-object state on the wire — moving platforms / rotating bars prove
this. **Checkpoints/hazard/fall** are client-detected via real contact with the level's trigger
colliders (ADR 0014); the player respawns at the last checkpoint. Per-player state (the
checkpoint index) goes through a `PersistenceAdapter` — `local` (`localStorage`) now,
account-backed later behind the same interface.

## Network simulation (`tools/netsim`)

`createNetsimClientTransport(inner, { latencyMs, jitterMs, lossRate })` delays/drops both
directions. It is **no longer wired into the parkour client** (the transport is now the Colyseus
SDK, ADR 0013); kept for potential reuse. Re-adding latency/loss to the demo would wrap the
Colyseus message layer instead.

## Game-feel values (Kodjo's call)

- `interpolationDelayMs` — how far in the past peers render. **100 ms**, provisional; tunable.
- `CharacterTuning` (speed, jump apex, gravity, accel/stop times, air control) — Roblox-derived
  defaults, live-tunable in the demo (ADR 0012). Client-side only under client authority.
- Camera feel (distance, sensitivity) — client-only, tunable in the demo.
- **Platform carry** — standing on a moving piece tracks it exactly (translation and spin), and
  walking on it composes normally. Implemented in the stack, not inherited from the engine; the
  mechanism and the measurements are in `docs/physics.md`.
- **Jump momentum: on.** Jumping off a mover adds its velocity (all three axes) to yours, so a fast
  platform flings you. Walking off inherits nothing. Needs no netcode: behaviors are pure functions
  of the synced clock, so every client derives the same platform pose, and each client is
  authoritative over its own body anyway (ADR 0011).
- **Platform time is fixed-step** (`createSimClock`, `@mp/core`): the level advances exactly one
  step per sim step, slewing (≤5% of a tick) to track `serverNow()`. Reading the wall clock inside
  the tick makes the platforms stall whenever the loop runs several ticks in one wake while the
  character keeps advancing a full step each.
- **Open:** whether a rotating platform should also turn which way you face. Riders orbit correctly;
  facing does not follow. Turntable in the gym at `z = -20`.

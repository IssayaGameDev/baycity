# Netcode (current: client-authoritative relay in Colyseus rooms, ADR 0011 + 0013)

Client-authoritative. Each client owns and simulates its **own** entity and sends its
position; the server owns no simulation and **relays** peers' positions. Remote players
are interpolated on a clock-synced timeline. No prediction/reconciliation, no rewind, no
lag-comp (retired with the server-authoritative model — SEED §4 superseded by ADR 0011).
Positions only on the wire (no rotation yet).

Rooms run on **Colyseus** (ADR 0013): it owns the transport (default `ws`), room lifecycle,
matchmaking and the scale-out path; our binary relay is the payload inside each room — **no
`@colyseus/schema`**. Clients `joinOrCreate('tps')` (fill-then-create, `maxClients = 20`, solo
→ own room); `joinById` handles join-by-code. Versions are pinned to Colyseus **0.16** (server
`colyseus@0.16.5` + client `colyseus.js@0.16.22` — the matched stable pair).

## Client (`packages/client`, composed in `games/tps`)

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

- **`TpsRoom`** (a Colyseus `Room`, `maxClients = 20`, no `@colyseus/schema`): on `onJoin` it
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

## Shared deterministic sim (`@mp/server/tps`)

World/collision config + `stepCharacter` (Roblox-like kinematic locomotion — ground
accel/decel, force-limited air control, fixed-apex jump; ADR 0012), run by each client for
its own character. Feel lives in a `CharacterTuning` object (`DEFAULT_TUNING`), tuned live in
the demo. Determinism verified in `tps.test.ts`. (It still lives under `@mp/server` for
historical reasons — ADR 0010/0011 — though the server no longer runs it; relocation is
future cleanup.)

## Ownership of shared objects (policy, not yet built — ADR 0011 D1=B)

The TPS demo has no shared dynamic props (each client owns only its character; the course is
static). When a game adds shared props, each is owned by one client that simulates and relays
it, with handoff-on-contact, server-refereed claim arbitration, and reassignment on owner
disconnect. Accepted tradeoff: contested objects diverge/snap on handoff.

## Clock-driven world objects + checkpoints (ADR 0013)

The room's authoritative shared state is essentially just its **clock**. Moving world
objects are pure functions of `serverNow()` from shared definitions, so all clients agree
with no per-object state on the wire — the TPS demo's elevator (`platformY(serverNow)`)
proves this. **Checkpoints** are client-detected and persisted to `localStorage`; the player
respawns at the last one touched (local now; platform-account sync later).

## Network simulation (`tools/netsim`)

`createNetsimClientTransport(inner, { latencyMs, jitterMs, lossRate })` delays/drops both
directions. It is **no longer wired into the TPS client** (the transport is now the Colyseus
SDK, ADR 0013); kept for potential reuse. Re-adding latency/loss to the demo would wrap the
Colyseus message layer instead.

## Game-feel values (Kodjo's call)

- `interpolationDelayMs` — how far in the past peers render. **100 ms**, provisional; tunable.
- `CharacterTuning` (speed, jump apex, gravity, accel/stop times, air control) — Roblox-derived
  defaults, live-tunable in the demo (ADR 0012). Client-side only under client authority.
- Camera feel (distance, sensitivity) — client-only, tunable in the demo.

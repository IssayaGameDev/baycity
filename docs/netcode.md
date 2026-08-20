# Netcode (current: client-authoritative relay in Colyseus rooms, ADR 0011 + 0013)

Client-authoritative. Each client owns and simulates its **own** entity and sends its
position; the server owns no simulation and **relays** peers' positions. Remote players
are interpolated on a clock-synced timeline. No prediction/reconciliation, no rewind, no
lag-comp (retired with the server-authoritative model — SEED §4 superseded by ADR 0011).
Positions only on the wire (no rotation yet).

Rooms run on **Colyseus** (ADR 0013): it owns the transport (default `ws`), room lifecycle,
matchmaking and the scale-out path; our binary relay is the payload inside each room — **no
`@colyseus/schema`**. Clients `joinOrCreate('parkour', { name, level })` (fill-then-create, `maxClients = 20`,
solo → own room); `joinById` handles join-by-code. Matchmaking is **filtered by `level`**
(`define(...).filterBy(['level'])`): a room only ever holds clients on the same level, because
geometry and the movement-base index a rider replicates (ADR 0021) are both positional and would
otherwise disagree. Filtering is per *supplied* option — a client that omits `level` matches any
room, so every client here names one — the browser defaults to `default` (`content/levels/default.json`) and bots take
`LEVEL`, also defaulting to `default`. These two have to agree or the load harness measures a room of bots
nobody can see. The server still loads no content; it never learns what a level is. Versions are pinned to Colyseus **0.16** (server
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
objects are pure functions of `serverNow()` (the loader's keyframe tracks — ADR 0029), so all
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
- `airControl` — **1**: air accel equals ground accel (55 m/s²). Kodjo asked for Roblox's feel and this is
  it — Roblox uses `TurnSpeedFactor` 1 in *both* its GroundController and its AirController, so it does
  not restrict air steering at all, and `MaintainLinearMomentum` (true) keeps your speed on release,
  which this already did. Stopping costs 0.17 s and a full reversal 0.23 s inside a 0.73 s hang. It put
  the measured standing gap past the running gap — see `obstacles.md`.
- `coyoteTime` — jump grace after losing footing, **100 ms** (3 ticks at 30 Hz), live-tunable; 0 turns it
  off. Spent on the way out, so one ledge is one jump however long the button is held. Not on the wire:
  `STATE_GROUNDED` still means real footing (ADR 0034).
- `jumpBufferTime` — **100 ms**. The mirror of coyote time: a press slightly *early* is held pending and
  fires when footing arrives. Also what keeps a latched one-tick tap alive long enough to be spent, so a tap
  shorter than a tick registers at all (ADR 0041).
- `liftStoreTime` — **100 ms**, matched to `coyoteTime`. A departed mover's velocity stays available to a
  late jump, so a coyote jump off a platform inherits what an on-time one does. Closes the gap ADR 0034 left.
- **Arc shaping — live, at the literature's starting values** (ADR 0041). Each reverts to 1 on its own.
  - `fallGravityScale` **1.6** — gravity multiplier while falling. Shortens the drop without lowering the
    apex. Usual range 1.5–2.5.
  - `apexGravityScale` **0.5** over an `apexSpeed` **4 m/s** window — Celeste's value. Buys hang time to aim
    a landing and coasts ~0.14 m higher, which is what widened the measured gap to 4.1 m (`obstacles.md`).
    Gated on having no ground underfoot: a resting character sits at `vy = 0`, inside any apex window.
  - `jumpCutScale` **1 (off)** — `vy` kept when the button is released mid-rise, i.e. variable jump height.
    Off because 30 Hz makes it two-valued rather than a range: a tap is one latched tick, and at 0.4 that
    landed at 0.89 m against a 2.7 m hold. Mario 64 has no release-cut either. Doing it properly needs a
    minimum-jump-time guard, which is not built (ADR 0042).
- `jumpHeight` is **2.7 and the jump did not change**: the vertical integration used to undershoot by 10%, so
  3 flew as 2.70. It is exact now and the number was set to the apex that was always flying. Typing 3.0 is a
  real change for the first time — +0.30 m apex, +0.18 m reach (ADR 0041).
- `maxFallSpeed` — terminal velocity, **60 m/s**, live-tunable with the rest. Set as a safety net
  rather than for feel: above anything the shipped levels reach (~30 m/s to a kill plane), and 2 m of
  travel per tick at 30 Hz, which keeps a fall inside what the swept resolve handles on a
  `physical-fall` level that has no kill plane. Lowering it is a feel change — Kodjo's number.
- Camera feel (distance, sensitivity) — client-only, tunable in the demo.
- **Air control above `moveSpeed`**: the air solve steers `moveSpeed` worth of velocity and carries the
  excess untouched, so a mover's fling is never braked by holding the direction of flight, and no input
  direction can raise speed above what you came in with (ADR 0041). Not a tunable — `airControl` is still
  the only air knob, and max air speed is still borrowed from `moveSpeed`.
- `landKick` — camera dip on landing, in metres at an impact of one plain jump. **0.12**; 0 turns it off.
  The only piece of jump feel that lives in the view rather than the controller.
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
  facing does not follow. `default.json` has a turntable off to the side for this.

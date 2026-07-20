# Netcode (current: client-authoritative relay, ADR 0011)

Client-authoritative. Each client owns and simulates its **own** entity and sends its
position; the server owns no simulation and **relays** peers' positions. Remote players
are interpolated on a clock-synced timeline. No prediction/reconciliation, no rewind, no
lag-comp (retired with the server-authoritative model — SEED §4 superseded by ADR 0011).
Positions only on the wire (no rotation yet).

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

## Server (`packages/server`) — relay only

- **Tick:** 30 Hz fixed (`TICK_RATE_HZ`); snapshots at 20 Hz. The room advances
  `serverTimeMs` per tick (the interpolation timeline); it runs **no physics**.
- **Room (`room.ts`):** per connection, stores the last `STATE` position that client
  reported (it owns its own body). Assigns ids, answers `PING` with `PONG`.
- **Per-client snapshots (SEED §3) + delta:** each client gets its own message containing
  only its **peers'** current positions (never its own). After a first full snapshot,
  subsequent ones are **deltas** vs the last positions sent to that client — only entities
  whose *quantized* position changed, plus removed ids. Positions are **quantized** to
  u16/axis. Delta-vs-last-sent is safe on the reliable, ordered WebSocket transport.

## Shared deterministic sim (`@mp/server/tps`)

World/collision config + `stepCharacter` (world-space move + jump/gravity), run by each
client for its own character and by bots. Movement/jump feel are shared constants so every
client's own body moves identically. Determinism verified in `tps.test.ts`. (It still lives
under `@mp/server` for historical reasons — ADR 0010/0011 — though the server no longer runs
it; relocation is future cleanup.)

## Ownership of shared objects (policy, not yet built — ADR 0011 D1=B)

The TPS demo has no shared dynamic props (each client owns only its character; the course is
static). When a game adds shared props, each is owned by one client that simulates and relays
it, with handoff-on-contact, server-refereed claim arbitration, and reassignment on owner
disconnect. Accepted tradeoff: contested objects diverge/snap on handoff.

## Network simulation (`tools/netsim`)

`createNetsimClientTransport(inner, { latencyMs, jitterMs, lossRate })` delays/drops
both directions. The TPS demo's Tweakpane "Network" folder tunes it live (affects how
peers look; the owned body is local and unaffected).

## Game-feel values (Kodjo's call)

- `interpolationDelayMs` — how far in the past peers render. **100 ms**, provisional; tunable.
- Camera feel (distance, sensitivity) — client-only, tunable in the demo.

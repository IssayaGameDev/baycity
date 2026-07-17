# ADR 0009 — Load validation with headless bots

Status: accepted (M8)

## Context

SEED §7 (M8): validate budgets 2 (downstream bandwidth/client) and 3 (server tick
time) with ~20 bots. Netcode can't be trusted from localhost-of-one alone.

## Decision

- **Bots reuse the real wire** (`@mp/bots`): each is a standard-WebSocket client that
  drives synthetic circular movement at the tick rate (so its player moves — realistic
  delta bandwidth) and counts bytes received. No rendering/prediction — a pure load
  generator + meter.
- **Server exposes tick-time stats** (`ServerHandle.stats()`): avg/max wall-clock of
  `room.step` + snapshot build per tick — directly budget 3.
- **In-process harness** (`load.ts`): one Node process runs the server + N bots for a
  window and reports both budgets. Simple and enough for a first read.

## Consequences

- Both budgets measured comfortably under at 20 bots (see `budgets.md`).
- Tick timing includes event-loop contention from co-located bots (a ballpark, not an
  isolated benchmark); payload-only bandwidth excludes WS/TCP/IP overhead. Documented.

## Rejected

- **Separate-process / multi-machine bots** — cleaner isolation but more harness
  machinery than a first budget read needs; revisit if numbers get close.
- **Rendering/predicting bots** — unnecessary for budgets 2 & 3, and would add noise;
  budget 1 (client frame time) is on-device + human-owned (SEED §8).

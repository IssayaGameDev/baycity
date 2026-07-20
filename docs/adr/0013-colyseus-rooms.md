# ADR 0013 — Colyseus rooms foundation

Status: accepted. Supersedes SEED §2's transport decision (uWebSockets.js behind a custom
transport interface). Builds on the client-authoritative model (ADR 0011).

## Context

The product is a playlist of games; each game is a set of persistent-world rooms. We need
many rooms, invisible auto-join (fill-then-create), join-by-code, no matchmaking, ~5,000 peak
CCU, multi-region. Kodjo chose **Colyseus** (open-source; optional managed Cloud hosting) for
the room/lifecycle/scale layer. Our own uWS server had no room/matchmaking/scale-out.

## Decision

- **Colyseus is the server** (transport + room lifecycle + matchmaking + scale path). Our
  hand-rolled uWS transport and tick loop are gone. `startServer()` runs a Colyseus `Server`
  and defines one room type (`tps`).
- **Our binary client-authoritative relay rides *inside* each room** — **no `@colyseus/schema`.**
  `TpsRoom` stores each client's last `STATE`, and a 20 Hz `setSimulationInterval` relays
  per-client delta+quantized peer snapshots (exclude-self) via `sendBytes`; ping/pong answers
  the clock. All our messages ride one Colyseus channel (`NET_CHANNEL`); we dispatch on our
  own version+type header. The `net` codecs are unchanged.
- **Auto-join** = Colyseus `joinOrCreate('tps')` (fills the most-full non-full room, else
  creates one; `maxClients = 20`; solo → own room). **Join-by-code** = `joinById` (server
  supports it; client UI is a later nicety).
- **Names + roster:** client sends an auto-random name as a join option; the room broadcasts a
  `ROSTER` (id → name) on join/leave (protocol v7). The client draws billboard nametags.
- **Checkpoints:** client-detected, persisted to `localStorage`; the player respawns at the
  last one touched. **Clock-driven platform:** a demo elevator whose height is
  `f(serverNow())` from a shared definition — synced across clients with no per-object state
  on the wire (validates the shared clock). Both are throwaway content.

## Technical calls / deviations

- **Version pinned to Colyseus 0.16** (server `colyseus@0.16.5`, client `colyseus.js@0.16.22`).
  The latest server (0.17) has no compatible published client — 0.16.22 can't parse 0.17's
  matchmaking response shape. 0.16 is the matched stable pair.
- **Default `ws` transport, not uWebSockets** (deviates from the PLAN). The uWS transport pulls
  a github-hosted `uwebsockets-express` → `uWebSockets.js` chain that pnpm couldn't resolve
  cleanly. `ws` is Colyseus's default; **the uWS transport is a later perf swap** (a transport
  config line). This supersedes SEED §2's uWS choice.
- **Live-server tests run via `tsx`, not vitest.** `@colyseus/core` imports `@pm2/io`, which
  calls `process.send()` and corrupts vitest's fork-pool IPC — so no vitest test can boot the
  server. The pure relay/delta logic is unit-tested (`rooms.test.ts`); the live path (handshake,
  same-room join, relay, ping/pong) is proven by a tsx check and the `@mp/bots` load harness.

## Scale-out (deferred to deploy)

Built single-process on Colyseus's default local presence/driver, but structured so scale-out
is a config swap: Redis presence/driver for multi-process, multi-region deployment, and
Colyseus Cloud vs self-host land in the deploy phase (SEED §7). Rooms are independent (no
cross-room state), the easy case for scale-out.

## Consequences

- New deps: `colyseus` (server), `colyseus.js` (client + bots). `@mp/netsim` and the custom
  `@mp/core` transport interface are unused by the TPS path now (kept for potential reuse).
- Budgets (20 bots, this machine): budget 2 ~2.6 kB/s/client (relayed payload; Colyseus framing
  extra), budget 3 avg 0.59 / max 1.28 ms — both comfortably under.
- `@mp/server/tps` still houses the shared sim + world/checkpoint/platform defs (client + bots
  import it); the server runtime doesn't. Relocation remains future cleanup.

## Rejected

- **`@colyseus/schema` state sync** — would replace the client-authoritative binary netcode
  (ADR 0011) with server-authoritative full-float sync; loses quantization/delta/exclude-self.
- **Hand-rolled lobby over our own uWS** — Colyseus gives room/matchmaking/scale-out + managed
  hosting for free at the target scale; not worth rebuilding.

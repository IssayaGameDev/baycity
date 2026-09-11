# Netcode

Client-authoritative relay over Colyseus rooms (ADR 0011, ADR 0013). Each client simulates its own body and sends `STATE`; the server stores the latest per client and relays **peers** as per-client delta snapshots. No server physics, no prediction/reconciliation, no rewind.

## Packages

| Package | Role |
|---|---|
| `packages/core/src/tick.ts` | `TICK_RATE_HZ = 30`, `TICK_DT = 1/30`. One rate for every game — two rates would be two protocols. |
| `packages/core/src/simClock.ts` | `createSimClock` — fixed-step clock slewed to a reference |
| `packages/net/src/*.ts` | codecs, quantization, flag bits |
| `packages/server/src/{index,rooms}.ts` | `startServer`, `GameRoom`, `deltaSnapshot` |
| `packages/client/src/{clockSync,reassembler,snapshotClient,interpolation,localController}.ts` | headless client pieces |
| `packages/game-client/src/{netHost,baseFrame}.ts` | `createNetHost`, `worldFromBase` |
| `packages/tps/src/client.ts` | the composition that actually sends/receives (`startTpsClient`) |

Dead on the live path: `@mp/core` transport types, `packages/client/src/transport-ws.ts`, `tools/netsim`.

## Server (`packages/server`)

- `startServer({ port? })` → `ServerHandle { port, stats(), stop() }`. `DEFAULT_PORT = 9200`. `colyseus@0.16.5`; clients `colyseus.js@^0.16.22`.
- One room type: `define('game', GameRoom).filterBy(['game', 'level'])`. Clients `joinOrCreate('game', { name, game, level })`. Filtering is per supplied option — an omitted key matches any room.
- `GameRoom`: `maxClients = 20`, `setPatchRate(null)` (no `@colyseus/schema`), ids from `FIRST_PLAYER_ID = 1000`, default name `Player ${id}`. `onJoin` → `WELCOME` + `ROSTER` broadcast; `onLeave` → `ROSTER`.
- `SNAPSHOT_RATE_HZ = 20`: `setSimulationInterval` accumulates `serverTimeMs` (0 at room create) and sends each client `encodeSnapshot(deltaSnapshot(player, peers, time))`. Recipient never included.
- `deltaSnapshot`: first send full; then `changed` = peers where `relayDiffers` (flags, quantized x/y/z, quantized yaw, quantized speed, or `base` differ from last sent), `removed` = ids gone. Safe because the transport is reliable+ordered.
- `getRoomStats()` → `{ ticks, tickAvgMs, tickMaxMs }`, aggregated over the process's rooms (budget 3).

## Wire format (`packages/net`)

`PROTOCOL_VERSION = 10`. Little-endian. Every message rides one Colyseus channel `NET_CHANNEL = 'n'` as raw bytes; header `u8 version, u8 type`. `readMessageType` peeks; `readHeader` throws on mismatch (server catches and drops the frame).

| Type | Const | Dir | Layout | Bytes |
|---|---|---|---|---|
| 1 | `MSG_SNAPSHOT` | s→c | below | 9 + 12n + 2 + 2m |
| 2 | `MSG_WELCOME` | s→c | `u16 playerId` | 4 |
| 3 | `MSG_STATE` | c→s | `f32 x,y,z, u8 flags, f32 yaw, f32 speed, u8 base` | 24 |
| 4 | `MSG_PING` | c→s | `u32 clientTimeMs` | 6 |
| 5 | `MSG_PONG` | s→c | `u32 clientTimeMs, u32 serverTimeMs` | 10 |
| 6 | `MSG_ROSTER` | s→c | `u16 count, [u16 id, u8 nameLen, utf8]*` | 4 + Σ(3+len), name ≤ 48 B |

### Snapshot (`snapshot.ts`)

| Field | Type | Bytes | Notes |
|---|---|---|---|
| version, type | u8, u8 | 2 | |
| msgFlags | u8 | 1 | bit0 = isFull |
| serverTimeMs | u32 | 4 | interpolation timeline |
| changedCount | u16 | 2 | header total 9 |
| changed[].id | u16 | 2 | |
| changed[].x,y,z | u16 ×3 | 6 | `quantizeAxis` |
| changed[].flags | u8 | 1 | unquantized |
| changed[].yaw | u8 | 1 | `quantizeYaw` |
| changed[].speed | u8 | 1 | `quantizeSpeed` |
| changed[].base | u8 | 1 | index, not quantized — entity total 12 |
| removedCount | u16 | 2 | |
| removed[] | u16 | 2 each | |

### Quantization (`quantize.ts`)

| Symbol | Value | Resolution |
|---|---|---|
| `QUANT_BOUND` | 40 | ±40 m over u16 → 80/65535 ≈ 1.22 mm; clamped |
| yaw | 256 steps/turn | ≈1.4°; wrapped, dequantizes to [−π, π] |
| `SPEED_BOUND` | 16 m/s | 255 steps → 0.063 m/s; clamped |

Upstream `STATE` is full float; quantization happens once, in the snapshot encoder.

### Flags byte (`state.ts`, `gameStates.ts`)

| Bits | Owner | Symbols |
|---|---|---|
| 0 | platform | `STATE_GROUNDED` |
| 1 | platform | `STATE_RISING` |
| 2 | platform | `STATE_DEAD` |
| 3..7 | game (ADR 0064) | `STATE_GAME_SHIFT = 3`, `STATE_GAME_BITS = 5`, `STATE_GAME_MASK = 0b11111000` |

`packStates(declared, active)` / `unpackStates(declared, flags)`: `declared` is `ModeDescriptor.states` in bit order; > `MAX_GAME_STATES` (5) throws `TooManyStatesError`; undeclared names ignored. Reordering `declared` reinterprets every peer's bits.

### Movement base (ADR 0021)

`base` = `LoadedLevel.baseIndex + 1`, 0 = none. Non-zero ⇒ `position` and `yaw` are in that clock-driven piece's frame. Sender: index ≥ 255 falls back to world coordinates. Receiver: `worldFromBase(loaded, e, rendered)` (`packages/game-client/src/baseFrame.ts`) — `rendered=true` → `basePoseOf(i, 'render')` for drawing, `false` → `'tick'` for collision proxies; unknown piece ⇒ treated as world-space.

## Client

### `createNetHost` (`packages/game-client/src/netHost.ts`)

```ts
createNetHost({ game, level, onWelcome, setStatus }): NetHost
// NetHost: id(), sample(), nameOf(id), roster(), myName, send(state), serverNow(), dispose()
```

Synchronous, join in flight; `id()` is `null` until `WELCOME`. `PING_INTERVAL_MS = 250`; `INTERPOLATION_DELAY_MS = 100` (module const, not exposed on `NetHost`). Endpoint: `?server=` query param, else `ws://${location.hostname}:9200`. Name: random `ADJ`/`NOUN` pair.

### Clock sync (`packages/client/src/clockSync.ts`)

`createClockSync({ now?, smoothing? = 0.1 })`. Per pong: `rtt = recv − send`, `offset = serverTimeMs − (send + rtt/2)`; first sample sets, later samples EMA. `serverNow() = now() + offset` (equals local time before the first sample). `rttMs()`, `ready()`.

### Peers

- `createSnapshotReassembler().apply(msg)` — full clears; `changed` upserts whole entities; `removed` deletes.
- `createSnapshotClient({ interpolationDelayMs, serverNow, maxBufferMs? = 1000 })` — `sample()` = `interpolateAt(buffer, serverNow() − delay)`.
- `interpolateAt`: outside the buffer holds the nearest endpoint (no extrapolation). Between samples: position lerped only when both share `base` (else older held); `speed` lerped; `flags`, `yaw` from the older sample.
- `@mp/tps`: peer collision proxy = `addKinematicBody` capsule at `worldFromBase(loaded, e, false)`; drawn at `worldFromBase(loaded, e, true)`; base-switch offset decays with `BASE_SWITCH_HALFLIFE = 0.1` (`packages/tps/src/characterView.ts`).

### Local body and sim clock

- `createLocalController({ world: LocalWorld, tickRateHz })` — `step(cmd)`, `state()`, `renderPositions()` (lerp of the last two ticks). Run by `@mp/tps` inside `startFixedLoop({ tickRateHz: TICK_RATE_HZ })`; each tick `net.send` with `flags`, base-relative `position`/`yaw`, `speed = hypot(vx, vz)`.
- `createSimClock({ tickMs: TICK_DT * 1000, reference: net.serverNow })`: `tick()` advances exactly `tickMs`, slews ≤ `maxSlewMsPerTick` (default 5 % of `tickMs`), snaps when drift > `resyncThresholdMs` (500). Clock-driven pieces are posed from `simClock.tick()`, never `serverNow()` directly.

## Uniform vs universal (ADR 0065)

| Must be uniform across a room | Merely universal |
|---|---|
| `createNetHost`, `loadLevelInto`, `worldFromBase`; `TICK_RATE_HZ`; `PROTOCOL_VERSION` | `createScene`, `createShell`, `createStatusLine`, `levelsFor`, `localProgress` |

## Endpoint override and `/relay` (ADR 0074)

Every `modes/*/vite.config.ts` proxies `/relay` → `http://localhost:9200` (`ws: true`, prefix stripped). `composeShareLink` (`tools/share/src/index.ts`) hands the page `?server=wss://<host>/relay`, so page and relay share one tunnel hostname. Without `?server=` the proxy is unused.

## Tests

Codecs `packages/net/src/*.test.ts`; delta rules `packages/server/src/rooms.test.ts`; reassembly/interpolation/clock `packages/client/src/*.test.ts`; `createSimClock` `packages/core/src/simClock.test.ts`; live matchmaking `tools/bots/src/matchmaking.test.ts` (vitest project `live-server`, `pool: 'threads'`).

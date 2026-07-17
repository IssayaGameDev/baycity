# Wire protocol (v3)

Binary, little-endian. No JSON on the hot path (SEED §2). Defined in
`packages/net`. `PROTOCOL_VERSION = 3`.

## Framing

Every message starts with `u8 version` (`PROTOCOL_VERSION`, decoder rejects
mismatches) then `u8 type` (`readMessageType` peeks it).

Types: `SNAPSHOT=1`, `WELCOME=2` (server→client); `INPUT=3` (client→server);
`PING=4` (c→s), `PONG=5` (s→c); `FIRE=6` (c→s), `HIT=7` (s→c broadcast).

## Snapshot — `1` (server → client)

Per-client full state. `u32 serverTimeMs`, `u32 lastProcessedInputSeq` (recon
ack), `u16 entityCount`, then per entity `u16 id` + `f32 x,y,z`. Header 12 B,
entity 14 B. Includes the recipient's own player.

## Welcome — `2` (server → client, on connect)

`u16 playerId` — the client's own entity id.

## Input — `3` (client → server)

`u32 seq`, `i8 moveX×127`, `i8 moveZ×127`.

## Ping / Pong — `4` / `5` (clock sync)

- Ping (c→s): `u32 clientTimeMs`.
- Pong (s→c): `u32 clientTimeMs` (echoed) + `u32 serverTimeMs`.

Client computes offset = `serverTimeMs − (clientSend + rtt/2)`, rtt = recv − send.

## Fire — `6` (client → server, lag-compensated hit claim)

`u32 fireTimeMs` (server time the shooter was rendering), `f32 origin x,y,z`,
`f32 direction x,y,z` (unit). Server clamps `fireTimeMs` to the honored rewind
window, reconstructs player positions then, and ray-tests.

## Hit — `7` (server → client, broadcast)

`u16 shooterId`, `u16 targetId`.

## Current limits (will change)

- Positions raw `float32`; quantization is M6.
- Full-state snapshots each tick (delta is M6).
- Codec round-trips covered by `packages/net/src/*.test.ts`.

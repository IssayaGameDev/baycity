# Wire protocol (v2)

Binary, little-endian. No JSON on the hot path (SEED §2). Defined in
`packages/net`. `PROTOCOL_VERSION = 2`.

## Framing

Every message starts with:

| offset | type | field | notes |
|---|---|---|---|
| 0 | u8 | version | `PROTOCOL_VERSION`; `readHeader` rejects mismatches |
| 1 | u8 | type | message-type discriminator (`readMessageType` peeks it) |

Types: `MSG_SNAPSHOT = 1`, `MSG_WELCOME = 2` (server→client), `MSG_INPUT = 3` (client→server).

## Snapshot — `type = 1` (server → client)

Per-client full state (no delta yet; delta is M6).

| offset | type | field |
|---|---|---|
| 2 | u32 | serverTimeMs (interpolation timeline) |
| 6 | u32 | lastProcessedInputSeq (reconciliation ack for this client) |
| 10 | u16 | entityCount |
| 12 + n·14 | u16 | entity id |
| +2 | f32 ×3 | position x, y, z |

Header 12 B, entity 14 B. Includes the recipient's own player entity (used both
for reconciliation and, when prediction is off, for rendering).

## Welcome — `type = 2` (server → client, on connect)

| offset | type | field |
|---|---|---|
| 2 | u16 | playerId (the client's own entity id) |

## Input — `type = 3` (client → server)

| offset | type | field |
|---|---|---|
| 2 | u32 | seq (per-client, increasing) |
| 6 | i8 | moveX × 127 (−1..1) |
| 7 | i8 | moveZ × 127 (−1..1) |

## Current limits (will change)

- Positions are raw `float32`; quantization is M6.
- Full-state snapshots each tick — see budget 2 (SEED §5); meaningful only after
  delta + quantization (M6), measured under load (M8).
- Codec round-trips covered by `packages/net/src/*.test.ts`.

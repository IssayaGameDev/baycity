# Wire protocol (v6)

Binary, little-endian. No JSON on the hot path (SEED §2). Defined in
`packages/net`. `PROTOCOL_VERSION = 6`. Client-authoritative (ADR 0011).

## Framing & versioning

Every message: `u8 version` then `u8 type`. `readMessageType` peeks the type;
`readHeader` validates both and throws on mismatch. The server wraps inbound
handling in a guard, so a wrong-version/corrupt frame is ignored, not fatal —
this is the schema-versioning safety net (every message self-describes its version).

Types: `SNAPSHOT=1`, `WELCOME=2` (s→c); `STATE=3` (c→s); `PING=4`/`PONG=5` (clock sync).
(v5's `INPUT`, `FIRE`, `HIT` were removed with the server-authoritative model.)

## Snapshot — `1` (server → client, per-client)

Relayed **peer** positions (a client is never sent its own body). Full state or a delta
vs the client's previous snapshot. **Positions are quantized** to `u16`/axis over
±`QUANT_BOUND` (~16-bit, SEED §5).

| field | type | notes |
|---|---|---|
| flags | u8 | bit0 = isFull |
| serverTimeMs | u32 | interpolation timeline |
| changedCount | u16 | |
| changed[] | u16 id + u16 x,y,z | full: all peers; delta: new/changed only |
| removedCount | u16 | |
| removed[] | u16 id | delta: peers to drop (e.g. disconnected) |

Header 9 B, changed entity 8 B. Deltas skip unchanged entities entirely (an entity is
"changed" only when its *quantized* position moves). Delta-vs-last-sent is safe because
the transport is reliable+ordered (WebSocket); a UDP transport would need ack-based
baselines. Client reassembles full snapshots (`createSnapshotReassembler`).

## Welcome — `2`  ·  State — `3`  ·  Ping/Pong — `4`/`5`

- Welcome (s→c): `u16 playerId`.
- State (c→s): `f32 x`, `f32 y`, `f32 z` — the sender's own authoritative position (14 B
  total). Full float upstream; quantization happens once, in the snapshot encoder on relay.
- Ping (c→s): `u32 clientTimeMs`. Pong (s→c): `u32 clientTimeMs` + `u32 serverTimeMs`.

## Notes / limits

- Quantization is plumbed with a single default range (`QUANT_BOUND`); per-game
  bounds/precision are a later tuning concern. Smallest-three quaternion
  quantization arrives when rotation goes on the wire.
- Codec round-trips + delta apply covered by `packages/net/src/*.test.ts` and
  `packages/client/src/reassembler.test.ts`.

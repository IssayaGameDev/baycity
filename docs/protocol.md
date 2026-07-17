# Wire protocol (v4)

Binary, little-endian. No JSON on the hot path (SEED §2). Defined in
`packages/net`. `PROTOCOL_VERSION = 4`.

## Framing & versioning

Every message: `u8 version` then `u8 type`. `readMessageType` peeks the type;
`readHeader` validates both and throws on mismatch. The server wraps inbound
handling in a guard, so a wrong-version/corrupt frame is ignored, not fatal —
this is the schema-versioning safety net (every message self-describes its version).

Types: `SNAPSHOT=1`, `WELCOME=2` (s→c); `INPUT=3` (c→s); `PING=4`/`PONG=5`
(clock sync); `FIRE=6` (c→s) / `HIT=7` (s→c broadcast).

## Snapshot — `1` (server → client, per-client)

Full state or a delta vs the client's previous snapshot. **Positions are
quantized** to `u16`/axis over ±`QUANT_BOUND` (~16-bit, SEED §5).

| field | type | notes |
|---|---|---|
| flags | u8 | bit0 = isFull |
| serverTimeMs | u32 | interpolation timeline |
| lastProcessedInputSeq | u32 | reconciliation ack |
| changedCount | u16 | |
| changed[] | u16 id + u16 x,y,z | full: all entities; delta: new/changed only |
| removedCount | u16 | |
| removed[] | u16 id | delta: entities to drop |

Header 13 B, changed entity 8 B (was 14 B raw f32). Deltas skip unchanged
entities entirely (an entity is "changed" only when its *quantized* position moves).
Delta-vs-last-sent is safe because the transport is reliable+ordered (WebSocket);
a UDP transport would need ack-based baselines. Client reassembles full snapshots
(`createSnapshotReassembler`).

## Welcome — `2`  ·  Input — `3`  ·  Ping/Pong — `4`/`5`  ·  Fire — `6`  ·  Hit — `7`

- Welcome (s→c): `u16 playerId`.
- Input (c→s): `u32 seq`, `i8 moveX×127`, `i8 moveZ×127`.
- Ping (c→s): `u32 clientTimeMs`. Pong (s→c): `u32 clientTimeMs` + `u32 serverTimeMs`.
- Fire (c→s): `u32 fireTimeMs`, `f32 origin xyz`, `f32 dir xyz`.
- Hit (s→c): `u16 shooterId`, `u16 targetId`.

## Notes / limits

- Quantization is plumbed with a single default range (`QUANT_BOUND`); per-game
  bounds/precision are a later tuning concern. Smallest-three quaternion
  quantization arrives when rotation goes on the wire.
- Codec round-trips + delta apply covered by `packages/net/src/*.test.ts` and
  `packages/client/src/reassembler.test.ts`.

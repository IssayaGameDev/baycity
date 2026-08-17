# Wire protocol (v8)

Binary, little-endian. No JSON on the hot path (SEED §2). Defined in
`packages/net`. `PROTOCOL_VERSION = 8`. Client-authoritative (ADR 0011), rooms on
Colyseus (ADR 0013).

## Framing & versioning

Every message: `u8 version` then `u8 type`. `readMessageType` peeks the type;
`readHeader` validates both and throws on mismatch. Handlers guard decoding, so a
wrong-version/corrupt frame is ignored, not fatal — the schema-versioning safety net.

**Transport (ADR 0013):** all messages ride a single Colyseus message channel
(`NET_CHANNEL`) as raw bytes (`sendBytes`/`onMessage`); we dispatch on the version+type
header inside. Colyseus adds its own framing around each payload — the bytes below are
our payload only.

Types: `SNAPSHOT=1`, `WELCOME=2`, `PONG=5`, `ROSTER=6` (s→c); `STATE=3`, `PING=4` (c→s).
(v5's `INPUT`/`FIRE`/`HIT` went with server authority; `ROSTER` arrived with rooms.)

## Snapshot — `1` (server → client, per-client)

Relayed **peer** positions (a client is never sent its own body). Full state or a delta
vs the client's previous snapshot. **Positions are quantized** to `u16`/axis over
±`QUANT_BOUND` (~16-bit, SEED §5).

| field | type | notes |
|---|---|---|
| msgFlags | u8 | bit0 = isFull |
| serverTimeMs | u32 | interpolation timeline |
| changedCount | u16 | |
| changed[] | u16 id + u16 x,y,z + u8 stateFlags | full: all peers; delta: new/changed only |
| removedCount | u16 | |
| removed[] | u16 id | delta: peers to drop (e.g. disconnected) |

Header 9 B, changed entity 9 B. Deltas skip unchanged entities entirely; an entity is
"changed" when its *quantized* position moves **or its state flags change** — leaving the
ground need not move you a whole quantization step. Delta-vs-last-sent is safe because
the transport is reliable+ordered (WebSocket); a UDP transport would need ack-based
baselines. Client reassembles full snapshots (`createSnapshotReassembler`), which keeps
whole entities so an unchanged peer retains its last flags.

### State flags (v8)

`STATE_GROUNDED` (bit 0), `STATE_RISING` (bit 1). These carry the animation state a viewer
**cannot** reconstruct from a position curve, and they are **never interpolated** — the
interpolator takes them from the sample at or before the render time (`interpolation.ts`),
because blending "grounded" toward "airborne" is meaningless and fading a change in early
would start an air pose while the player is still on the ground.

Vertical velocity is not a substitute for `GROUNDED`: it passes through zero at the apex of
every jump (reads as standing, mid-air) and is negative while running down a ramp or stairs
(reads as falling, on the ground). Facing and planar speed *are* derived on the client, and
correctly — the controller always faces its movement direction, so velocity direction is
authoritative. Yaw goes on the wire only if aim ever decouples from movement.

## Welcome — `2`  ·  State — `3`  ·  Ping/Pong — `4`/`5`  ·  Roster — `6`

- Welcome (s→c): `u16 playerId`.
- State (c→s): `f32 x`, `f32 y`, `f32 z`, `u8 flags` — the sender's own authoritative position
  plus its state flags (15 B total). Full float upstream; quantization happens once, in the
  snapshot encoder on relay. Flags pass through unquantized.
- Ping (c→s): `u32 clientTimeMs`. Pong (s→c): `u32 clientTimeMs` + `u32 serverTimeMs`.
- Roster (s→c): `u16 count`, then `[u16 id, u8 nameLen, utf8 name]*` — peer id → display
  name. Broadcast on join/leave (names are static per session, so it's not per-tick).

## Notes / limits

- Quantization is plumbed with a single default range (`QUANT_BOUND`); per-game
  bounds/precision are a later tuning concern. Smallest-three quaternion
  quantization arrives when rotation goes on the wire.
- Codec round-trips + delta apply covered by `packages/net/src/*.test.ts` and
  `packages/client/src/reassembler.test.ts`.

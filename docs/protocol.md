# Wire protocol (v1)

Binary, little-endian. No JSON on the hot path (SEED §2). Defined in
`packages/net`. `PROTOCOL_VERSION = 1`.

## Framing

Every message starts with:

| offset | type | field | notes |
|---|---|---|---|
| 0 | u8 | version | `PROTOCOL_VERSION`; decoder rejects mismatches |
| 1 | u8 | type | message-type discriminator |

## Messages

### Snapshot — `type = 1` (`MSG_SNAPSHOT`)

Server → client. Full state of the replicated entities (no delta yet; delta is M6).

| offset | type | field |
|---|---|---|
| 2 | u32 | serverTimeMs (sim time; client interpolation timeline) |
| 6 | u16 | entityCount |
| 8 + n·14 | u16 | entity id |
| +2 | f32 | position.x |
| +6 | f32 | position.y |
| +10 | f32 | position.z |

Header 8 B, entity 14 B. Positions are raw `float32` in M2; quantization
(~16 bit/axis, smallest-three quats) is plumbed in M6.

No client → server messages exist yet (no input/prediction until M4/M7).

## Current limits (will change)

- `entityCount` is u16; entity ids are u16.
- Full-state each snapshot — see budget 2 (SEED §5); meaningful only once delta +
  quantization land (M6) and are measured under load (M8).
- Round-trip is covered by `packages/net/src/snapshot.test.ts`.

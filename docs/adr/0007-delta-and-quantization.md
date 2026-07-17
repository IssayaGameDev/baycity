# ADR 0007 — Delta encoding, quantization, schema versioning

Status: accepted (M6)

## Context

SEED §5's bandwidth budget scales with *changed* replicated entities × bytes ×
rate. M6 builds the levers: delta encoding, position quantization, and hardened
schema versioning (SEED §7). Per-client snapshot construction (since M2) makes
per-client deltas natural.

## Decision

- **Position quantization** (`net/quantize.ts`): u16/axis over ±`QUANT_BOUND`
  (~16-bit, SEED §5). Entity payload drops 14 B → 8 B. A single default range;
  per-game tuning deferred ("present but unconfigured"). Smallest-three quaternion
  quantization waits until rotation is on the wire.
- **Delta snapshots** (`net/snapshot.ts` v4): a message is full or a delta vs the
  last positions sent to *that* client — changed entities (quantized) + removed ids.
  An entity is "changed" only when its quantized value moves, so resting props cost
  nothing. First send to a client is full.
- **Reliable-transport baseline:** delta-vs-last-sent is correct because WebSocket is
  reliable + ordered. A UDP swap (SEED §2) would need ack-based baselines; noted, not
  built.
- **Client reassembly** (`client/reassembler.ts`): rebuilds full snapshots from
  full/delta messages before interpolation — keeps the interpolation/prediction code
  unchanged.
- **Schema versioning:** every message carries the version byte (`readHeader` rejects
  mismatches); the server guards inbound handling so a wrong-version/corrupt frame is
  ignored, not fatal.

## Consequences / per-game cost

- Bandwidth levers exist now; they're measured under load with bots in M8. The demo's
  few entities don't stress them.
- Quantization adds ~1 cm position error (within `QUANT_BOUND`); reconciliation absorbs it.
- Delta relies on the reliable transport; revisit for UDP.

## Rejected

- **Ack-based delta baselines now** — unnecessary complexity while the transport is
  reliable; the seam is documented for the UDP swap.
- **Quantizing on the client for the diff** — the server owns quantization; the client
  only dequantizes.

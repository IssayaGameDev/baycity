# Wire protocol (v10)

Binary, little-endian. No JSON on the hot path (SEED §2). Defined in
`packages/net`. `PROTOCOL_VERSION = 10`. Client-authoritative (ADR 0011), rooms on
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
| changed[] | u16 id + u16 x,y,z + u8 stateFlags + u8 yaw + u8 speed + u8 base | full: all peers; delta: new/changed only |
| removedCount | u16 | |
| removed[] | u16 id | delta: peers to drop (e.g. disconnected) |

Header 9 B, changed entity 12 B. Deltas skip unchanged entities entirely; an entity is
"changed" when its *quantized* position moves, **or its state flags change, or its quantized
facing or speed change, or its movement base changes** — leaving the ground, turning on the spot,
and stepping onto a platform need not move you a whole quantization step. The comparison is on the quantized bytes, not the floats behind them:
relaying a change the recipient could never receive is what the delta exists to avoid.
Delta-vs-last-sent is safe because the transport is reliable+ordered (WebSocket); a UDP
transport would need ack-based baselines. Client reassembles full snapshots
(`createSnapshotReassembler`), which keeps whole entities so a skipped peer retains its last
flags, facing, speed and base.

### Facing and speed (v9)

`u8` each, alongside the flags. Facing is 256 steps over the turn (1.4°, wrapped not clamped);
speed is 0–16 m/s in 255 steps (0.063 m/s). Both are quantities **only the owner knows**:

- **Facing follows the input direction, not the movement direction.** A player who jumps one way
  and turns in the air is still travelling the way they jumped, so a viewer deriving facing from
  the position curve never turned them.
- **Speed is locomotion only, with a platform's carry taken out.** Differencing a position gives
  world speed, so a viewer saw a player standing on a moving platform as walking — while on their
  own screen they were sliding. It is the quantity `@mp/humanoid`'s gait documents as its
  input; the owner passes its own rig exactly these two numbers, so a peer's rig gets the same
  values rather than a guess at them.

Interpolation treats them differently: **speed is lerped** between samples (an ordinary quantity,
and it drives stride length and swing amplitude, which would otherwise staircase at the snapshot
rate); **facing is not** (an angle — lerping goes the wrong way round the circle half the time,
and the animator smooths facing itself via `yawHalfLife`).

### Movement base (v10)

`u8`. 0 means none; otherwise it is `LoadedLevel.baseIndex + 1` for the clock-driven piece the sender is
standing on, and **`position` and `yaw` are in that piece's frame instead of the world's** — the
relative-to-base replication Unreal's based movement does, and Source-family engines get by parenting
(ADR 0021).

It exists because a viewer draws the level at its own current time and draws peers on a delayed
timeline: a world position put a rider where they were 100 ms ago on a deck drawn where it is now, which
is nearly a metre on the fast mover and slides across the deck every time the platform reverses. The
relative transform does not change while the platform moves, so the two clocks stop mattering.

- **An index, not a collider handle.** Every client instantiates the same level JSON in the same order,
  so the index means the same thing everywhere by construction. A Rapier handle happens to match today
  and is not a promise.
- **Above 254 pieces there is no room in the byte**, and those fall back to world coordinates rather than
  aliasing onto another piece's frame.
- **Interpolation cannot blend across a base change** — two samples on different bases are two different
  coordinate systems — so the older sample is held for that one interval (`interpolation.ts`).
- **The receiver must undo the frame against the *drawn* pose of the piece** (`basePoseOf(i, true)`), not
  the last sim tick's, or the rider is pinned to the wrong instant of the deck's travel and the artifact
  comes straight back.
- The relative coordinates reuse the same `±QUANT_BOUND` axis quantization as world positions. They are
  small, so the shared bound is generous rather than tight: 1.2 mm either way.

### State flags (v8)

`STATE_GROUNDED` (bit 0), `STATE_RISING` (bit 1), `STATE_DEAD` (bit 2). These carry the state a
viewer **cannot** reconstruct from a position curve, and they are **never interpolated** — the
interpolator takes them from the sample at or before the render time (`interpolation.ts`),
because blending "grounded" toward "airborne" is meaningless and fading a change in early
would start an air pose while the player is still on the ground.

`DEAD` is an event rather than a pose: a corpse and a player standing still have identical position
curves. It is the entire wire cost of a death — each viewer runs its own ragdoll from its own
interpolated pose of that player, so no part transforms travel and the corpses disagree between
clients by design (ADR 0019). Separate bits, so "dead" is readable off a player who is also grounded.

Vertical velocity is not a substitute for `GROUNDED`: it passes through zero at the apex of
every jump (reads as standing, mid-air) and is negative while running down a ramp or stairs
(reads as falling, on the ground).

v8 claimed facing and planar speed were derived correctly on the client, on the grounds that the
controller always faces its movement direction. It does not: facing follows the *input*, so it
moves without the position moving (turning in the air, turning on the spot), and a derived planar
speed counts a platform's carry as walking. Both now travel — see above. What is still derived is
the peer's **vertical** velocity, and there the carry riding along in it does no harm: its only
consumer is the joint lag, which wants total vertical motion whatever caused it.

## Welcome — `2`  ·  State — `3`  ·  Ping/Pong — `4`/`5`  ·  Roster — `6`

- Welcome (s→c): `u16 playerId`.
- State (c→s): `f32 x`, `f32 y`, `f32 z`, `u8 flags`, `f32 yaw`, `f32 speed`, `u8 base` — the sender's own
  authoritative transform (in its base's frame when `base` is non-zero) plus everything about it a viewer
  cannot derive (24 B total). Full float
  upstream; quantization happens once, in the snapshot encoder on relay. Flags pass through
  unquantized.
- Ping (c→s): `u32 clientTimeMs`. Pong (s→c): `u32 clientTimeMs` + `u32 serverTimeMs`.
- Roster (s→c): `u16 count`, then `[u16 id, u8 nameLen, utf8 name]*` — peer id → display
  name. Broadcast on join/leave (names are static per session, so it's not per-tick).

## Notes / limits

- Quantization is plumbed with a single default range (`QUANT_BOUND`); per-game
  bounds/precision are a later tuning concern. Smallest-three quaternion
  quantization arrives when rotation goes on the wire.
- Codec round-trips + delta apply covered by `packages/net/src/*.test.ts` and
  `packages/client/src/reassembler.test.ts`.

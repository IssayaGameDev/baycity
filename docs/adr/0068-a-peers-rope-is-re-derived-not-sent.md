# ADR 0068 — A peer's rope is re-derived, not sent

Status: accepted. One free flag bit says a peer is swinging; each viewer runs the owner's own anchor search to
work out where.

## Context

The rope drew for its owner and for nobody else. Measured, the cause is one sentence: **the anchor is a position
and nothing on the wire carries game-defined positions.**

A peer arrives as 12 bytes — `u16` id, three quantized `u16` axes, `u8` state flags, `u8` yaw, `u8` speed, `u8`
base — at `SNAPSHOT_RATE_HZ = 20`. ADR 0064 already recorded the shape of this limit: five boolean bits are
free, values are a budget decision.

Two things were already in place. Bits 3..7 of the flags byte are the game's and arrive decoded
(`unpackStates`), so a boolean costs nothing. What was missing was any way for game code to read a peer at all:
`TpsClient` had `id()` and `partsOf(id)` and no list of peers.

Three options were priced:

| | Cost | Accuracy |
| --- | --- | --- |
| **Re-derive from one free bit** | 0 bytes | Approximate |
| Anchor in every snapshot | +6 bytes on 12 = **+50%** per changed entity, 20 Hz, sent whether swinging or not | Exact |
| Anchor once per grab, as a relayed event | Near zero — the anchor never changes mid-swing | Exact |

The third is the best answer on cost and accuracy and needs a new message type plus a server relay path: a
general game event channel, which is a platform addition of its own. Kodjo chose the first, to find out whether
seeing other people's ropes matters before spending bytes or building a channel.

## Decision

**One bit travels. Each viewer works out the rest.**

`states: ['swinging']`, `playerStates` reporting it. On the frame a peer's bit turns on, the viewer casts the
owner's own fan from where it drew them and latches the result.

### The latch is the whole trick

Searching once, on the rising edge, gives a fixed anchor. Re-searching every frame would give one that wandered
away from them as they swung — a laser pointer, not a rope. It is invisible until two people are in a room,
which is why it is the test that gets broken on purpose to prove it fails.

### Why it agrees at all

Both halves arrive on the **same delayed timeline**: the flag and the position come out of the same snapshot, so
a viewer sees the bit flip at the moment it sees them at the grab spot. The fan, the scoring and the geometry are
identical on every client — the last of those by ADR 0021, which is already load-bearing for base indices.

The search became `castForAnchor(world, from, heading, tuning, exclude)`, taking a world rather than a host,
**so owner and viewer run the same code**. Two copies of a selection rule is how two halves of one agreement
drift (ADR 0057).

Both now cast from `CHAR_HALF_HEIGHT + CHAR_RADIUS + 0.3` rather than 1.0 m. A viewer has no collider handle for
the capsule standing in for a peer, so a ray starting at the crown returns that capsule and nothing else — every
ray in the fan, wasted. Starting clear of it fixes that, and using one constant for both means a viewer derives
from the same geometry the owner grabbed from.

### `TpsClient.peers()`

`{ id, position, yaw, states }` per peer, rebuilt once per frame from what the render pass already computed —
not sampled again. Two samples in one frame land on different interpolation instants, and a rope drawn from one
while the body was drawn from the other would hang off the hand.

Position and yaw are already out of any moving platform's frame (ADR 0021) and on the timeline the rig was drawn
on, so a game reading this sees what the eye sees.

## Consequences

- Other players' ropes draw. Theirs are grey, yours warm, so a crowded screen still says which is which.
- **Zero bytes.** The bit was already being transmitted and discarded.
- If the search finds nothing, no rope is drawn. They still swing; a line to a guess is worse than no line.
- 8 tests on the latch: grabbing on the rising edge, keeping the same anchor across four frames of movement
  **with no extra casts**, releasing and re-grabbing fresh, finding nothing, having no world yet, forgetting a
  leaver, one rope per player, and the rest length measured from the shoulder.
- `probe.ts`'s job is now done twice over.

### Where it is wrong, in order of size

- **The wire carries facing, the owner searched along velocity.** Running straight they agree; turning while
  grabbing, they do not, and the viewer can pick a different beam.
- Interpolation puts them near where they were, not on it.
- The fan is a sampled cone, so a small shift in origin can land on a different ray and a different point.

## Rejected

**Sending the anchor every snapshot.** +50% per changed entity, paid by every player whether swinging or not,
for a value that does not change while it matters.

**Re-deriving every frame instead of latching.** Wandering anchor.

**A relayed event on grab.** The right answer, deferred: exact, near-free, and it needs a message type and a
server relay path that nothing else asks for yet.

## Known open

- **`QUANT_BOUND = 40` and the swing level runs to z = 54.** Positions clamp on the wire, so peers past z = 40
  are drawn stuck at 40 — bodies, not only ropes. Pre-existing (the course already reached z = 42) and made
  visible by the test beams. Widening it costs precision or becomes per-level: a budget decision.
- **Valued state still does not travel.** This ADR routes around that for one case; a charge level, a target id
  or a second anchor would each need the same trick or real bytes.
- A peer's rope is drawn from *their* rest length but never simulated, so it cannot go slack on their screen and
  taut on yours. Nobody has looked at whether that reads.

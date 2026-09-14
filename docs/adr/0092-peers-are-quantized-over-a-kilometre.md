# ADR 0092 — A peer's position is quantized over ±1000 m, not ±40 m

Status: accepted. Retunes the `QUANT_BOUND` of ADR 0007; protocol v11. Does not change the wire layout.

## Context

Kodjo's report: a peer who walks far enough from the world origin freezes. On their own screen they keep
moving; on everyone else's they stop dead at an invisible wall, still bobbing and jumping in place, sometimes
hovering over nothing.

`quantizeAxis` mapped a world axis to a `u16` over ±`QUANT_BOUND`, and `QUANT_BOUND` was **40 m**. Past 40 m
the value clamps. Two symptoms follow from the one cause:

- **The wall.** The position on the wire stops growing, so the peer is drawn pinned at 40 m while the real
  body walks on. Y is a separate axis and keeps updating well inside its own bound, so they still visibly jump
  and land — moving vertically, frozen horizontally.
- **Hovering.** At 40 m there is often no floor, because the platform they are really standing on is further
  out. The avatar is drawn over empty space.

And a third, worse than clamping: `relayDiffers` compares **quantized** values (`rooms.ts`), deliberately, so
the delta never relays a change a viewer could not see. Past the bound both frames quantize identically, so
the server concludes the peer has not moved and stops sending them at all. Not lag. Silence.

This was known and written down rather than fixed — `docs/games/keyboard/known-open.md`, ADR 0068 ("the swing
level runs to z = 54"), ADR 0073 ("boards past z = 40 exceed `QUANT_BOUND`"). Two shipped levels were already
over the line: `swing.json` reaches z = 54, and `keyboard.json`'s last board sits at z = 51.5.

## Decision

**`QUANT_BOUND = 1000`.** Kodjo's number, chosen as a range levels are not expected to leave soon.

The wire does not change. Still three `u16`s, still 12 bytes per snapshot entity. The same bits are read
against a wider ruler, so the step grows from 1.22 mm to **3.05 cm** (2000 / 65535).

**Protocol v11**, for a change that alters no layout. A v10 reader would parse v11 bytes without error and
place every peer at a twenty-fifth of their true distance. The version byte turns a silently wrong world into
a refused frame.

## Why 3 cm is affordable and 40 m was not

A peer's position is **cosmetic**. The server runs no simulation and each client is authoritative for its own
body (ADR 0011), so nothing collides against a relayed position — it is drawn, not resolved. The client
interpolates between snapshots, so the grid is never seen as a grid. A blocky character at 20 Hz has no detail
a 3 cm step disturbs.

Clamping is not cosmetic. It is a peer who stops existing.

There is a small bandwidth gain alongside the loss: a coarser step means a near-stationary peer crosses a step
less often, so `relayDiffers` fires less. At walking speed (~25 cm per tick) nothing changes.

## Rejected

- **Per-axis bounds** (X/Z ±1000, Y ±250, four times the vertical precision for no extra bytes). Correct and
  free, and rejected by Kodjo in favour of one number that is the same on every axis. Revisit only if vertical
  precision is ever seen.
- **Wider integers.** A `u32` per axis buys precision nobody can perceive for +6 B per entity per tick, on the
  one stream that is actually hot.
- **Per-level bounds, now.** The right long-term answer and the stated next step (below), but it is welcome-packet
  plumbing through six files plus editor UI, and the levels are broken today.
- **A per-level number typed by hand, with no way to see it.** The failure mode is the bug being fixed here:
  set it too small and peers freeze, silently, in multiplayer only. Kodjo's counter — draw the bound as a box
  in the level editor — removes that objection, and is why the next step is what it is rather than nothing.
- **Interest management** (distant peers relayed at a lower rate or not at all). Raised by Kodjo and parked
  after measuring: the room caps at 20 clients, downstream runs 2.8 kB/s against a 20–30 kB/s target, and the
  server tick 0.33 ms against 33 ms. There is no cost to recover. Noted for when it matters: the lever is
  **rate and relevancy**, not precision — cutting bits saves bytes only, while dropping a distant peer saves
  both the bytes and the O(N²) change check that is what actually grows.

## Next step

Per-level bounds, drawn as a box in the editor. The bound travels in `WELCOME` so server and client cannot
disagree, a level that sets none gets this ±1000 as its default, and geometry outside the box is flagged where
someone can see it. That last part is the whole point: a bound you can see is a bound that cannot silently be
too small.

## Consequences

- Servers and clients must be deployed together. A version mismatch now fails loudly (`readHeader` throws, the
  server drops the frame) rather than misplacing peers.
- Position error on a peer rises from ~0.6 mm to ~1.5 cm. Cosmetic by the argument above; measurable by no
  budget we track.
- `swing.json` and `keyboard.json` work in multiplayer end to end for the first time.
- `quantize.test.ts` asserts a tolerance derived from `QUANT_BOUND` instead of a fixed decimal place, so the
  next retune does not read as a test failure.

# ADR 0093 — A level says how far it reaches, and the editor draws it

Status: accepted. Follows ADR 0092, which raised one global bound and named this as the next step. Protocol v12.

## Context

ADR 0092 replaced `QUANT_BOUND = 40` with `1000` and said the real answer was per-level bounds. The objection
recorded there against letting a level set its own was that **a human picks the number**, and picking it too
small fails silently: peers freeze past the edge and then stop being relayed at all, in multiplayer only, on
everybody's screen but their own, with nothing logged anywhere.

Kodjo's answer removed the objection rather than arguing with it: *"if it's per level and we have like a big
red box that represents the bound in the level editor, it'll be easily visualizable. That's the kind of thing
that I want. Hidden in the code is where there's going to be human mistakes."*

He is right, and it inverts the argument. The hazard was never that the number is per level; it was that the
number is invisible. A bound you can see is a bound that cannot quietly be too small.

## Decision

**`level.config.netBounds`** — half-extent in metres, optional. Absent means `QUANT_BOUND`, so every level
authored before this keeps working and nothing had to be migrated.

**The room owns one bound, and tells everyone.** The first client into a room passes its level's value as a
join option; the room keeps it for its life and sends it to every client in `WELCOME` (protocol v12, welcome
4 B → 8 B). Later clients' values are ignored.

**The editor draws it**, as a red `Box3Helper` about the origin, **off by default** and toggled in the same
Inspector section that holds the number — Kodjo's call: *"toggled on when the user is editing the actual
bounds, not always present."* Beside it, the step the bound buys in centimetres, and a count of how many
top-level objects have geometry outside it.

## Why the room decides rather than each client

A bound read two ways puts peers in the wrong place. A bound read one way, even a stale one, costs only
precision. So the value that matters is the room's, not each client's own copy of the level — a client running
week-old content still agrees with everyone about where people are.

First-one-wins rather than last: changing it mid-room would move every peer already on screen. Rooms are
`filterBy(['game', 'level'])`, so in practice every client is sending the same number anyway.

The relay still never reads a level (ADR 0052). It is told a number; it does not learn what a level is.

## Why the reach is measured off the drawn objects

`Box3.setFromObject` on each top-level group, not authored positions. A 40 m platform whose origin is at 10 m
reaches 30 m, and the far edge is where a player can stand — standing there is the thing the bound has to
carry. Top-level only, or a nested child is counted twice with its parent.

## Rejected

- **Per-level, authored, with no way to see it.** The failure mode of ADR 0092's bug, re-armed. This ADR
  exists because the box removes it.
- **Deriving the bound from the level automatically, with no field.** Safe, and it was the shape originally
  proposed, but it would re-size itself every time a platform is dragged. Kodjo chose a stated number with a
  visible box: predictable, and wrong in a way you can see.
- **Per-axis bounds** (finer Y for free). Rejected in ADR 0092 and not revisited; one number per level is
  already the thing being made visible, and three would be three things to get wrong.
- **Letting each client use its own level's bound.** Disagreement is worse than staleness, as above.
- **Refusing to save a level whose geometry is outside its bound.** The count is shown, not enforced. A level
  mid-edit is often briefly wrong, and the consequence is cosmetic-plus-silent rather than corrupt.
- **Sending the bound per snapshot.** It cannot change during a room, so it is a welcome field, not a
  per-tick one.
- **Leaving the box on always.** A level is usually well inside its bound, so it would be a red box around
  everything forever.

## Consequences

- Protocol v12: `WELCOME` is 8 bytes. Server and clients deploy together, as at v11.
- `quantizeAxis` / `dequantizeAxis` / `encodeSnapshot` / `decodeSnapshot` / `deltaSnapshot` all take the bound,
  defaulting to `QUANT_BOUND` so existing call sites and tests read unchanged.
- `relayDiffers` compares at the room's bound, so a coarse room relays fewer changes and a fine one more.
  That is the intended trade: bandwidth against precision, chosen per level.
- A level with a small `netBounds` gets precision back — a 100 m level quantizes to 3 mm rather than 3 cm.
- `Level.config` gained a field, so `setNetBounds` joins `setEnvironment` and `setMode` as a config op, with
  the same "a prefab has none" refusal.
- The editor declares `@mp/net` directly (it already had it through `@mp/client`) for `QUANT_BOUND`, so the
  default is one constant rather than two that can drift.

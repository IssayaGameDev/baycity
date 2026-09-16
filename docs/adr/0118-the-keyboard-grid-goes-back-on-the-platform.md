# ADR 0118 — The keyboard grid goes back on the platform

Status: accepted. Reverts the lattice of [ADR 0115](0115-the-keys-are-the-games-not-the-platforms.md) and all
of [ADR 0116](0116-a-cell-belongs-to-the-board-its-centre-is-on.md). The rest of ADR 0115 — the key geometry
as a game setting — stands, and so does [ADR 0117](0117-snapping-moves-the-corner.md).

## Context

Kodjo: *"I don't understand the work that you did on the positioning of the keys… it's not great. I want to
revert it to the way that we had before without the global grid."*

The lattice was meant to make two platforms continue each other without the author solving for the grid. It
did the opposite in practice. Three rounds:

1. **Lattice, whole footprint only** (ADR 0115). Seams lost a row unless the join landed within 5.4 cm of a
   cell boundary — 88% of positions. Kodjo: *"instead of having to align the platform for the keys to match, I
   now have to align the world grid for the platforms to match."*
2. **Lattice, cell goes to whoever owns the centre** (ADR 0116). No gaps, but caps overhang an outer rim by up
   to half a key, over the void.
3. **Reverted.** Caps centred on each platform, whole caps only, leftover as margin.

## Decision

`boardOf` is what it was: `cols = floor(width / pitch)`, `startX = -((cols - 1) × pitch) / 2`. Every platform
centres its own board.

Two platforms placed edge to edge still do not continue each other. That is a known cost, accepted
deliberately, and it is smaller than either thing the lattice cost: nothing hangs over an edge, and no
platform has to be sized or positioned to satisfy a grid.

## What the three rounds were worth

**Kept:** the key geometry as a game setting. Pitch, fill and height were component parameters, so a level of
thousands of platforms held thousands of copies with nothing keeping them in sync — *"I have 7,000 platforms.
Do you think I'm gonna do this 7,000 times."* That was the real defect in the area and it is fixed.

**Kept:** corner snapping (ADR 0117). Snapping a box's centre put its edges on the grid only for even cell
counts, so half of all sizes were off. That came out of chasing the keycap symptom and is the fix for the
whole editor, not just for keyboards.

**Learned:** the alignment was never a keycap problem. Three attempts inside `keycaps.ts` each fixed the
previous one's symptom, because what was wrong was that a box's edges did not land on the grid. Corner
snapping addresses that. Whether aligned platforms should then share a continuous board is a separate
question, and one to answer only if it is asked for.

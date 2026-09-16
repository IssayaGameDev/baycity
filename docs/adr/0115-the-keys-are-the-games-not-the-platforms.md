# ADR 0115 — The keys belong to the game, on one shared grid

Status: accepted. Changes how `Keyboard` (ADR 0069) decides where its caps go and who owns their size.

## Context

Kodjo: a level is a succession of platforms forming a compound ground, and *"the keyboard keys never really
align between the platforms… I have no idea where or how to position it for the keys to line up."*

Measured on a 5 m platform at the shipped 0.9 pitch:

- `cols = floor(5 / 0.9)` = 5, spanning 3.6 m, and `startX = -((cols - 1) × pitch) / 2` **centred the grid on
  the platform's own origin** — so the 0.5 m left over became margin.
- Place the next platform edge to edge and the two nearest caps are **1.4 m apart** instead of 0.9.
- To make them continue, the second platform has to be centred at +4.5 rather than +5: the two platforms
  **overlap by 0.5 m**.

And that overlap is `width mod pitch`, a different number for every platform size. There was no rule to learn,
which is why the question had no answer.

Then, asked whether he would set the pitch on each platform: *"I have 7,000 platforms. Do you think I'm gonna
do this 7,000 times."* Which is the deeper fault — the pitch was a **component parameter**, so a compound
ground held one copy per platform with nothing keeping them in sync, and two platforms that disagree can never
align however the grid is anchored.

## Decision

**The key geometry is the game's.** `pitch`, `fill` and `height` are settings (ADR 0087) in
`content/keyboard/game.json`, edited once in the editor's Game row. `Keyboard` keeps `glyphs` and `seed`,
which genuinely differ per surface — the shipped level uses four different seeds.

No content migration. `readParams` walks the declarations, not the file's keys, so a `"pitch": 0.9` left in an
old component is ignored and every level loads unchanged.

**The grid is anchored to the world, not to each platform.** Cell centres fall on multiples of the pitch
measured along the board's own axis from the world origin (`axisCells`). No platform decides its own phase, so
no two can be out of step — any sizes, any positions, any number of platforms.

`phase` is the board's origin along that axis, so boards sharing a rotation share a lattice; for the
axis-aligned platforms a compound ground is made of, that is simply the world x or z.

**A cap is drawn only where its whole footprint fits.** Kodjo's call, over the alternative of giving a cell to
whichever platform contains its centre. Clean edges, nothing overhanging into the void.

The cost is at a seam: a cell straddling a join belongs to neither platform, so that row is missing. The
window is `pitch × fill` out of every `pitch`, so a seam must land within `pitch × (1 − fill) / 2` of a cell
**boundary** to keep the row unbroken — 5.4 cm at 0.9 / 0.88. Platform widths that are odd multiples of the
pitch put every edge on a boundary: at pitch 1, **5 × 5 platforms placed 5 apart join perfectly**, which is
what Kodjo reached for in the first place.

## Limits, stated rather than fixed

- **Axis-aligned only.** The grid runs along each platform's own axes, so two platforms with different yaw
  cannot share a lattice.
- **Lettering still restarts per board.** `glyphAt` is keyed on the per-board column and row, so two aligned
  platforms show repeated letters rather than one continuous keyboard. Kodjo: *"there's nothing about glyphs
  really"* — left alone deliberately.

## Rejected

- **Centre-inside**: give a straddling cell to the platform its centre is on. No seam gap ever, at any size,
  with no rule to follow — at the price of a cap overhanging an outer rim by up to half its width. Kodjo chose
  clean edges. It is a one-line change in `boardOf` if the gaps prove worse in play.
- **Requiring platform sizes and positions to be multiples of the pitch.** An invisible authoring rule that
  breaks silently, and the thing this ADR exists to remove.
- **One `Keyboard` node spanning the whole ground.** Fine for a single box, useless for platforms at different
  heights.
- **A per-board phase offset parameter.** Lets a board be nudged onto its neighbour's grid by hand. Manual,
  and 7,000 of them.

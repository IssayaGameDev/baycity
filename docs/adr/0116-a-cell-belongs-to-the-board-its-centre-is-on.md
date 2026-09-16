# ADR 0116 — A cell belongs to the board its centre is on

Status: accepted. Reverses one decision inside [ADR 0115](0115-the-keys-are-the-games-not-the-platforms.md);
the world lattice and the key geometry as a game setting both stand.

## Context

ADR 0115 put every keyboard on one world lattice so platforms could be placed without solving for the grid.
It also took Kodjo's choice on a sub-question: a cap is drawn only where its **whole footprint** fits, so a
cell straddling a join belongs to neither board and that row is missing.

In play: *"the keyboard grid is not good. This was a bad idea. Instead of having to align the platform for the
keys to match, I now have to align the world grid for the platforms to match."*

Exactly right, and the number was already known when the question was asked. A cap is dropped unless the seam
lands within `pitch × (1 − fill) / 2` of a cell boundary — **5.4 cm** at the shipped 0.9 / 0.88. So 88% of
seam positions lose a row, and the author is back to solving an alignment puzzle, just a different one. The
option was presented as "when a seam falls through the middle of a cell", which reads as an edge case; it is
almost every case. That framing is what made the wrong option look reasonable.

## Decision

**A cell belongs to the board whose face contains its centre**, over the half-open span `[-half, +half)` —
half-open so a centre landing exactly on a shared edge is claimed by one board and never by both.

Every cell of a compound ground then gets exactly one cap, at any sizes and any positions, with no rule to
satisfy. Measured at pitch 1, platforms placed edge to edge: widths 5, 4, 3.7, 6.25 and 9 all join with
spacing exactly 1.0.

The price moves to the **outer** rim, where a cap whose centre is just inside the edge can overhang by up to
half its footprint. Cosmetic only — caps are visual (ADR 0069), so nothing is stood on that is not there.

A platform narrower than a cap now gets the cell whose centre lands on it, where before it got none. That
follows from the same rule, and it is the right way round: a small platform in a compound ground getting its
cap matters more than a small isolated one getting an oversized cap. The first is a hole in the floor; the
second is a choice somebody made by putting a `Keyboard` on something narrower than a key.

## What this says about the first attempt

The lattice was right and the sub-decision was wrong, and the sub-decision was wrong because the cost was
quoted qualitatively when it was already known as a number. An option whose downside is "88% of positions" and
one whose downside is "rarely, at a seam" are not the same option, and only one of them was on the table.

## Rejected

- **Clipping or shrinking a cap that overhangs an outer rim.** Caps are one `InstancedMesh` per glyph with
  uniform geometry, so per-cap clipping is not cheap, and a non-uniformly shrunk edge cap looks wrong next to
  its neighbours.
- **Overhang only where a neighbouring board continues past the edge, clean at an outer rim.** The best of
  both, and buildable — every board is constructed together in `drawKeycaps`, so an edge cell could ask
  whether another face covers its overhang. Held back deliberately: it is machinery for a complaint nobody has
  made yet, and this ADR exists because of a rule added ahead of the need for it.

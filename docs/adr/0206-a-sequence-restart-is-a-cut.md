# ADR 0206 — A sequence restart is a cut

Status: accepted. Kodjo's report and go: a wall on a `restart` loop should be back at its start at once, and it hit
the player on the way. Kodjo's call: a rider is left behind.

## Context

Motion is a pure function of time (ADR 0137), and a `restart` loop's function jumps at each pass boundary: the
wall's pose goes from 186 m along its path back to where it was placed. Every reader of two poses took that jump
for travel. `shove` (ADR 0186) swept the wall's shape along the whole line back and pushed whoever stood on it
— measured, 5.8 m for a player the wall's own path went over. Rapier read a 186 m step as speed, `render` blended
the wall back across the path for a tick, `baseCarry` gave a rider the jump as velocity, and `motionSlices` cut
the tick into its maximum of 8.

## Decision

- **`restartsBetween(c, from, to)`**: a `restart` crossing into a pass that plays — not a yo-yo turning round, not
  the hold after the last pass. Read on the sequence's own clock, with its offset.
- **`update` marks a frame cut** — its own sequence, or a parent's — and a cut is a teleport: posed with no
  velocity, swept from where it is now, blended from where it is now. `motionSlices` counts no travel for it.

- **A rider stays where they are, and falls** (Kodjo's call, as Roblox does): the deck is back at its start, they
  are not. `LoadedLevel.cut(handle)` says the ridden body cut; the tick drops the ride (`leaveBase`: base, carry and
  lift go; the character's own motion stays). Measured before: a deck that rose 20 m and restarted down pulled its
  rider down with it — the ride's longer look for a deck that dropped away found it below.

## Rejected

- **The rider going back with the deck**: Kodjo's call, they stay.
- **`releaseFooting` for the rider**: it stops them dead as a respawn must; walking off a vanished deck keeps your
  own motion.
- **A flag on the Sequence, "teleport on restart"**: a restart is never travel; there is nothing to choose.
- **Detecting any large jump between two poses**: a fast mover is not a cut, and the threshold would be a guess.

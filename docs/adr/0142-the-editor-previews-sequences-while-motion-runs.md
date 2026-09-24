# ADR 0142 — The editor previews sequences while Motion runs

Status: accepted. The editor half of [ADR 0141](0141-the-game-runs-sequences.md); keeps ADR 0125's one-walk
preview and ADR 0126's authored-pose rule.

## Context

The viewport has to show what the game will build, which is why the preview reads the loader's rule rather
than inventing one. But ADR 0137 settled what an object looks like when nobody is previewing: as it was set
up, so a platform whose sequence starts it invisible and without a collider can still be seen and clicked.
And a drag while the preview runs must not write the animation into the file — the groups hold authored
*plus* the preview, and a sequence's turn and scale are multiplied in, not added, so subtracting them the way a
mover's offset is subtracted would be wrong.

## Decision

**Sequences show only while Motion runs.** Stopped, `posesAt` is asked without them and every object is as it
was set up. Movers keep their old behaviour — posed at the clock even when stopped — until they are deleted.

**The document composes; the preview applies.** `posesAt` returns the whole pose, the loader's composition
read off the document; the preview puts it on the groups — position, turn on the right, scale, `visible` for a
disabled branch, and opacity on material copies a fadeable node was given at build.

**`poseOf` is `posesAt(...)[i]`.** Its separate ancestor climb had to be taught every new rule a second time,
and a pose computed two ways is a pose that can drift between them (ADR 0106).

**A write-back undoes each part the way it went in** (`unpreviewed`): subtract what was added, divide off what
was multiplied. Pure and tested against a group composed from a known authored transform.

## Rejected

- **Showing level time 0 when stopped**, as movers do. A platform that starts faded out and without a collider
  would be invisible in the editor exactly when someone is trying to place it.
- **A separate "preview on edit" toggle.** Kodjo chose the Motion button alone, with no scrub (the brief).
- **Stretching meshes by rebuilding them each frame.** The counter-scaled holder already makes a group's scale
  a stretch, which is what the game draws.

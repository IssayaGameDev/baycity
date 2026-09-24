# ADR 0138 — Only easing is borrowed

Status: accepted. The library behind [ADR 0137](0137-motion-is-a-sequence-of-stages.md).

## Context

Kodjo's rule: reuse a tween library rather than write one. Whatever is used has to honour the invariant
motion has had since ADR 0013 — **a pure function of time**. Every client asks the same question at the same
synced millisecond and must get the same answer, the editor previews any instant, a late joiner lands
mid-sequence, and ADR 0104 evaluates a fast platform several times inside one tick. A library that keeps a
playhead only qualifies if the same time gives the same pose however the playhead got there.

Measured, in a throwaway script outside the repo:

| candidate | finding |
| --- | --- |
| GSAP | free, not open source. Its licence bars "tools that allow users to build visual animations without code that […] competes with Webflow's visual animation building capabilities" — which describes the editor's sequence component. Whether a level editor competes with Webflow is a legal question |
| tween.js | MIT, and no timeline: sequencing is `chain()`, "start that when this ends", which only plays forward in real time |
| anime.js 4.5 | MIT, a timeline with `seek`. Across its own `loop`/`alternate` passes, 19–21 of 80 jumps gave a different pose from a fresh seek, and a yo-yo pass was wrong even fresh; `seek(t, true)` (callbacks muted) broke jumps inside a single pass. Within one pass, with its looping done by us, 9,000 of 9,000 jumps agreed |

## Decision

**Our code does the timing; `d3-ease` supplies the easing formulas and nothing else.** BSD-3, no
dependencies, a few kB. `sequence.ts` maps its own ease names onto it, so the file format does not depend on
which library computes the curve.

Once a speed, "as long as its stage", a point and the offset fraction are turned into start times and
durations — which ADR 0137 requires anyway — what a timeline library has left to do is ease a progress value.
Keeping anime.js for that would have meant relying on an undocumented property (no leftover state within a
pass) for no work it was doing. Without a playhead, the same time gives the same pose by construction.

## Rejected

- **GSAP.** The licence clause.
- **anime.js, one pass per seek.** Worked, on an undocumented property, for nothing timing did not already do.
- **Writing the easing formulas.** About sixty lines of well-known maths; Kodjo's rule is reuse, and this is
  exactly what `d3-ease` is.

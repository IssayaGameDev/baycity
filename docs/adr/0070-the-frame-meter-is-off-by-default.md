# ADR 0070 — The frame meter is off by default

Status: accepted. `stats.js` behind a checkbox on the debug pane, driven from the render loop, measuring last.

## Context

ADR 0069's keycaps tanked the frame rate and there was no way to see it. The only signal was "it feels bad with
them and fine without", which is enough to know something is wrong and not enough to know what — a flat 40 ms
is a budget problem and one 40 ms spike in a run of 8 ms is a hitch, and they need different fixes.

## Decision

**`stats.js`, on the debug pane, off until asked for.**

- **In `@mp/tps`'s pane**, not in a game. An FPS counter is not a game feature, and all three shipped games have
  the same pane. It sits beside `sunShadows` and the rest of the dev tooling.
- **A graph rather than a number on the pane.** What matters when a frame is slow is the *shape*; Tweakpane
  would show the same number for a steady budget overrun and for a hitch.
- **Off by default, and off means off.** One boolean per frame, no DOM writes. An always-on overlay is one more
  thing between Kodjo and the game, and it costs work whether anybody is reading it or not.
- **`DebugPane.frame()`**, called by the client's render loop **after everything else that frame** — the game's
  own `onFrame` hooks included, which is the whole point: the keycap presses and the rope drawing have to be
  inside the number.
- Positioned under the pane rather than at `stats.js`'s own top-left, which belongs to the pause button
  (ADR 0015), and above the Pixi overlay's z-index or the UI canvas covers it.

## Consequences

- One new dependency, `stats.js`, in `@mp/tps`. Kodjo named it.
- `DebugPane` gained the one member here that must be **called** rather than bound.
- It paid for itself immediately: the numbers in ADR 0069 are what it was built to make visible.

## Rejected

**A number bound on the pane.** Cannot distinguish a budget problem from a hitch.

**On by default.** Screen space and per-frame cost for something wanted a few times a session.

**In `modes/keyboard`.** Would have worked with no platform change at all — the game can add a pane folder
(ADR 0067) — and would have left parkour and swing blind for no reason.

## Known open

- Frames only. Draw calls, triangles and texture memory are all in `renderer.info` and none of it is shown;
  ADR 0069's diagnosis was arithmetic on paper rather than read off the screen.
- Nothing records a session, so a hitch has to be caught live.

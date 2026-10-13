# Known open

What the game lacks or has unresolved, in one place. Each item names the doc or ADR that owns the detail.

## Missing features

- **The click sound.** No audio system exists anywhere in the stack. The biggest feedback gap (ADR 0069).
- **Speed picker.** The real game lets you run below Max Speed. Only a debug stand-in exists ([debug.md](debug.md)).
- **A climb penalty.** Slopes cost and grant no speed (ADR 0127). Kodjo wants going uphill to slow you
  eventually; it is not built, and it would need every built stage re-checked against its speed gate.
- **Treadmill lock/unlock.** Every placed treadmill is usable (ADR 0080).
- **Rebirth, trails, auras, more worlds.** Not started.
- **Active-pad highlight beyond material.** Only the material swap exists (ADR 0082).

## Unresolved

- **Step cadence data.** The curve is fitted to eight rough readings; a screen recording would tighten it
  ([steps.md](steps.md), ADR 0081).
- **Feet float at long strides** past `runSpeed` (the cadence cap, ADR 0079). Key detection no longer depends
  on them; the look is Kodjo's to judge.
- **Slopes past the authored curve.** Footing holds across 10°–45° up to 58.8 m/s (Level 100), and two cells
  at that top speed still blip 0.2–0.7 m. Beyond it a step is metres long and the capsule tunnels through a
  hill — the tick, not the slope (ADR 0127, ADR 0104). Only reachable above Level 100.
- **Saves reset per share link** — the origin changes each run (ADR 0074). Real hosting is the fix.
- **Signs are built once**; a pad edited live keeps its old sign until reload (ADR 0082).
- **The editor does not render keycaps**; a board is a plain box there (ADR 0069).
- **Paste across games** is unchecked in the editor (ADR 0076/0077).
- **`StageGate` still ships**, until the box's levels have swapped theirs for an `Obstacle` and that content is merged;
  then it goes (ADR 0211, [obstacles.md](obstacles.md)).
- **An Obstacle has no landing marker in the editor**; a StageGate's facing gizmo is drawn on its own node, and an
  Obstacle lands on its `teleport` target ([obstacles.md](obstacles.md)).
- **A checkpoint reached while the teleport window is open** stays greyed until the window is opened again: the rows
  are read as it opens.

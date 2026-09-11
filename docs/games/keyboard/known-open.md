# Known open

What the game lacks or has unresolved, in one place. Each item names the doc or ADR that owns the detail.

## Missing features

- **The click sound.** No audio system exists anywhere in the stack. The biggest feedback gap (ADR 0069).
- **Speed picker.** The real game lets you run below Max Speed. Only a debug stand-in exists ([debug.md](debug.md)).
- **Treadmill lock/unlock.** Every placed treadmill is usable (ADR 0080).
- **Rebirth, trails, auras, more worlds.** Not started.
- **Run-in-place on the treadmill.** The character stands still on it (ADR 0080).
- **Active-pad highlight beyond material.** Only the material swap exists (ADR 0082).

## Unresolved

- **Step cadence data.** The curve is fitted to eight rough readings; a screen recording would tighten it
  ([steps.md](steps.md), ADR 0081).
- **Feet float at long strides** past `runSpeed` (the cadence cap, ADR 0079). Key detection no longer depends
  on them; the look is Kodjo's to judge.
- **Boards past z = 40** exceed the wire's `QUANT_BOUND` (ADR 0011): peers there are clamped.
- **Saves reset per share link** — the origin changes each run (ADR 0074). Real hosting is the fix.
- **Signs are built once**; a pad edited live keeps its old sign until reload (ADR 0082).
- **The editor does not render keycaps**; a board is a plain box there (ADR 0069).
- **Paste across games** is unchecked in the editor (ADR 0076/0077).

# ADR 0187 — The debug Level slider

Status: accepted. Amends ADR 0075 (the Progression folder). Kodjo's call.

## Context

The Progression folder reached a Level by an XP grant: type an amount, press **Add experience**. What is
wanted is a Level, and the XP behind one grows 1.15× a Level, so the amount had to be worked out each time.

## Decision

The grant is replaced by a `level` slider, 0–500: Experience is set to exactly where that Level starts, saved
when the slider is let go. It follows the Level as it is earned, and a value that already matches changes
nothing, so its own refresh never resets progress within a Level. The Wins grant stays.

0–500: the Level cost curve's own hint names Level 500, where one Level already costs about 2·10³² XP on the
default curve.

## Rejected

- **A number field.** Asked for as a slider.

# ADR 0142 — A board has a key budget

Status: accepted. Adds a limit to ADR 0069's generated caps and ADR 0120's preview of them; the grid rule of
ADR 0118 is unchanged under the limit.

## Context

A collaborator typed a platform's scale as 800 000 m (a missing decimal comma) on a node carrying a
`Keyboard`. One cap per cell at the game's 1 m pitch is tens of millions of caps. Every browser that opened the
level froze building them — the editor's cell preview and the game alike — and the editor reopens the last
level (ADR 0109), so reloading froze it again. Fixed on the box by hand; nothing stopped it recurring.

Largest boards in content when this was written: ~8 300 caps on one board, ~22 000 across the busiest level,
which runs.

## Decision

**A board over `keyBudget` caps gets no caps at all**, checked in `boardGrid` — the one rule both `boardOf`
(the game) and `keyboardGridOf` (the editor's preview) count cells with. `keyBudget` is a game setting
beside `keyPitch` (ADR 0115), default 20 000, range 1 000–100 000, so it can be raised from the Game row
without a deploy. A `NaN` or infinite size is refused by the same check.

Kodjo chose the budget over a scale cap; the number is a recommendation he accepted without a measurement
behind it.

## Rejected

- **Capping scale in the editor.** Existing levels hold 8 000 m nodes, so the cap must sit above that, and an
  8 000 × 8 000 board is still 64 million caps. Limits the input, not the cost.
- **Tiling the first `keyBudget` caps.** A half-tiled platform looks like a bug somewhere else; a bare one says
  the board is the problem.
- **A budget per level.** Not what froze, and it makes one board's keys depend on every other board.

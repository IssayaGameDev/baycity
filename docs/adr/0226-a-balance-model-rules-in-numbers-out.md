# ADR 0226 — A balance model: rules in, numbers out

Status: accepted. Builds on the Balance tab (ADR 0225); Kodjo's model of World 1, worked out with him.

## Context

Kodjo's balance came down to about ten choices — a 45-minute World 1 of 15 stages up to Level 95, World 2 at
Level 100, Level 100 at 200 speed, each Level 12.5 % dearer, stages paying ×2, pads ×2 every two stages, a rebirth ×2
every four, one payout of grind — but the game stores the result as some fifty raw values in Settings and the World's
rows. Trying one model meant typing all fifty.

## Decision

- **The rules are settings** (`MODEL_RULES`, `balanceModel.ts`), saved in `game.json` under their keys and shown in the
  Balance tab, not Settings. `BalanceDecl.rules` and `apply`.
- **Apply writes every number they make**: the Max Speed, Level cost and rebirth curves and the pad table, and the open
  level's World stage rows — their Level, Wins and target; each row's obstacle and run are kept, rows added to the
  count. One turn, so one Ctrl+Z. Refused, and said why: no World open, rows past the count holding an obstacle,
  rules that cannot be (the last Level under the stage count, the next world before the last stage).
- **One number is simulated, the rest are rules**: the Level cost's start, so the next world opens at the world's
  length on the Balance tab's own player. A pad's price is what that player holds on its stage's first clear plus the
  grind's payouts (Kodjo's call: a small grind), rounded up to two figures.
- **Even steps within a kind** (Kodjo's call, over fitting each reward on its own): one growth for pads, one for
  rebirths. Fitted freely, the rewards came out lopsided (×13 next to ×1.07).
- **A stage's target is its speed first there** (Kodjo's pace: "enough speed to clear it"), not its first clear,
  which comes a run later: the simulator records `reachedAt`, the report uses it.
- **A rebirth waits for what is passable**: the simulated player rebirths once the Level allows and the next stage is
  out of reach, so a rebirth at a stage's Level comes after that stage's clear.

## Rejected

- **Pasting rows**: smaller, but every model a new paste and the curves still by hand.
- **Trails in the model**: the game has none; simulating them would show a game that cannot be played.
- **A rebirth tied to its pad's unlock**: the grind delayed the rebirth and moved every stage after it.

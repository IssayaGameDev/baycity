# The balance model

`modes/keyboard/src/balanceModel.ts` (ADR 0226, Kodjo's model of World 1). A few rules in, every balance number out:
the Balance tab's **Model** section shows the rules, **Apply** writes what they make ([balance.md](balance.md),
`platform/editor.md`).

## Rules (`MODEL_RULES`, settings in `game.json`)

| Key | Rule | Default |
| --- | --- | --- |
| `modelMinutes` | World length, min: from the start until the next world opens | 45 |
| `modelStages` | Stages | 15 |
| `modelLastLevel` | Last stage's Level | 95 |
| `modelNextLevel` | Next world opens at Level | 100 |
| `modelSpeed0`, `modelSpeed100` | Speed at Level 0, at Level 100 | 10, 200 |
| `modelCostGrowth` | Each Level costs more, % | 12.5 |
| `modelFirstWins`, `modelWinsGrowth` | Stage 1 pays; each stage × the last | 1, ×2 |
| `modelPads`, `modelPadEvery`, `modelPadGrowth` | Step pads (the first free); a new one every n stages; each × the last | 8, 2, ×2 |
| `modelGrind` | Payouts of its stage a pad waits for after the stage's first clear | 1 |
| `modelRebirthEvery`, `modelRebirthGrowth` | A rebirth every n stages; each × the last | 4, ×2 |

## What they make (`generateModel(rules, player, settings, worldParams)`)

| Out | From |
| --- | --- |
| stage k's Level | `round(last × k ÷ stages)` |
| stage k's Wins | `first × growth^(k−1)`, whole |
| stage k's target, min | `a × k(k+1)/2`, `a = minutes ÷ (n(n+1)/2 + (n+1) × (next − last) ÷ (last ÷ n))`: each wait a step longer, the gap to the next world at the last stage's pace; 0.1 min |
| Max Speed | `{0: speed0}, {100: speed100}` |
| rebirth n | stage `every × n`'s Level, `growth^n` — the curves' points; none inside the world: the curves left as they are |
| pad tier k (0 free) | `growth^k` XP a step; unlocks with stage `every × k`'s first clear: its price the Wins held then plus `grind ×` the stage's Wins, rounded up to two figures |
| Level cost | `{0: c0}, {100: c0 × (1 + growth%)^100}`; `c0` bisected (24 steps) so the next world opens at `minutes` |

The run is `simulate` (`balance.ts`): the stages with each row's own run, floor and fail, the World's base XP and
speed, the cadence as set, the Balance tab's player, and the next world as a one-stage world at `next` to time its
opening. Each pad's price is found in turn, the later ones held off (`Infinity`). About a second.

Refused (`{ refused }`): no World in the open level; rows past `stages` holding an obstacle; `last < stages`;
`next ≤ last`; a pad's stage never reached; no Level cost bringing the next world in. Said with the result: World 2's
Level to enter (another level, not written); a World listing a different number of pads; pads that do not fit.

## Apply (`KEYBOARD_BALANCE.apply`)

`settings`: `speed`, `levelCost`, `rebirthLevel`, `rebirthMultiplier`, `pads`. `component`: `World`, `{ stages }` —
each row as stored (its obstacle, run, floor, fail) with the model's `level`, `wins`, `target`; rows added to the count.
Step cadence, trails (not in the game) and other worlds are not written.

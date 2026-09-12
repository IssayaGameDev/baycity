# Balance: the three curves and the simulator

The loop's shape is three **designed curves** (ADR 0088), not formula parameters: control points Kodjo places
in the editor's Game row, stored in `content/games/keyboard.json` → `settings`, read at load
(`GAME_CURVE = curveFrom(game.settings)`, `rules.ts`). A change is a save, not a deploy; the staging game and the
mirror pick it up like a level edit. A curve the file lacks is its default, so the file may hold none.

| Curve | Key | x → y | Between points | Past the last | Axis | Default |
| --- | --- | --- | --- | --- | --- | --- |
| Level cost | `levelCost` | Level → XP to the next Level | constant ratio | extends | log | 100 at L0, ×1.15 per Level (`{0: 100}, {100: 117.4M}`) — Kodjo's Level 45 save |
| Max Speed | `speed` | Level → studs/s | linear | extends | linear | `{0: 10}, {100: 210}` — two readings |
| Step cadence | `cadence` | Level → steps/min | linear | holds | linear | `{0: 240}, {20: 240}, {30: 270}, {50: 420}, {85: 540}, {170: 600}` — Kodjo's eight readings |

Declared in `progression.ts` (`CURVE_SETTINGS`); the curve math is `@mp/mode`'s `sampleCurve` (`platform/mode.md`).
`experienceForLevel` is the running sum of `levelCost` (memoised per point array), `levelAt` a binary search over
it. Constants that are not balance: `METRES_PER_STUD = 0.28`, `BASE_PER_STEP = 1`. Per step:
`1 × stepPad × treadmill × world × rebirth × trail × aura × item` ([world-1.md](world-1.md)).

Pad tiers and Wins payouts are node parameters, not settings: `StepPad` ([pads.md](pads.md)), `WinsPad` with its
`stage` number ([stages-and-wins.md](stages-and-wins.md)).

## The curve editor (`tools/editor/src/curveEditor.ts`)

One graph per curve under the Game row. Drag a point; click empty space to add one; double-click or Delete to
remove (never the last). Fields for the selected point; **default** puts the declared curve back; ↶ ↷ or
Ctrl+Z/Y undo within the graph. Wheel zooms around the cursor (an axis alone over that axis), right-drag pans,
**fit** reframes, **⤢** opens the graph large over the viewport. Log axis for
`levelCost`: an exponential is a straight line, and the readout gives the ratio per Level of the last segment.
The right edge of the graph shows the extension, so what Level 300 costs is visible.

## The simulator — `balance.ts`

```ts
simulate({ curve, scenario, horizonS, hold?, dt? }, everyS = 60): SimResult
Scenario { worlds: [{ name, levelRequired, xpMultiplier, speedMultiplier, stages: [{ stage, speed, wins }] }],
           pads: [{ perStep, requiresWins }], rebirths: [{ levelRequired, multiplier }],
           trails: [{ name, wins, multiplier }], auras: [...], clearSeconds, fastClearSeconds }
SimResult { levelAt: number[] /* current run */; stageOpenAt: Map<'World/stage', s>; events: [{ t, what }]; samples; final }
```

The model, from [world-1.md](world-1.md): a **stage is a speed gate** — passable at `speed`, pays `wins` per
clear, `clearTime` = `clearSeconds` at the gate falling to `fastClearSeconds` at twice it. The player holds a
direction `hold` of the time, runs the furthest passable stage of the current world, takes pads by threshold
(and keeps them when Wins are spent), buys the best affordable trail and aura, rebirths the moment the Level
allows (XP and Level reset, multiplier replaces), and moves to the highest open world that has stages. Uses the
game's own `levelAt`, `maxSpeedAt`, `stepsPerMinute`. A **ceiling**: no idling, no deaths. For comparing curves,
not predicting a clock.

Scenario data: `modes/keyboard/balance.world1.json` — World 1's 14 gates and payouts, the eight pads, the two
rebirths, 15 trails and 5 auras interpolated between the ends Kodjo gave, Worlds 2 and 3 as openings with no
stages yet. `balance.test.ts` asserts it matches the table in [world-1.md](world-1.md).

```sh
pnpm --filter @mode/keyboard run balance -- --hours 3 --every 900 --hold 0.85
```

| Option | Default | |
| --- | --- | --- |
| `--hours` | 2 | horizon |
| `--every` | 300 | seconds between timeline rows |
| `--hold` | 1 | fraction of time moving |
| `--scenario` | `balance.world1.json` | |
| `--content` | `content/` | `.content-live` for the mirror's curves |

Report: the curves in one line, Level milestones of the current run, every event (stage opened, pad taken,
purchase, rebirth, world), a timeline.

## What the defaults say (3 h, hold 100%)

Rebirth 1 at 2m45 (Level 10), rebirth 2 at 6m59 (Level 50); stage 14 passable at 7m19; the +500 pad at 7m58;
trail 7 (×780) at 19 min; World 2 open at 26 min. A ceiling, on defaults fitted from thin data — the thing the
editor exists to change.

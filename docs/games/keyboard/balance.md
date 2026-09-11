# Balance: the settings and the simulator

Every number in the loop is a **game setting** (ADR 0087): declared in `progression.ts` (`CURVE_SETTINGS`),
edited in the editor's Game row → *Game settings*, stored in `content/games/keyboard.json` → `settings`, read by
the game at load (`GAME_CURVE = curveFrom(game.settings)`, `rules.ts`). A change is a save, not a deploy; the
staging game and the mirror pick it up like any level edit. A key the file lacks is its default, so the file
may hold none.

| Setting | Key | Default | Meaning |
| --- | --- | --- | --- |
| XP per step | `perKey` | 1 | before any `StepPad` |
| Level 1 costs | `firstLevel` | 100 | XP |
| level cost × | `levelGrowth` | 1.15 | each level costs this times the last |
| speed at L0 | `baseMaxSpeed` | 10 | studs/s |
| speed per level | `maxSpeedPerLevel` | 2 | studs/s |
| metres per stud | `metresPerStud` | 0.28 | |
| cadence floor | `stepsFloor` | 240 | steps/min at low levels |
| cadence cap | `stepsCap` | 600 | steps/min at high levels |
| cadence ramp | `stepsRamp` | 819 | `cap − ramp·e^(−level/τ)`, floored |
| cadence τ | `stepsTau` | 33 | levels |

Defaults are what the real game was measured at ([progression.md](progression.md), [steps.md](steps.md)); the
data is far from complete. Pad tiers and Wins payouts are not settings: they are `StepPad` and `WinsPad`
parameters on the nodes ([pads.md](pads.md), [stages-and-wins.md](stages-and-wins.md)).

## The simulator — `balance.ts`

```ts
simulate({ curve, stages: [{ lengthStuds, wins }], pads: [{ perStep, requiresWins }], horizonS, hold?, start?, dt? }, everyS = 60): SimResult
SimResult { levelAt: number[] /* s, index = level */; padAt: (number | null)[]; stageAt: number[]; samples: SimSample[]; final }
perStepFor(wins, pads, base)          // the StepPad rule
formatReport(input, result): string   // milestones, pads, stages, a minute-by-minute table
```

One imagined player holding a direction `hold` of the time, running each stage (cycled) at Max Speed for
`lengthStuds`, taking the best pad Wins allow the moment they allow it. Uses the game's own `levelAt`,
`maxSpeedAt`, `stepsPerMinute`. No falling, treadmills or jumping: a **ceiling** on progress. Time is counted in
steps (`t = step · dt`) so samples land on round minutes.

```sh
pnpm --filter @mode/keyboard run balance -- --minutes 60 --stage 300:1 --stage 450:2 --hold 0.85
```

| Option | Default | |
| --- | --- | --- |
| `--minutes` | 60 | horizon |
| `--stage L:W` | straight line spawn → first `WinsPad` of the level, its `wins` | repeatable; a floor on the real path |
| `--hold` | 1 | fraction of time moving |
| `--start XP:WINS` | `0:0` | |
| `--level` | `keyboard` | which level's `StepPad`s and default stage |
| `--content` | `content/` | `.content-live` for the mirror |

Pads come from the level's `StepPad` nodes (sorted by `requiresWins`), the curve from `games/keyboard.json`.

## Reading it (defaults, 78-stud straight-line stage, one hour)

Level 10 at 2m38, Level 20 at 5m55, Level 40 at 21m, Level 44 at 30m; the ×25 pad at 5 min, ×50 at 14 min,
×100 not within the hour; ~50 stages a minute at the end. Cadence never leaves the floor before Level 30. The
stage length dominates the first ten minutes: give the CLI the lengths you build.

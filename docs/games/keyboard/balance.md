# Balance: the three curves and the simulator

The loop's shape is three **designed curves** (ADR 0088), not formula parameters: control points Kodjo places
in the editor's games window (Settings), stored in `content/keyboard/game.json` → `settings`, read at load
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

The **pad table** is a game setting too (`PAD_SETTINGS.pads`, a table: XP per step and Wins needed a tier, ADR 0222). A
world's own numbers — its base XP per step, speed multiplier, Level to enter, and its stages (Level, Wins, run time,
floor, fail %) — are its level's `World` component ([world.md](world.md)); the simulator reads them (below). So are the
targets the Balance tab sets the run against (below): a stage's and the world's on the World, the rebirths' a game
setting, `REBIRTH_TARGETS.rebirthTargets` (a table, row n rebirth n, minutes; `balanceReport.ts`), after the curves.

## The curve editor (`tools/editor/src/curveEditor.ts`)

One graph per curve in the games window's Settings. Drag a point; click empty space to add one; double-click or
Delete to remove (never the last). Fields for the selected point; **default** puts the declared curve back; each
change is one step of the editor's undo (Ctrl+Z). Wheel zooms around the cursor (an axis alone over that axis), right-drag pans,
**fit** reframes, **⤢** opens the graph large. Log axis for
`levelCost`: an exponential is a straight line, and the readout gives the ratio per Level of the last segment.
The right edge of the graph shows the extension, so what Level 300 costs is visible.

## The simulator — `balance.ts` (ADR 0223)

```ts
simulate({ curve, pads, worlds, horizonS, hold?, failCost?, overheadSeconds?, dt?, until? }, everyS = 60): SimResult
SimWorld { name; baseXp; speedMultiplier; levelToEnter; padTiers; stages: SimStage[] }
SimStage { level; wins; runSeconds; floorSeconds; failChance }        // a World's stage row, fail % as a fraction
Milestones { clearedAt, reachedAt /* its speed first there */, winsAtClear: Map<'world/stage', s | Wins>; rebirthAt: s[]; enteredAt: Map<world, s> /* the first at 0 */ }
SimResult extends Milestones { levelAt: number[] /* current run */; events: [{ t, what }]; samples; final }
until(m: Milestones) => boolean  // asked after every run: true stops before the horizon (ADR 0225)
gateSpeed(stage, world, curve)   // maxSpeedAt(stage.level) × world.speedMultiplier
runSeconds(stage, gate, speed)   // floor + (run − floor) × min(1, gate ÷ speed)
clearSeconds(stage, gate, speed, failCost, overhead)   // run + overhead + p÷(1−p) × (failCost × run + overhead), p ≤ 95 %
padFor(wins, pads, tiers)        // the best of a world's first `tiers` pads the Wins reach, else 1
```

It reads only what the designer sets: the curves and the pad table (`game.json` `settings`), and each world's level's
`World` ([world.md](world.md); `balanceWorlds.ts`: `worldReadOf` — the `SimWorld` and its targets, `simWorldOf`,
`defaultSimWorld`, `distinctWorlds` — one world a Level to enter, a copy left out and said). The player, every 0.25 s:

- **earns** `cadence ÷ 60 × hold × pad × world base XP × rebirth` — wherever it is, while a direction is held;
- **pushes** the next stage of its world when its speed passes that stage's gate — clearing it pays its Wins and
  reaches the one after; otherwise **farms the reached, passable stage paying the most Wins a minute** (Kodjo's call);
- every clear and every failed run costs `overheadSeconds` back from the spawn; a failed run `failCost` of a run;
- takes pads by threshold, kept; **rebirths** between runs once `rebirthLevelAt` allows and the next stage is out of
  reach — what it can push it pushes first (ADR 0226); enters the **next world**
  by `levelToEnter` once it has stages, starting it from stage 1.

Only what the game has (no trails or auras). A sharp player — the times are a floor on a real one's. For comparing one
set of numbers against another. `balance.test.ts` holds a new World's stages to [world-1.md](world-1.md)'s table.

```sh
pnpm --filter @mode/keyboard run balance -- --hours 3 --every 900 --hold 0.85
```

| Option | Default | |
| --- | --- | --- |
| `--hours` | 2 | horizon |
| `--every` | 300 | seconds between timeline rows |
| `--hold` | 1 | fraction of time moving |
| `--fail-cost` | 0.5 | what a failed run costs, as a fraction of a run |
| `--overhead` | 3 | seconds back to a stage after a clear or a fall |
| `--level` | every level with a World | a level to read; repeat for several. Two opening at the same Level: the first, the other named |
| `--content` | `content/` | `.content-live` for the mirror's |

With no World in any level, a World's defaults (the design stages). Report: the curves, rebirths and pads in two lines,
the worlds, the player's assumptions; Level milestones of the current run; each world's stages with their gate speed
and first clear; every event (a stage cleared, a switch of stage farmed, a pad, a rebirth, a world); a timeline.

## The Balance tab — `balanceReport.ts` (ADR 0225)

`KEYBOARD_BALANCE` is the descriptor's `balance` (`platform/mode.md`); the games window draws it (`platform/editor.md`).
`balanceReport({ settings, levels, options })`: every level's World (`worldReadOf`, by name, `distinctWorlds`), in the
order they are entered; none → a World's defaults, said. `simulate` until every stage is cleared and every rebirth with
a target has come, at most `HORIZON_S` (24 h; past it, said). Groups: a world each — `entered (Level N)` from the
second, then `stage k` — its speed first there (`reachedAt`, ADR 0226) — then `Rebirths`, `rebirth n (Level L)`, as
many as have targets or as came. Each moment's target and simulated time in seconds, `null` for none. Its model — the
rules and Apply — is [balance-model.md](balance-model.md).

| Option (`PLAYER_OPTIONS`) | Default | `simulate`'s |
| --- | --- | --- |
| `hold` — Time moving, % | 100 | `hold` ÷ 100 |
| `failCost` — Lost on a fall, % of a run | 50 | `failCost` ÷ 100 |
| `overhead` — Walk back, seconds | 3 | `overheadSeconds` |

## What the defaults say (3 h, hold 100%)

On the World's defaults: stage 1 cleared at 48 s, rebirth 1 at 4 min (Level 11), stage 13 at 12 min, rebirth 2 at
13 min, all 14 stages at 15m27, then Level ~90 at 3 h with nowhere further to go. A floor on a real player's times.

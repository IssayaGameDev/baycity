# Progression

`modes/keyboard/src/progression.ts`. Three values; only one is a speed (ADR 0071).

| | Meaning | Where |
| --- | --- | --- |
| **Experience** | The currency. `XP` on screen. Earned per step (see [steps.md](steps.md)). | `let experience` in `main.ts`, saved |
| **Level** | Derived from Experience by the curve. Never bought. | `levelAt(experience, curve)` |
| **Max Speed** | `baseMaxSpeed + maxSpeedPerLevel × level`, studs/s. The velocity. | `maxSpeedAt`, `maxSpeedMps` |

## The curves

Three designed curves (ADR 0088, [balance.md](balance.md)), edited in the editor's Game row and stored in
`content/games/keyboard.json`; `DEFAULT_CURVE` = the declared defaults, `GAME_CURVE` (`rules.ts`) = the file over them.

```ts
interface ProgressCurve { levelCost: CurvePoint[]; speed: CurvePoint[]; cadence: CurvePoint[] }
levelCostAt(level)          // XP from level to level + 1 — sampleCurve(levelCost, ratio, extend)
experienceForLevel(level)   // running sum of levelCostAt, memoised per point array
levelAt(experience)         // binary search over that sum → { level, into, next }
maxSpeedAt(level)           // sampleCurve(speed, linear, extend), studs/s
stepsPerMinute(level)       // sampleCurve(cadence, linear, hold)
METRES_PER_STUD = 0.28; BASE_PER_STEP = 1
```

- Defaults reproduce the fits that came before: Kodjo's real save, 345.51K at Level 45 with 33.84K / 46.85K to
  the next, Max Speed 100 at 45, 102 at 46 (`progression.test.ts`, loose tolerances — a fit, not a
  reverse-engineering); cadence from his eight readings.
- Level 1 = 12 studs/s ≈ 3.36 m/s. Level 52 = 114 studs/s ≈ 31.9 m/s. On defaults.

## Speed applied

Each frame `main.ts` writes `client.tuning.moveSpeed = speedStuds × METRES_PER_STUD`, where `speedStuds` is Max
Speed for the Level unless the debug speed pick is on (then `min(pick, max)`). `client.tuning` is the live
object the controller reads; the descriptor's `tuning` is only the starting copy (ADR 0071 correction).
`groundAccelTime`, `groundStopTime`, `airControl` are deliberately not scaled; the caps that keep a fast
character sane are `groundMaxAccel: 150`, `airMaxAccel: 40` (ADR 0078).

## Saves

`localStorage`, this game's own keys, written every 3 s and on the debug resets/grants:

| Key | Value |
| --- | --- |
| `keyboard.experience` | floored integer |
| `keyboard.wins` | floored integer |
| `keyboard.perStep` | the `StepPad` value last taken; fallback `BASE_PER_STEP` |

Nothing goes through the platform's `PlayerProgress` (`ModeSession.progress()` is always `-1`). Note the origin
changes with every `pnpm share` link, so saves reset per link (ADR 0074).

## Display

`abbreviate(n)`: `K`/`M`/`B`/`T`/`Qa`/`Qi`/`Sx`/`Sp`/`Oc`/`No`/`Dc`, two decimals under 100, one above; used by the HUD and the signs.

# Progression

`modes/keyboard/src/progression.ts`. Three values; only one is a speed (ADR 0071).

| | Meaning | Where |
| --- | --- | --- |
| **Experience** | The currency. `XP` on screen. Earned per step (see [steps.md](steps.md)). | `let experience` in `main.ts`, saved |
| **Level** | Derived from Experience by the curve. Never bought. | `levelAt(experience, curve)` |
| **Max Speed** | `baseMaxSpeed + maxSpeedPerLevel × level`, studs/s. The velocity. | `maxSpeedAt`, `maxSpeedMps` |

## The curve

Every field is a **game setting** edited in the editor and stored in `content/games/keyboard.json` (ADR 0087,
[balance.md](balance.md)); `DEFAULT_CURVE` = the declared defaults, `GAME_CURVE` (`rules.ts`) = the file over them.

```ts
interface ProgressCurve {
  perKey: number          // 1  — Experience per step before multipliers
  firstLevel: number      // 100 — what level 1 costs
  levelGrowth: number     // 1.15 — each level costs this times the last
  baseMaxSpeed: number    // 10 studs/s
  maxSpeedPerLevel: number// 2 studs/s per level
  metresPerStud: number   // 0.28
  stepsFloor, stepsCap, stepsRamp, stepsTau  // cadence — see steps.md
}
```

- `experienceForLevel(level)`: closed-form geometric sum. `levelAt(experience)`: closed-form log inverse,
  nudged by `BOUNDARY_NUDGE = 1e-9` before flooring (an exact boundary read 3.9999999 → 3). Returns
  `{ level, into, next }` for the bar.
- Fitted to Kodjo's real save: 345.51K at Level 45 with 33.84K / 46.85K to the next; Max Speed 100 at 45, 102 at
  46. `progression.test.ts` asserts it with loose tolerances (a fit, not a reverse-engineering).
- Level 1 = 12 studs/s ≈ 3.36 m/s. Level 52 = 114 studs/s ≈ 31.9 m/s.

## Speed applied

Each frame `main.ts` writes `client.tuning.moveSpeed = speedStuds × metresPerStud`, where `speedStuds` is Max
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
| `keyboard.perStep` | the `StepPad` value last taken; fallback `perKey` |

Nothing goes through the platform's `PlayerProgress` (`ModeSession.progress()` is always `-1`). Note the origin
changes with every `pnpm share` link, so saves reset per link (ADR 0074).

## Display

`abbreviate(n)`: `K`/`M`/`B`/`T` with two decimals; used by the HUD and the signs.

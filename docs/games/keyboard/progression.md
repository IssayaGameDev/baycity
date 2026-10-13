# Progression

`modes/keyboard/src/progression.ts`. Three values; only one is a speed (ADR 0071).

| | Meaning | Where |
| --- | --- | --- |
| **Experience** | The currency. `XP` on screen. Earned per step (see [steps.md](steps.md)). | `let experience` in `main.ts`, saved |
| **Level** | Derived from Experience by the curve. Never bought. | `levelAt(experience, curve)` |
| **Max Speed** | `baseMaxSpeed + maxSpeedPerLevel × level`, studs/s. The velocity. | `maxSpeedAt`, `maxSpeedMps` |

## The curves

Three designed curves (ADR 0088, [balance.md](balance.md)), edited in the editor's games window (Settings) and stored in
`content/keyboard/game.json`; `DEFAULT_CURVE` = the declared defaults, `GAME_CURVE` (`rules.ts`) = the file over them.

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
`groundAccelTime`, `groundStopTime`, `airControl` are deliberately not scaled. What keeps a fast character
sane is `groundBrakeMaxAccel` and `airMaxAccel`, quoted at `ACCEL_REF_SPEED` and growing with `√speed` from
there, with `groundMaxAccel` left at `Infinity` so a start stays instant (ADR 0078/0096). Values in
`src/editorMode.ts`. A *fixed* ceiling cannot work across this curve: Level 500 is 283 m/s, where a fixed 60
would take 4.7 s and 667 m to stop.

`airDrag` (0.5) is the same idea for the air and for the same reason: a fraction of speed per second means one
number holds from 2.8 to 283 m/s, where an m/s² brake would be 7 cm of effect at the bottom and hundreds of
metres at the top (ADR 0107). Measured reach cost is −1.6 % holding the stick, −16.2 % coasting, at every speed.

## Saves

Through the adapter only (`CLAUDE.md`): `save.ts` — `KeyboardSave { experience, wins, perStep, reached }`,
`localKeyboardSave(): PersistenceAdapter<KeyboardSave>` (`@mp/game-client`). `main.ts` loads it once and `persist()`s
all of it every 3 s, on a `StepPad` taken, on a checkpoint reached, and on the debug resets, `level` and Wins grant. A value that is missing,
unreadable or below its minimum loads as its default. Local storage, this game's own keys:

| Key | Value |
| --- | --- |
| `keyboard.experience` | floored integer |
| `keyboard.wins` | floored integer |
| `keyboard.perStep` | the `StepPad` value last taken; fallback `BASE_PER_STEP` |
| `keyboard.reached` | JSON `{ [levelName]: CheckpointStop.key[] }` — checkpoints reached ([obstacles.md](obstacles.md)); `withReached` adds one; a level whose value is not a list of strings is dropped |

Nothing goes through the platform's `PlayerProgress` (`ModeSession.progress()` is always `-1`). Note the origin
changes with every `pnpm share` link, so saves reset per link (ADR 0074).

## Display

`abbreviate(n)`: `K`/`M`/`B`/`T`/`Qa`/`Qi`/`Sx`/`Sp`/`Oc`/`No`/`Dc`, two decimals under 100, one above; used by the HUD and the signs.

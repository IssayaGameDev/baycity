# Steps

`modes/keyboard/src/steps.ts`. A step is **a tick of held movement input**, nothing else (ADR 0081 and its
amendments). Not a key struck, not a footfall, not a distance, not the ground: pushing a wall counts, mid-air
counts, standing still with no input does not.

## Cadence

Steps per minute follow **Level**, from Kodjo's table of the real game:

| Level | 10 | 20 | 30 | 50 | 85 | 170 | 200 | 300 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Steps/min | 240 | 240 | 270 | 420 | 540 | 600 | 600 | 600 |

`stepsPerMinute(level)` samples the **cadence curve** (`curve.cadence`, linear between points, held past the
last; ADR 0088, [balance.md](balance.md)), whose default points are that table: `{0: 240}, {20: 240}, {30: 270},
{50: 420}, {85: 540}, {170: 600}`. Kodjo edits it in the editor's Game row. Speed plays no part.
`stepsPerSecond(level, curve)` is that over 60.

## The component

```ts
createStepper({ curve: () => ProgressCurve, level: () => number, onSteps?: (steps: number) => void })
STEPPER_DEF   // unbound, for the registry
stepsThisTick(cmd, level, curve, dt) // = moveX||moveZ ? stepsPerSecond × dt : 0
```

`Stepper` is a player component (`attachesTo: 'player'`, in `KEYBOARD_MODE.player` and `playerDefs`). It runs in
the movement slot (`onLocomote`) with the tick's `InputCommand`, the one place a component sees input
(ADR 0061), and reports fractional steps. The editor's play-test binds it with `level: () => 0` and no sink.

## Paying out

`main.ts` accrues steps per tick and pays whole ones per frame:

- Ground steps pay `perStep` each (see [pads.md](pads.md); default `BASE_PER_STEP` = 1).
- Treadmill steps pay `perStep × multiplier`. A tick spent on a treadmill is a treadmill tick, not also a
  ground tick: the stepper's report for that tick is superseded when the treadmill's contact arrives later in
  the same tick.
- One popup per step from the feet, text `+<value>`, via `createPopups` (ADR 0072; pool of 48, oldest recycled).

Only the local player earns: components receive only the local character's input and contacts.

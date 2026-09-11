# ADR 0081 — A step is a tick of held input

Status: accepted, **amended** (see the end). Corrects ADR 0071 and amends ADR 0080. In `modes/keyboard`,
Experience is earned per **step**, and a step is time spent holding a direction while grounded, at a cadence set
by Level — 240 a minute to about level 20, 600 from about level 170. Keycaps press but pay nothing.

## Context

ADR 0071 paid Experience per keycap struck. That read the game being cloned as "+1 per key you step on", which
is how every guide phrases it. Kodjo suspected otherwise and tested it in the real game, at level 210:

- Facing a wall, holding forward. No key going down. No run animation, the character being blocked. Experience
  climbed anyway, at a steady rate.
- About **40 popups in 10 seconds at speed 10**. Rough, by his own account.
- Holding forward mid-air: nothing.
- First reading: half the speed setting looked like half the popups, which gave a rate proportional to speed —
  one step per 2.5 studs — and that was built. Then, at speed 100, it was plainly not ten times the popups; on a
  closer look the count at 10 and at 100 **seemed the same**. Kodjo's call: fixed.

So the real game does not count keys, or distance, or footfalls, and does not follow speed. It counts **time
holding a direction while grounded**, at a fixed cadence. The keys are the floor it happens on. Neither
observation could be checked against the counter — at 168 trillion Experience a ten-second gain does not show —
so the count of popups is the measurement, and four a second is the number.

## Decision

**Four steps per second, while grounded and a direction is held. Each step pays `perKey`.**

- `stepsPerSecond: 4` on the curve. One number, changeable.
- A **`Stepper` player component** (`steps.ts`) does the counting. It runs in the movement slot with the tick's
  input — the one place a component sees what the player is pressing (ADR 0061) — reads `grounded` off the
  character, and reports fractional steps. The game accrues them and pays whole ones: Experience up by `perKey`,
  one popup per step from the feet.
- **Keycaps pay nothing.** They still press under everyone, by sweep (ADR 0069, ADR 0073's amendments); the
  `hold` still returns what it struck, and nobody reads it for Experience any more.
- **The treadmill is the same rule without the input.** Standing on it earns steps at the same cadence, each
  worth `perKey × multiplier`. Its own `stepLength` parameter is gone; the step is the game's. A tick on a
  treadmill is a treadmill tick, not also a stepper tick, so holding a direction on it does not double up.

Why a component rather than reading input in the game's frame hook: the client does not hand a game the local
`InputCommand`, and it should not have to — the component system already delivers it, per tick, to whatever
the player carries. This is what `attachesTo: 'player'` is for.

## Consequences

- Push a wall on a key and you earn. Run across a board and you earn the same per second as pushing the wall.
  Jump and you stop earning until you land. All as measured in the real game.
- Four steps a second at every level. Speed buys reach and Wins, not Experience per second.
- Peers press keys and earn nothing here, as before; their Experience is theirs.
- The editor's play-test carries the `Stepper` too, with nowhere to report to, so nothing happens there.
- 5 tests: the cadence, the tick's share, none when airborne or idle, the treadmill reporting its multiplier,
  and a treadmill tick not teleporting or paying Wins.

## Rejected

**Per keycap struck** (ADR 0071). Disproved at the wall.

**Per footfall or per metre travelled.** Also disproved at the wall: nothing moved and it paid.

**Proportional to speed** (one step per 2.5 studs). Built first on the half-at-half reading; the count at
speed 100 did not bear it out, and Kodjo chose fixed.

**Reading input in the game's frame hook.** The client does not expose it, and a component already receives it.

## Known open

- The constant is from a rough count of popups, the only instrument available at 168 trillion Experience. It is
  one number.
- The two observations — half at half, and the same at 10 and 100 — do not agree. If the real curve is
  neither flat nor linear, a screen recording at two speeds would show it.

## Amendment — the cadence follows Level

The fixed four a second was measured at one level. The next day Kodjo brought a table from the game being
cloned, level against steps a minute:

| Level | 10 | 20 | 30 | 50 | 85 | 170 | 200 | 300 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Steps/min | 240 | 240 | 270 | 420 | 540 | 600 | 600 | 600 |

Flat at 240 to about level 20, climbing, flat at 600 from about level 170. Not a line: a curve that saturates.
This fits every reading within 1%:

```
steps/min = max(240, 600 − 819 × e^(−level / 33))
```

The floor and the ceiling are read straight off the table. The two curve constants come from the 30, 50 and 85
readings — 330, 180 and 60 short of the ceiling, which fall by the same factor every 33 levels. The earlier
observations (four a second, the same at speed 10 and 100) were all at one level, and agree with the floor.

So `stepsPerMinute(level)` on the curve — `stepsFloor`, `stepsCap`, `stepsRamp`, `stepsTau` — replaces the
fixed `stepsPerSecond`; the `Stepper` reads the player's Level each tick (closed form, ADR 0071) and the
treadmill follows the same cadence. Kodjo's table is the test fixture, the way his save is the XP curve's.

Speed still plays no part. Level does, twice now: it buys Max Speed, and it buys cadence.

## Amendment — the air counts

Kodjo removed the ground check. A step is now a tick of **held direction**, full stop: on the ground, in the
air, against a wall, standing in place. The one earlier reading that said mid-air paid nothing is overridden by
his call; the `Stepper` no longer consults `grounded`.

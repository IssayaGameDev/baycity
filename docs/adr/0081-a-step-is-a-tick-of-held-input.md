# ADR 0081 — A step is a tick of held input

Status: accepted. Corrects ADR 0071 and amends ADR 0080. In `modes/keyboard`, Experience is earned per **step**,
and a step is time spent holding a direction while grounded, at a fixed four a second. Keycaps press but pay
nothing.

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

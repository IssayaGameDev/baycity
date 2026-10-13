# ADR 0215 — Movement is integrated in fixed slices, and a landing is on the floor

Status: accepted. Kodjo: the same jump at a different step size is "wrong calculation"; exact, and his stages
replayed after (option A, twice — the second time with the measured +6 %).

## Context

Step 2 of the tick-rate plan: make movement the same at any step size before moving to 60. Measured at 30, 60 and
120 steps a second with the old code: a standing jump 2.80 / 2.82 / 2.98 m, a Keyboard running jump 48.58 / 48.78 /
48.89 m along at 2.5 s, a 6 m drop 5.33 / 5.18 / 5.18 m high at 0.3 s. Gravity's regime was decided once a tick,
so the switch to the lighter apex came up to a tick late; the distance was the end-of-tick speed; drag was per tick.
At 120 a held jump re-jumped from about 14 cm up: the probe reaches 0.4 m below the soles and called a fall that
ended short of the floor landed — the same hole that gave a gentle drop onto lava a free jump. And running sank up
to 20 cm into flat ground at some rates: the resolve sometimes accepted the settling press whole, and from inside
the floor the next resolve no longer met it.

## Decision

- **Slices of 1/240 s** (`INTEGRATION_HZ`) inside every tick for gravity, the ground's approach, air steering and
  drag; distance is each slice's trapezoid. 240 divides 30, 60 and 120. Arithmetic only: one `move` a tick.
- **A landing has the soles on the floor**: footing returns only on footing already, when the resolve cut the fall
  short, or with the soles within the contact slack (plus the slope's sphere offset) of the probe's plane.
- **The settle press** is a 30 Hz tick's full `v·dt` at every rate, on footing only, **stopped 2 cm below the
  floor plane**; a landing is its own fall, unlimited.
- `stepRate.test.ts` holds 30, 60 and 120 to 6 cm and a landing to one 30 Hz tick.

Measured at 30 Hz, Keyboard, old → new: jump height 2.76 → 2.84 m, running jump 13.77 → 14.64 m at 20 m/s (+6 %:
exactly the tuning's own air time), 1 s from standing 19.13 → 19.00 m.

## Rejected

- **Retuning the jump so 30 feels as before** (option B): the settings would stop meaning what they say.
- **A press of fixed distance, unlimited**: sank 20 cm at 120 steps a second.
- **Pressing exactly to the floor**: each tick started inside the controller's offset and the resolve dropped
  horizontal slices — 13 cm lost over 30 m.
- **The landing rule on every tick**: a resolve's partial step on footing then lost it; down 40° at 58.8 m/s took
  off 48 % of the time.
- **220 Hz**: does not divide 30 or 60.

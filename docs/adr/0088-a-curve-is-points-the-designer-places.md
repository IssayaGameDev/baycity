# ADR 0088 — A curve is points the designer places

Status: accepted. A game setting can be a **curve**: control points on a graph, interpolated linearly or by
constant ratio, held or extended past the last point, edited in a canvas widget in the editor's Game row.
Keyboard's level cost, Max Speed and cadence are three such curves; the formula parameters they replace are
gone. The balance simulator is rebuilt on the game as Kodjo described it: stages are speed gates.

## Context

ADR 0087 exposed the progression as ten numbers — `firstLevel`, `levelGrowth`, a cadence ramp formula. Kodjo:
"not super readable", "a full mathematic formula as one of the settings", "ideally we would like curves", and
the numbers "will almost certainly end up being somewhat exponential" into the quadrillions. The simulator of
ADR 0087 modelled a stage as distance ÷ speed and printed "Level 50 in 30 minutes"; the number was an artefact of
one 78-stud stage paying a Win every seven seconds. Kodjo: a stage is a gate, length is irrelevant.

## Decision

- **`CurveSetting`** on the descriptor: `xLabel`, `yLabel`, `interpolation: 'linear' | 'ratio'`,
  `beyond: 'hold' | 'extend'`, `logY`, `yMin`, `default` points. `sampleCurve` is the one implementation the
  game, the editor and the simulator share. Ratio segments make every segment exponential with a ratio the
  designer chose; extending the last segment means Level 500 costs what the trend says.
- **Log axis for the cost curve.** An exponential is a straight line there; "×1.15 per level" is a slope you can
  see, and the readout names it.
- **Level from a running sum.** `experienceForLevel` sums `levelCost`; memoised per point array (a `WeakMap`),
  binary-searched by `levelAt`. Closed forms went with the formula.
- **Only balance is a setting.** `metresPerStud` is a unit and `perKey` was always 1: both back to constants.
- **The simulator models gates.** `Scenario` = worlds (Level to open, XP ×, speed ×, stages as `speed` and
  `wins`), pads, rebirths, trails, auras, clear times. The player runs the furthest passable stage; clears take
  45 s at the gate down to 5 s past twice it; pads stick; the best affordable trail and aura are bought; rebirth
  on reaching its Level; a world without stages is noted, not entered. World 1's values live in
  `balance.world1.json`, asserted against `docs/games/keyboard/world-1.md` by a test so the two cannot drift.
- **`WinsPad.stage`**, so a level states its sequence.

## Rejected

- Formula parameters with better labels. The shape is the design; a designer bends a line, not a τ.
- A Tweakpane graph plugin. None fits; the widget must draw `sampleCurve`'s exact rules or it lies.
- Spline interpolation. Overshoots, and a ratio segment is what an incremental designer means.

## Consequences

- `docs/games/keyboard/balance.md` owns the curves and the simulator; `progression.md` cites it.
- Every number the simulator prints is a ceiling on defaults fitted from thin data; the ADR records that it
  produced a wrong number once and why.
- Trails and auras in the scenario are placeholders between the two ends Kodjo gave.

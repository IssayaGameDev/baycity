# ADR 0185 — Moving platforms drawn as smoothly as the editor's preview

Status: accepted. Amends ADR 0104 (tick slicing) and ADR 0140 (interpolating by the schedule).

## Context

Sequence-moved platforms jittered in the game, slow ones too, while the editor's Motion preview — a pose at
each frame's own time — was smooth. Measured against that preview with the real loader, sim clock and stepper:

- **Slicing.** `update` moved where `render` blends from on every call, and a sliced tick calls it once per
  slice, so a frame spanned only the last slice and the rest landed as a jump. Slicing is level-wide: one fast
  mover (Kodjo's lava at 75 m/s, three slices) put every moving platform 57 %+ of a frame's step off.
- **The sim clock.** Its reference was read when a tick ran — up to a frame late, different every tick — and
  each correction chased that, so steps came out up to ±5 % uneven: 6 % of a frame's step, at any speed.

## Decision

- `update(nowMs, riding, opensTick)`: only a tick's first slice moves `prev`; later slices move `curr`. `render`
  blends the whole tick.
- `startFixedLoop` tells each tick how long after its due instant it runs (`onTick(dt, index, lateMs)`, from the
  accumulator), and `simClock.tick(lateMs)` compares the reference taken back to that instant.

Both measured at 0 % against the editor's path, at 60 and 144 Hz, steady and jittered frames.

## Rejected

- **Interpolating by time instead of the alpha.** The samples were the problem, not the blend.
- **Low-passing the clock's corrections.** Averages the noise rather than removing its cause.

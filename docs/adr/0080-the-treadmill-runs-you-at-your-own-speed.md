# ADR 0080 — The treadmill runs you at your own speed

Status: accepted, **amended by ADR 0081** — the step is the game's rule (a fixed four a second), not a
treadmill parameter and not a function of speed; `stepLength` is gone and so is the title's premise.
`modes/keyboard` has a `Treadmill` component. Stand on it and Experience accrues at the rate you would earn
holding a direction on the ground, times the treadmill's multiplier.

## Context

The game being cloned has treadmills at spawn: park on one and Speed accrues while you are away from the
keyboard. Five tiers — Chocolate free at ×1, then ×3, ×9, ×25, ×100 for Robux. What none of eleven sources
state, including the game's own store data, is the **rate** at ×1. One guide says outright that the pass
descriptions are empty and no footage reads the values, "so we print none".

Kodjo supplied the missing piece from play: **the treadmill runs you at your own speed.** A faster player takes
more steps a second on it, exactly as they would over real keys. So the rate is not a number to find; it falls
out of numbers the game already has.

## Decision

**Steps per second = Max Speed ÷ step length. Each step pays XP per key × multiplier.**

- Max Speed is the level's velocity in m/s (ADR 0071).
- Step length is a treadmill parameter, defaulting to a key's pitch (0.9 m), so a treadmill step is a key.
- XP per key is the curve's `perKey`, the same thing a real key pays.
- Multiplier is the treadmill's tier; Chocolate is 1. **It multiplies what a step pays, not how often you
  step.** A first build had it on the cadence — a ×9 treadmill produced nine times the steps and nine times the
  popups — and Kodjo corrected it: the treadmill runs you at your speed, and the tier is worth more per step.

At level 1 that is 3.8 steps a second; at level 52, 35. On a ×9 treadmill each of those pays 9.

### Detection is a stay

`onContact` fires every tick the capsule touches a collider on the node — a stay, not an enter. The component
reports through `effects.progress(node)`, the one effect that carries a node (the same move as `WinsPad`, ADR
0073), and the session reads the multiplier and step length off the node and reports a `TreadmillTick` to the
game through `KeyboardSessionOptions.onTreadmill`. The game accrues steps at the cadence per report and pays
out each whole step: Experience up by the step's value, a popup at the feet saying what it paid (`+1` on
Chocolate, `+9` on a ×9). Kodjo's call, popups on; at 35 a second it is a stream, and the pool recycles.

Only the local character's contacts reach a component, so only the local player earns. Peers see someone
standing on a pad.

### One component, a parameter for the tier

Not five components. The tiers differ by one number, and the editor sets it. Locking and unlocking are a later
piece, by Kodjo's word.

## Consequences

- A pad beside spawn, ×1. Stand on it: XP climbs at your running rate, popups stream from your feet.
- The pane's `XP per key` is the treadmill's too — one rule, not two.
- 4 tests: the cadence at level 1 and level 52 and its independence from the tier, the step value by tier, the
  session reporting one tick per contact with the pad's numbers, and no teleport and no Wins from it.

## Rejected

**A flat rate per second.** Would have been invented; nothing documents one, and Kodjo's account says there is
not one.

**Five components.** One number apart.

**Detecting by position.** The contact is already delivered every tick; a second query would be a second source.

## Known open

- **No lock, no unlock.** Every treadmill placed is usable. Kodjo has said this is next.
- The character stands still on it. The real game runs you in place. Animation is the game's `animator` to
  supply when wanted (ADR 0063).
- A plain pad, no belt.

# ADR 0042 — Fast vertical platforms: footing is not just a downward ray

Status: accepted. Fixes platform carry (ADR 0021) and the jump (ADR 0034/0041) on fast vertical movers.
Found by Kodjo playtesting a fast up-and-down platform; every number here is measured.

## Context

Three defects, all invisible on the 3 m/s movers the carry system was built and tested against.

**1. Riding a fast descender bounce-fell.** From roughly 7 m/s down the character fell, caught the deck,
fell again, on repeat, never settling. `probeGround` casts one ray from the capsule's centre reaching the
snap distance past the feet — 0.4 m. A rider sits about a tick of travel behind a descending deck, so lag
plus one tick of drop passes 0.4 m at 9 m/s (0.30 m/tick): footing vanished, gravity took over, the
character free-fell until it caught the deck, re-locked, and lost it again. Measured: base absent on
**55 of 60 ticks** at 9 m/s, worst gap **1.48 m**; 60 of 60 and 1.94 m at 12 m/s.

**2. Landing on a fast descender never acquired the base at all.** A second, separate mechanism. `move`
resolves against the capsule's whole surface, so the controller reports `grounded` a tick or two before a
single centre ray can reach a surface dropping away. In that window `grounded && vy < 0` clamped the fall
to zero while no base was acquired — the fall cancelled and nothing gained for it, the platform pulling
further away, the character re-accelerating into the same wall. Measured at 12 m/s: base never acquired
across 90 ticks, hovering 0.76 m above the deck; 3.80 m at 20 m/s.

**3. A jump off a fast riser died one tick after take-off.** The riser stays well inside the probe's reach,
so footing *and* the movement base both came back on the tick after take-off while `vy` was still 20+ m/s
upward. With the button held that re-fired the jump and discarded the platform velocity just inherited —
measured **24.4 → 15.4 m/s** off a 9 m/s riser, exactly the platform's speed thrown away. With it released,
`riding` zeroed the climb outright. Kodjo's report: jumps a slight bit, then very quickly full stops, then
gets caught back by the platform.

## Choice

**Rising away from a surface is not standing on it.** Footing and the base are both gated on `vy <= 0`:

```
const standing = under !== undefined && !leaving && state.vy <= 0
state.grounded = (grounded && state.vy <= 0) || standing
```

`!leaving` only ever protected the take-off tick itself, which is why the deck could re-collect on the next
one. Riding a riser legitimately keeps `vy` at 0 (the ride owns the vertical), so this does not disturb it.

**The base may be taken from what the controller touched, not only from what the ray found.** When the probe
misses and `move` reports `grounded`, `collisions()` is scanned for a collider the platform lookup
recognises. This is what stops a fall being cancelled without the ride being gained.

**The probe may look as far as the base actually moved.** `probeGround(extraReach)` lengthens the ray;
`stepCharacter` calls it a second time — only when the first missed, only while a base exists, and only by
the distance the stored anchor point has dropped away (`toWorld(frame, base.localPos)` against the current
position). The result is accepted only if it is the same collider. Derived from the anchor rather than from
`liftVel`, because `liftVel` fills in after a full tick of riding and a fast descender takes the base away
before that — the velocity estimate read zero on exactly the ticks it was needed.

**`jumpCutScale` ships off (1).** Variable jump height needs input resolution this stack does not have: at
30 Hz a tap is one latched tick, so the cut is two-valued — tap or hold — rather than a range. At 0.4 a tap
landed at **0.89 m** against a 2.7 m hold, a third of the jump for the default way people press a button,
and on a riser a cut jump barely cleared the deck before the platform collected it. Mario 64, the reference
3D platformer, has no release-cut at all. The mechanism stays and the slider is live.

## Consequences

- **Carry holds to the contact offset at every speed tested.** Base absent on 0 of 60 ticks and worst gap
  **0.020 m** — the controller's own offset, i.e. exact tracking — from 6 through 20 m/s descending. The
  0.159 m "steady lag" seen while diagnosing was an artifact of starting a test platform at full speed on
  tick one; an eased track, which is what an authored keyframe track produces, tracks perfectly.
- **Landing on a descender acquires at every speed** (tick 13 / 17 / 22 at 6 / 12 / 20 m/s) and never loses
  it again.
- **A jump off a riser now decays by gravity alone** (24.4 → 22.6 → 20.7 …) and peaks a consistent 2.7 m
  above the deck whatever the platform is doing.
- **A platform starting at full speed under a standing character still cannot be acquired above ~12 m/s**,
  because acquiring needs a first contact and there is none to find. Landing on one works, and authored
  tracks ease in, so this is a limit of the pathological case rather than of content. Left as is.
- **`state.grounded` is false on the take-off tick now**, where the controller's flag could previously make
  it true. More honest, and nothing depended on the old answer: the horizontal solve reads the *previous*
  tick's value, and the coyote refill wants a jump to spend the window, not refill it.
- **`probeGround` takes an optional `extraReach`.** Documented with the warning that a longer ray also
  reaches floors the character is not standing on, so the caller must check the returned handle.
- **Three regression tests in `platformCarry.test.ts`**, each verified to fail with its fix reverted.

## Rejected

**Raising `snapToGround` so the default probe reaches further.** It is the controller's parameter as well as
the probe's, so it would change how far the capsule is held to ground everywhere, to fix a case that only
arises on fast movers.

**Gating the `grounded && vy < 0` clamp on probe-confirmed footing.** Would have fixed defect 2 by letting
the fall continue, but the controller's flag is deliberately there to cover surfaces the narrow ray misses —
standing on an edge, wedged against geometry — and a character resting on one of those would accumulate
downward velocity it had no way to spend.

**Extending the probe reach by the character's own fall speed.** Would report footing while genuinely
airborne a metre up, breaking coyote time and the jump gate.

**Keeping `jumpCutScale` at 0.4 and adding a minimum-jump-time guard** so a tap buys a floor of, say, 60% of
the apex. The right way to have the feature, and the reason the mechanism is kept rather than deleted. Not
built now: it is another feel value, and the immediate need was to stop the jump feeling broken.

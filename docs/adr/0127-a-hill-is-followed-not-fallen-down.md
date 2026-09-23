# ADR 0127 — A hill is followed, not fallen down

Status: accepted. Unconditional in `stepCharacter`, so every game gets it; nothing is added to
`CharacterTuning`. Adds one field to `CharacterState` and one optional argument to `CharacterBody.move`.
Fixes a defect in [ADR 0012](0012-roblox-like-character-controller.md)'s controller; touches
[ADR 0042](0042-fast-vertical-platforms.md)'s probe reach and the contact-nudge retry
([`platform/physics.md`](../platform/physics.md)).

## Context

Kodjo reported two things about slopes in keyboard: running down a steep enough hill fast enough, the character
hops instead of following the surface — forward, a fall, a landing, repeat; and running up one, it ends up
slightly inside the hill.

Both come from the same omission. `probeGround` returns the ground's `normal` and `stepCharacter` never read
it — the only place a normal appeared in the file was a synthesised flat one. Velocity is `vx`/`vz` and
nothing else, so every tick asked to move *horizontally* off a surface that was going down, and the only thing
holding the capsule to the hill was Rapier's snap-to-ground, a fixed 0.4 m. Once a tick's drop passed that, the
probe could not reach the surface either, footing was gone, and gravity had it.

Measured running down 30° for 4 s, before: airborne 41 % of ticks at 5.5 m/s, 61 % at 15, 90 % at 30, 94 % at
60, with gaps from 0.47 m to 9.9 m, and at 283 m/s a single 155 m launch that left the hill entirely. Uphill,
the capsule sat 0.05–0.30 m inside the surface at every speed, and below ~17.5° it went clean through: 150 m
below a 17° slope at walking pace.

Neither obvious lever helped, both measured. A snap distance scaled to the tick's drop took 90 % airborne to
77 %, because snap only engages for a capsule that was *already* grounded, so one bad tick starts an arc
nothing can interrupt. Eight sub-steps per tick made it **worse**, 97 %, which is how it was established that
the shortfall is not a resolution problem.

## Decision

**The height change is asked for, not discovered.** When a grounded character is staying put on a slope, the
step handed to `move` carries the vertical that keeps its soles on the plane the probe found:

```
dy = -(n.x·dx + n.z·dz) / n.y
```

Downhill it descends, uphill it climbs. `n.y` needs no guard: `probeGround` returns nothing for a normal
flatter than the 50° climb limit, so anything reaching this is floor.

Three design answers from Kodjo, all of which say slopes are a "stay on the ground" problem and nothing more:

| | |
| --- | --- |
| Downhill speed | **unchanged** — gravity grants nothing |
| Uphill speed | **unchanged** — a climb costs nothing |
| Running off a crest | **glue** — only the jump button puts you in the air |
| 50° climb / 45° slide | unchanged |

Speed is untouched because Max Speed is what a Level buys: a hill that gives or takes speed moves a stage's
gate ([`games/keyboard/world-1.md`](../games/keyboard/world-1.md)), and the balance curves cannot see geometry.
A climb penalty is wanted later and is not built ([`games/keyboard/known-open.md`](../games/keyboard/known-open.md)).

Gated to footing that is staying put — not riding, not leaving, not rising, and `state.grounded` as of last
tick. So every airborne tick and every jump is bit-for-bit as before, and the measured envelope does not move.
The `state.grounded` condition is what stops the character gliding up a hill: the probe reaches 0.4 m below the
soles, so the tick a fall first *sees* a slope it is still well above it, and following the plane from up there
would maintain the gap. One tick of delay lands it first.

**Two supports, because the resolve is not reliable.** Rapier intermittently returns part of a step — the
`CONTACT_NUDGE` note has it at 33 of 200 ticks on the horizontal — and on a descent the missing part is wider
than the probe can see. Measured once in a 120-tick run down 40° at 40 m/s: half of a 1.14 m descent arrived,
the soles ended 0.53 m up, footing went, and the character arced 8 m off the hill.

- `move(desired, snapAtLeast)` takes the step's own length as its snap distance while descending. Snap is
  exactly what absorbs a shortfall, and 0.4 m is shorter than one tick of descent from about 15 m/s up.
- `CharacterState.slopeReach` carries that same length into the next tick's `probeGround`, because snap can
  only act while footing survives, and footing *is* that probe.

Both are zero unless the last step was a descent, so flat ground, ledges and steps keep the configured 0.4 m.
The length of the whole step rather than its vertical alone: the shortfall scales with the step, not its tilt —
a 10° descent at 58.8 m/s drops 0.346 m a tick and still needed a metre, while 15° at the same speed never
faltered. Which angles fault at which speed is Rapier's business, not a pattern worth modelling.

**The contact-nudge retry subtracts the nudge instead of clamping to zero.** `Math.min(retry.y, 0)` threw a
genuine climb away with it, which is the whole of the uphill sink below 17.5° — steeper normals lean
`sin θ > 0.3` against the direction of travel, trip `blockedAlong`, and skip the retry, which is why it read as
an occasional inexplicable fall-through.

## Result

Across 10°–45° and the whole authored speed curve (2.8 m/s at Level 0 to 58.8 m/s at Level 100), up and down:
**footing is never lost**, and the steady state sits on the 0.02 m contact offset. Two cells still blip when a
resolve comes up short — 0.67 m on 10° and 0.21 m on 20°, both at 58.8 m/s — but footing holds, so snap closes
them over a tick or two rather than gravity taking over. `packages/humanoid/src/slopes.test.ts`.

Uphill depth is now within 0.22 m of where a capsule rests on the flat. That baseline is **-0.039 m**, not the
0.02 m offset: a capsule creeps that far into whatever it stands on under the controller's per-tick press,
slope or not, and always has. It is not a slope defect and was not chased.

## Limits

Above the authored curve the tick is the limit, not the slope. At 283 m/s a character covers 9.4 m a step
against a 2 m capsule, and on 25° and steeper it tunnels through the hill; sub-stepping does not save it, which
is the same wall [ADR 0104](0104-a-deck-may-not-outrun-its-rider.md) hit from the platform side. Separate
problem, not addressed here.

A tilted **mover** is unaffected: riding keeps its anchor and its seated contact
([ADR 0105](0105-boarding-is-arriving-not-rising.md)) and never reaches this code.

`slopeReach` does not check the collider it finds, which ADR 0042 requires of a caller tracking a *base*. It is
tracking footing, not a frame, so there is nothing to compare against — but it does mean that for one tick
after a fast descent the probe can claim footing on a different surface up to a step's length below. That is
the glue Kodjo chose, applied where a hill ends at a drop; it is bounded by being zero on every other tick.

## Rejected

- **Downhill acceleration**, capped at Max Speed or uncapped. The fun version, and the one that lets a hill
  beat a speed gate the Level was not meant to beat. Kodjo's call, declined for now.
- **Launching off crests.** A ski jump at 58.8 m/s is appealing, but it needs a deliberate size threshold or
  small bumps start flinging the character, which is indistinguishable from the bug being fixed.
- **Seating the soles on the probe contact**, the way a rider is seated (ADR 0105). It follows the slope *and*
  closes any gap, but it snaps a landing down by up to the probe's reach in one tick, which changes what
  falling onto a slope feels like and moves the envelope.
- **A bigger `snapToGround` constant.** One metre fixes every measured case, and also sucks a character down
  onto ground a metre below every ledge at every speed, which is a feel change nobody asked for.
- **Sub-stepping the character.** Measured worse (97 % airborne against 90 %), and already rejected from the
  platform side in ADR 0104.
- **A `CharacterTuning` field to switch it on per game.** Following the ground you are standing on is not a
  taste; the previous behaviour was a defect in parkour and swing too.

# ADR 0060 — The camera can be put somewhere

Status: accepted. `OrbitCamera.shot(eye)` places the eye at an authored world position; `null` returns it to
the boom.

## Context

The camera has only ever been able to be *on the boom* — a distance and two angles around the character. That
covers third-person play and nothing else. A shot from a fixed vantage, the kind a corridor or a reveal wants,
was not expressible at any price, because the position is derived from yaw, pitch and zoom and there was no way
in.

This was found while answering a different question: whether the systems as built could absorb a level-driven
camera later. Everything else could — trigger volumes exist (ADR 0054), the contact plumbing exists, and
`@mp/camera` already exposes `params` as a live mutable object, so *changing the numbers* needs no camera
change at all. Putting the eye at an authored point was the one thing that needed the camera reworked, so it is
the one thing built here.

**Nothing that drives this exists, and that is deliberate.** No component, no trigger, no level data. This is
the capability; what would use it is a feature nobody has asked for.

## Decision

**`shot(eye: Vec3 | null)`.** While an eye is held the camera sits there and keeps looking at the character.

### It is a blend on the offset, not on the position

The eased mix is applied to the eye's offset *from the aim point*, not to its world position. A shot eased in
while the character is running would otherwise lurch, because both ends of the interpolation are moving and
only one of them is what the shot meant.

Its own half-life, `shotSmooth`, rather than reusing the zoom or push-in smoothing: those slide the camera
**along** the boom, and this travels off it to somewhere else entirely. 0 snaps, which is a cut rather than a
move, and is occasionally the right answer.

### Orientation comes from the offset, which it always should have

The camera built its rotation from `yaw` and the raw boom. It now builds it from the final offset. For a pure
orbit these are the same angle — `reach` scales all three components uniformly and `atan2` divides that
out — so the change is provably inert when no shot is held, and during a shot the offset is the only one that
is true.

Still not `lookAt`, for ADR 0020's reason: a fully squeezed boom puts the eye on its target, and `lookAt` then
has a zero-length direction and falls back to world −Z.

### The handover is continuous

While a shot is held, the orbit's own `yaw` and `pitch` are written from the blended direction every frame. So
mouse look is overridden — a shot the player can swing away from is not a shot — and releasing resumes from
where the shot was looking rather than snapping to wherever the mouse had wandered.

The consequence is worth stating because it surprised the test first: after a release the camera is on the boom
*as the shot left it*, on the shot's side of the character, not back where the player last pointed. That is the
continuity being bought, not a bug.

### The pull-in does not apply; the hole does

Somebody placed this eye. Clamping it to what a sphere cast cleared would be second-guessing them, and a shot
inside a wall is a mistake that is obvious the instant it is seen. So occlusion does not move it.

The see-through hole still runs, because that is ADR 0055's split exactly: hole the obstruction, do not move
the camera. In a fixed shot, holing is right and moving is wrong — which is the cleanest case that split has
had.

It needs its own query, though. While a shot is held the boom is not where the eye is, so the live probe
describes a sightline nobody is looking down. One extra cast along the actual offset answers the question that
matters, taken only while blending or held, so an ordinary orbit pays nothing.

## Consequences

- A fixed-vantage shot is expressible. Seven tests: the eye landing where it was told, still aiming at the
  character, the ease being a move rather than a cut, mouse look being overridden, the return to the boom, and
  the yaw handover.
- The editor gets it for free, having just moved to this camera (ADR 0059).
- One new tunable, `shotSmooth`, on the pane with the rest of the feel.
- 991 tests, up from 984.

## Rejected

**`lookAt` for the shot.** It would work for a shot specifically, since the eye is never on the target — but it
would be a second orientation path with a different failure mode from the first, in a function whose whole
orientation argument is written down. One path, taken from the offset.

**Clamping the authored eye against occlusion.** See above: it makes the author's placement advisory, and
"the camera is where I put it" is the only property a shot has.

**A separate camera mode or a second camera object.** The blend is three lines on an offset that was already
being computed. A mode flag would fork the placement, the orientation and the hole, for nothing.

**Also passing a look-at target.** A shot that looks somewhere other than the player is a different feature —
a cutscene — and nothing has asked for one. The eye is the part that was impossible.

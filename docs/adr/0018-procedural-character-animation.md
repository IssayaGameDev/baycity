# ADR 0018 — Procedural animation on a rigid 10-part character rig

## Context

The game needed characters that look like something rather than a capsule with a nose. Kodjo's
constraints: Roblox-like, **no skinning**, models **derived from code, not art**, and smooth motion.

Two facts about the stack shaped the answer more than any aesthetic preference.

**The wire carried position only.** `STATE` was three floats. Everything an animator needs beyond
placement — facing, speed, whether the character is on the ground — had to be derived from an
interpolated position curve, or added to the protocol.

**Without skinning, a joint only exists where a limb is split.** One-piece legs can pivot at the hip
and nothing else: a stiff pendulum, no crouch, no tuck. Where the splits go *is* the rig design.

## Choice

**Ten rigid parts**: body, head, upper and lower arm ×2, upper and lower leg ×2. Knees and elbows
both bend. Proportions are derived from `CHAR_RADIUS`/`CHAR_HALF_HEIGHT`, so the silhouette is
exactly as tall and wide as the collider and cannot drift from what collides.

**Procedural, not authored.** No clips, no keyframes, no DCC pipeline. The pose is a function of what
the game already knows about the character this frame.

**Split across two packages**, mirroring how `@mp/content` emits `VisualItem[]` for `addLevel` to
realize:

- `@mp/character` — rig data (`RIG`) and the solver (`createAnimator`). Pure math, no THREE, so gait,
  IK and smoothing are unit-testable headlessly.
- `@mp/render-three` — `createCharacterRig` builds one node per part, nested by the rig's parent
  chain, and applies a `Pose`. Ten quaternion writes per frame.
- `modes/parkour` — adapter only: fills the animator's input, keeps the nametag.

**Four techniques carry the smoothness:**

1. **Stride phase advances with distance travelled, not time.** Feet plant correctly at any speed
   with no per-speed tuning, and it stays correct while riding a moving platform.
2. **Feet are placed, not posed.** A parametric foot path plus closed-form two-bone IK derives hip
   and knee. Controlling where the foot *is* removes skating by construction; hand-tuned joint
   curves only shrink it.
3. **Half-life smoothing on every driven value**, so it is frame-rate independent. The view this
   replaced eased facing by a fixed fraction *per frame* and therefore smoothed faster at 144 fps
   than at 60.
4. **Evaluated per rendered frame** from interpolated position, not per 30 Hz sim tick.

**One byte on the wire (protocol v8).** `STATE_GROUNDED` and `STATE_RISING` travel; facing and speed
stay derived. Snapshot entities grow from 8 B to 9 B — about 0.3 kB/s more for 19 peers at 20 Hz,
against a 20–30 kB/s budget. Flags are never interpolated: the interpolator takes them from the
sample at or before the render time, because blending "grounded" toward "airborne" is meaningless.

## Why grounded travels but facing does not

Vertical velocity is not a substitute for grounded. It passes through zero at the apex of **every**
jump (reads as standing, mid-air) and is negative while running down a ramp or stairs (reads as
falling, on the ground). In an obby the player is airborne a large fraction of the time, so this is a
primary state, not a corner case.

Facing is different: the controller always faces its movement direction and there is no independent
aim, so velocity direction *is* facing. Deriving it loses nothing. Yaw goes on the wire the day aim
decouples from movement, and not before.

## Rejected

**Skinning.** Ruled out by Kodjo. It would also mean art, a bind pose, and a mesh pipeline for a game
whose geometry is generated.

**Authored clips** (glTF node tracks from Blender, or JSON keyframes in-repo). Briefly adopted and
then reversed by Kodjo in favour of procedural. Would have needed clip time driven by distance
anyway to avoid skating, plus a rig-node-name contract with the DCC.

**R6 (6 parts).** Cannot crouch or tuck — no knees. The core verbs here are jump and land, and those
live in the knees.

**R15 (15 parts).** More expressive, more to tune, and the extra joints (ankles, waist) buy little on
a blocky character.

**Squash and stretch.** Deferred by Kodjo as out of scope. Cheap to add later — non-uniform scale on
parts already present.

**Deriving grounded from vertical velocity.** See above; wrong on every jump.

**Instanced rendering.** 20 players × 10 parts is 200 meshes with shadows and GTAO, collapsible to
~10 draw calls with one `InstancedMesh` per part type. Not done; the rig API should not need much
change to adopt it.

## Consequences

- A sign trap worth knowing about, since it produced a visible bug: rotating about **+x** carries a
  part's tip toward **+z when the part extends upward** (body, head) and toward **−z when it hangs
  downward** (every arm and leg). Sharing one pitch helper between the two kinds made the legs swing
  backward while the character moved forward — a moonwalk, with the planted foot sliding at twice
  body speed. There are now two helpers, `setUprightPitch` and `setLimbPitch`, and a test asserting
  the physical property: a foot in stance holds still in **world** space. Testing the IK against its
  own convention did not catch this; only testing against the rendered result did.
- Peer speed is derived from rendered position, which **includes platform carry** — so a peer
  standing still on a fast mover animates as a sprint. Fixable without bandwidth by probing the
  peer's ground and subtracting the platform's velocity (`LoadedLevel.basePose`); not done. The same
  gap is why peers get no `carry` and so never brace: separating a peer's carry from its walking needs
  either its locomotion speed on the wire or that ground probe. Both bugs, one missing quantity.
- **The camera sits behind the character, so fore/aft motion is nearly invisible from it.** This bit
  twice: arm swing at 51° read as "barely moving", and a jump that raised the arms forward read as
  nothing happening at all. Limb posing therefore takes pitch *and* an outward roll, and the roll is
  the dominant term in the air. Any future pose worth seeing needs a lateral component.
- **Rising and falling are separate poses** — tucked and compact going up, extended and reaching
  coming down, arms wider on the descent. This is what `STATE_RISING` is for; it was carried on the
  wire and ignored at first, which made a jump and a fall identical.
- Gait and air-pose parameters are bound live in the debug pane ("Gait (procedural)", "Jump / air
  pose") over one shared tuning object read fresh each frame, so it retunes every character including
  peers. Feel is Kodjo's call and words are a slow way to converge on it.
- **Variation is per movement, not per character** (Kodjo's call — a fixed personality per player was
  rejected). A seeded PRNG rolls multipliers on *events* — each footfall, each takeoff, each landing —
  and they are held for that movement and eased toward, so consecutive steps and jumps differ while
  nothing changes mid-stride. Per-frame randomness is deliberately not used: it reads as noise rather
  than life. Scaled by `variation` — 0 disables, 1 is life-like, and the debug slider runs to 10
  because the per-quantity spreads (±14–30%) are hard to *see* at 1 while tuning. Multipliers are
  rolled in **log space** for that reason: a linear `1 + u·spread·amount` goes negative at large
  amounts and inverts the motion (a foot lifting into the floor), and clamping the result at zero
  fixes the sign but skews every quantity larger on average, so the knob would stop meaning "more
  variation" and start meaning "bigger". Past ~5 the poses clip anyway: a varied lift exceeds the
  leg's reach and the IK clamps.
  **Stride length is never varied.** Phase advances as distance / stride, so changing stride while a
  foot is planted slides that foot — the skating the design exists to remove. Only quantities free of
  ground contact are varied (foot lift, arm swing, twist, bob, air tuck and splay, landing depth), and
  a test drives variation to full while asserting the stance foot still holds still in world space.
- **Idle is a separate layer on a time clock.** Every gait amplitude is scaled by speed, so at a
  standstill the gait contributes exactly nothing and the character freezes solid. The idle layer
  fades in as the gait fades out (`idleBlend = grounded × (1 − speed/1.2)`) and carries breathing, a
  periodic weight shift with a contrapposto torso tilt, and the knee unlock below. Its shift clock
  advances *scaled by the blend*, so a shift never fires mid-run and then pops into view the instant
  the player stops. Each shift is a movement and rolls its own variation.
- **A standing character's legs are at exactly full extension** — the hip line sits two bone lengths
  (0.75 m) above the sole by construction. So *any* hip lift is unsolvable and pulls the feet off the
  floor, and no idle motion at all is possible until the hips drop first. `idleSettle` is that slack;
  breathing is expressed as a varying drop that never reaches zero rather than as a rise.
- **Inertia is a per-part additive layer keyed to acceleration, not velocity.** A character being
  *moved* rather than moving has no locomotion to animate but still has mass. `CharacterState.carry`
  is the signal: everything the controller resolved horizontally that locomotion did not ask for —
  a platform's ride, a sweeping piece's shove, a wall taking momentum away — plus the ride alone
  vertically. It was already being computed and discarded (`applied` minus the locomotion delta).
  Vertically it must **not** come from `applied.y`: that also cancels the gravity nudge on every
  grounded tick, so the difference would report a permanent upward shove from the floor holding the
  character up, and snap-to-ground and autostep land there too.
  Because the response is to the derivative, a platform at a steady speed produces nothing — standing
  on a train at line speed feels like standing still — while its starts, stops and corners produce
  everything. A turntable therefore leans its rider inward for free: constant speed, constant change
  of direction, constant centripetal acceleration.
  Each part has its own lag weight and **inherits its parent's**, so the weights are increments down
  the chain and a forearm ends up lagging most. Two consequences worth knowing: the head's weight is
  low because a real head stabilizes itself, yet its *absolute* travel is still the largest on the
  body since it rides atop a leaning torso — weight ordering is only visible in local rotation. And
  the legs take no rotation at all: their feet are planted, so the lower body's inertia arrives as
  hip travel that the IK absorbs into unequal knee bends.
- **The acceleration is measured as the gap between the carry signal and its own smoothed value**,
  sampled at the frame midpoint. For an exponential smoother that gap is exactly a low-passed
  derivative (`(raw − smoothed)·ln2/halfLife`), so nothing is differenced: `carry` updates at the
  30 Hz sim rate while this runs per rendered frame, and a plain difference is a staircase of spikes
  and zeroes. Reading the gap only before the frame's update — rather than averaging before and after
  — left a one-frame bias that scaled with `dt`, and 144 fps disagreed with 60 fps by 4%; the midpoint
  brings that under 1 mm on a 17 cm lag.
- `atan(a/g)` sets the magnitude, being the angle a pendulum hangs at under that acceleration. It
  saturates rather than exploding when a platform reverses in a single tick. `g` is 9.81, **not** the
  simulation's 55: sim gravity is 5.6× Earth's so jumps are snappy, and normalizing against it would
  make every response five times too small to see.
- Upward acceleration compresses the body; downward is **not** permitted to lift the hips (see the
  full-extension note above) and goes to the arms floating outward instead.
- **Two bones with one pitch each reach a plane, not a volume.** The leg solve originally assumed the
  foot sat directly under the hip's *current* x, which silently welded the feet to the hips laterally:
  a weight shift was not merely unimplemented, it was inexpressible. The fix rolls the whole leg about
  z until the target lies in its sagittal plane, then solves in that plane. The roll composes on the
  **outside** of the upper leg's pitch (`Z·X`, unlike the limbs' usual `X·Z`) so the knee inherits it
  and `Z·X(p1)·X(p2)` stays the flat solution turned bodily — a hip abducting. The other order bends
  the leg out of its own plane. This also fixed a pre-existing ~1 cm lateral scuff per step, since the
  torso's counter-twist swings the hip joints sideways and the stance foot used to follow.
- `@mp/render-three` now depends on `@mp/character`. Safe: `@mp/character` imports `@mp/physics`
  **types only**, so no Rapier WASM enters the render bundle.
- Corner radius is a single knob (`cornerRadius`, default 0.03 m). 0 gives hard edges.

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
- **Consecutive jumps mirror each other** (Kodjo's call). A lead side flips at every takeoff and drives
  a contralateral pose: the lead knee tucks higher and reaches further forward, the *opposite* arm
  throws wider and higher. Same-side pairing was never on the table — it is the robot walk, and a test
  asserts the contralateral sign so a slip cannot produce one.
  Three things this exposed or needed:
  - The legs' fore/aft air split already existed and was **hard-coded to favour the left on every jump
    of every character**. It is now lead-driven, so amount 0 gives a symmetric pose rather than
    reproducing the old left-handed one.
  - **One leg folds and the other extends** — which a ±fraction around the tuck cannot express, since
    half of a 0.36 m tuck is still a bent knee. The share is asymmetric by construction: the lead leg
    takes the whole tuck at any amount and the trailing one gives up its share until it reaches zero
    lift, which *is* full extension, and saturates there because a leg cannot straighten past straight.
    `airTuckRise` therefore keeps meaning what it always did, for the leading knee. Measured at the top
    of the rise: lead 99–112° of knee bend, trail 2–13°.
  - **The trailing leg's extension is the one air quantity the strength roll must not touch.** Near
    full extension the knee angle is savagely nonlinear: 66 mm of residual lift measures 46° of visible
    bend. A roll landing under 1 therefore does not read as "slightly less straight", it reads as bent —
    and did, on half the jumps, before this was split off from the rolled term. A leg either extends or
    it does not; the variation lives in the fore/aft rake, the arm throw and the lead knee's height.
  - **The asymmetry fades out with `riseBlend`.** The descent extends both legs to feel for the floor;
    held through it, the character lands visibly one-footed and then snaps flat. Measured 1.3 mm of
    sole-height split by mid-descent.
  - **Alternating alone is only two poses** and reads as a pattern within a few jumps, so the *strength*
    is rolled per takeoff like every other per-movement quantity. Measured fore/aft rake across six
    jumps: 277/298/366/421/269/406 mm.
  Split between arms and legs by what the camera can see: the arm half is carried mostly in the
  **outward roll** (measured 166–262 mm of lateral hand separation), because a raised arm pointing
  forward is foreshortened to nothing from behind the character — the same constraint that put a splay
  in the walk. The leg half is worth less from there and is weighted accordingly.
  With idle live, an airborne pose is symmetric only to ~0.9 mm even with both knobs at zero. Not a
  leak: the idle arm hang is deliberately unmirrored, and the arm springs still hold a little of it
  when the jump begins.
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
- **The head was welded to the torso, and no amount of tuning could have unwelded it.** Every one of
  its terms was a torso term times a constant — pitch `−lean·0.7`, yaw `−twist·0.6`, roll `−tilt·0.6` —
  so the head could only ever render as a lazier copy of the torso. The fix is not bigger constants,
  it is giving the head inputs no other part has. Four, all in the `Head` pane folder:
  1. **Stabilization** replaces the three constants with one knob. The head's local rotation carries
     `slerp(identity, conj(bodyBaseQ), headStabilize)`, so at 1 it holds dead level in the world with
     the torso turning underneath — a vestibular reflex. Slerping the base rotation's **conjugate**
     rather than negating its three Euler terms is what makes this exact: measured head world tilt is
     `(1 − knob)` × the torso's at every value of the knob (torso 0.238 rad at top speed → head 0.238 /
     0.119 / 0.000 at knob 0 / 0.5 / 1). Negated Euler terms only agree to first order, since X·Y·Z
     does not commute. It stabilizes against the **gait and idle** rotation only, deliberately: the
     inertia layer is additive with its own per-part weights, and cancelling a share of it here would
     silently rewrite what every one of those weights means.
  2. **Its own facing smoother.** `headYaw` chases the same target as `yaw` on its own half-life; the
     difference is the head's local twist, clamped. Shorter than `yawHalfLife` and the head arrives
     first — it leads into a turn, which is what reads as looking where you are going; longer and it
     trails, which reads as being thrown around. One knob covers both. Self-cancelling by
     construction: two smoothers chasing one target agree once the target stops moving, so the lead
     exists only during a turn and nothing has to unwind it (measured 22° peak on a 90° snap turn,
     2·10⁻⁵ rad a second later).
  3. **A steadier eyeline than the hips**, which is why `Pose` grew a translation. A rotation cannot
     express the neck absorbing the stride's vertical travel — the head has to *move*. This began as
     `headCounterBob`, a fraction of the gait bob subtracted; the spring layer below subsumed it and
     the term is gone.
  4. **State pitch** — chin up while rising, looking down at the landing while falling, a nod on the
     impact decaying with the landing crouch, and a little down the run at speed. These are the only
     head terms with no counterpart anywhere else on the body.
  The head's own terms are composed **inside** the counter-rotation (`counter · own`), so they act in
  the stabilized frame rather than in the torso's. Ordering them the other way applies the head's
  pitch in the frame the stabilization was supposed to remove.
  Worth knowing when tuning: from the default camera, behind the character, head yaw and pitch are
  the most foreshortened quantities on the whole rig. The translation is the one a player sees.
- **Follow-through is a spring layer, and the spring is a vibration isolator — which is the whole
  design.** Each of head, upper arm and forearm hangs off its joint on an under-damped spring chasing
  where that joint belongs; the lag *is* `jointOffset`, and the under-damping is what makes it ring.
  One construction then covers every source: the stride's bob, the landing crouch, hip travel from a
  platform's jolt, an elevator's compression, the air pose changing shape. All of them already arrive
  in the joint targets, so nothing needs a term of its own.
  **The frequency is not a "how snappy" knob, it decides the sign of the effect**, and this is the
  trap the whole layer turns on. Measured against 129 mm of hip travel at top speed: at 2 Hz — below
  the bob's ~3.2 Hz — the head travels 43 mm and the neck gap opens to 66 mm, an isolator doing its
  job. At 8 Hz it travels 126 mm: the head now *tracks* the bob and reads as a bobblehead. Reaching
  for a stiffer, snappier neck makes it strictly worse, which is why there is a test asserting both
  ends. The arms need their own, far stiffer frequency (8 Hz) for an unrelated reason: an arm's primary
  motion is its own swing, ~1.6 Hz through a half-metre arc, and a spring soft enough to isolate a
  head cannot follow that at all — it pins at full excursion and degenerates into a rigid offset with
  no dynamics left in it. Two drives, two frequencies.
  `springHead` is 0.7 rather than 1 because head travel is *lowest* there (43 mm, against 62 mm at
  full weight): the lag is not purely anti-phase with the bob, so it has a quadrature component and an
  intermediate weight cancels more of the bob than all of it does.
  `springMax` is an anatomical stop, not a shaper. A landing binds it — and should, since the torso's
  crouch pitches 0.15 rad and the neck sits 0.75 m above that joint, so the head's target jumps 110 mm
  sideways in one frame, more than the 125 mm hip drop does. Ordinary walking must stay clear of it
  (66 mm against 110 mm); if it binds while walking, the frequency is wrong.
  Solved in **closed form** — the exact 2×2 map on (displacement, velocity) — like every other
  smoother here, so 60 fps and 144 fps ring identically. A stepped integrator would also *gain* energy
  at low damping and never settle.
  Driven from **root space**, not world: everything above is already in root space and smooth per
  rendered frame, whereas a peer's world position is an interpolated 20 Hz staircase that a
  lightly-damped spring would ring on. The cost is that a pure spin drives nothing, since turning in
  place moves no root-space joint.
  The body and the four leg parts are excluded **by construction**, not left untuned: the body's
  travel is `bodyOffset`, which the leg IK is solved against, and displacing a leg would slide the
  foot it is standing on. Their `jointOffset` entries are asserted to be exactly zero.
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

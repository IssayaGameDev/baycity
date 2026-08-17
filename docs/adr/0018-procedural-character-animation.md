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
   with no per-speed tuning, and it stays correct while riding a moving platform. (The platform half of
   that was false in the first implementation — see the stride-pacing update below.)
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

**That last paragraph was wrong, and both derived quantities now travel — see the update below.**

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
  standing still on a fast mover animates as a sprint. **Fixed by putting locomotion speed on the wire
  (v9) — see the update above.** Fixable without bandwidth by probing the
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
- **Inertia is a per-part additive layer keyed to acceleration, not velocity, and it is fed the
  character's *total* world velocity.** That total is its own locomotion (`speed` along `yaw`) plus
  `CharacterState.carry` — everything the controller resolved that locomotion did not ask for: a
  platform's ride, a sweeping piece's shove, a wall taking momentum away, plus the ride alone
  vertically. `carry` was already being computed and discarded (`applied` minus the locomotion delta).
  **Only `carry` was wired up at first, and that was the layer's central bug**: the signal is by
  definition motion the character did *not* ask for, so the layer fired on platforms and nowhere else.
  Your own starts, stops and turns — 55 m/s² and 69 m/s², by far the largest accelerations in the game —
  produced nothing at all. It read as a stiff character with a mysterious platform-only twitch. Two
  separate attempts to make the arms visibly lag failed against this, because both were tuning a
  mechanism whose dominant input was missing: the arm springs are driven in root space, and root space
  is attached to the character, so running through the world moves nothing in it either.
  Vertically it must **not** come from `applied.y`: that also cancels the gravity nudge on every
  grounded tick, so the difference would report a permanent upward shove from the floor holding the
  character up, and snap-to-ground and autostep land there too.
  Because the response is to the derivative, *any* steady speed produces nothing — standing on a train
  at line speed feels like standing still, and so does running flat out — while every start, stop and
  corner produces everything. A turntable therefore leans its rider inward for free, and so does a
  player's own hard turn: constant speed, constant change of direction, constant centripetal
  acceleration.
  Velocity comes from `input.yaw` rather than the smoothed facing, because it points where the character
  is *going*; the smoother is a rendering choice about where it looks. This also closes the peer gap
  noted below for the inertial layer specifically: a peer's derived speed and yaw are its world
  velocity, so peers now brace even though they still receive no `carry`.
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
  3. **Translation**, which is why `Pose` grew `jointOffset`. A rotation cannot express a head that is
     late to where its neck went. This began as `headCounterBob`, a fraction of the gait bob subtracted,
     then became a root-space spring, and is now the world-space joint lag described below; both earlier
     forms are gone.
  4. **State pitch** — chin up while rising, looking down at the landing while falling, a nod on the
     impact decaying with the landing crouch, and a little down the run at speed. These are the only
     head terms with no counterpart anywhere else on the body.
  The head's own terms are composed **inside** the counter-rotation (`counter · own`), so they act in
  the stabilized frame rather than in the torso's. Ordering them the other way applies the head's
  pitch in the frame the stabilization was supposed to remove.
  Worth knowing when tuning: from the default camera, behind the character, head yaw and pitch are
  the most foreshortened quantities on the whole rig. The translation is the one a player sees.
- **Secondary motion is one first-order lag per attachment to the torso, in WORLD space.** The neck and
  the two shoulders each interpolate toward the world position of the point they hang from, so each is
  simply late to wherever the body went. The offset *is* `jointOffset`. Everything drives it with no term
  of its own — walking, starting, stopping, turning, jumping, the stride's bob, a landing, a platform's
  jolt all move that point through the world, and that is the only input it takes.
  **World space, not root, is the entire trick, and three attempts failed on it.** A joint's position in
  the body's own frame never changes — a shoulder is bolted to the torso — so a filter applied there
  converges instantly and renders nothing at all. Two rounds of tuning went into root-space springs on
  the shoulder (12 mm of lag, then 45 mm, both invisible) before the frame itself turned out to be the
  bug. If a filter has nothing to chase, no amount of tuning will show.
  **Nothing below an attachment gets its own lag.** A forearm inherits its shoulder, so each arm travels
  as one piece; a second filter at the elbow only opens a gap there, and it also dictated the shoulder's
  tuning, since the elbow's target moves with the arm's own swing (~1.6 Hz through a half-metre arc)
  rather than with the body. A chain of filters couples their tuning and the child's drive is always the
  faster one. The elbow's displacement is asserted to equal its shoulder's *exactly*: this layer writes
  translations only and no rotation reads them back, so the identity holds to floating point and the arm
  provably cannot come apart.
  **A steady speed holds a constant trail, and that is the effect rather than a defect.** A first-order
  lag against a target at constant velocity settles at `v·τ` behind it, so running flat out holds each
  joint a fixed distance back — measured 79 mm at the shoulders and 55 mm at the neck at 5.5 m/s.
  Removing that steady offset needs the response keyed to *acceleration* instead, which was tried, and it
  deleted exactly the effect being asked for while looking correct in every test. Keying to acceleration
  is right for the rotations, where a permanent lean would be wrong, and wrong here.
  **First order cannot overshoot**, so a joint falls behind and catches up but never swings past. That is
  the trade against the under-damped spring this replaced, which did ring on landings, and it is why the
  bound is a hard maximum rather than a damping ratio.
  **What it cost: the head is no longer much steadier than the hips.** The spring it replaced filtered
  the neck point in root space, so it never saw the character travelling and could be soft enough to
  attenuate the bob — 43 mm of head travel against 129 mm of hip travel. The world-space lag cannot do
  both at once: attenuating a 3.2 Hz bob wants `τ ≫ 50 ms`, which at 5.5 m/s is a 275 mm trail. Tuned for
  the trail, the head now rides 119 mm of the hips' 129. The visible neck gap survives and is larger; the
  vertical steadiness is what was traded for coordination with the arms. Recorded in a test so it is not
  rediscovered by accident.
  **Frame-rate independence needs the driving velocity.** A plain `smooth` toward a *moving* target treats
  it as jumping at the frame boundary and settles at `v·dt·α/(1−α)` — 42 mm at 60 fps against 62 mm at 144
  for one tuning. The exact linear-ramp solution is used instead, which settles at `v·τ` at any frame rate.
  **That velocity must be given, never differenced from a position**, and getting this wrong shipped as a
  visible bug: the head and arms vibrated while moving, worst on a platform. Position arrives from a 30 Hz
  simulation while this layer runs per rendered frame, so a one-frame difference of it alternates between
  zero and a whole tick's travel — a square wave whose amplitude is *twice* the mean, measured at 92 mm of
  frame-to-frame flip, and still 12 mm after averaging it over 60 ms. No affordable smoothing fixes that
  shape. The character's total world velocity is already computed exactly for the inertial layer, so it is
  used directly and nothing is differenced. The same warning is written above the inertial layer's own
  derivative, which made this a hazard already documented and then walked into.
  **Losing the vertical to that change is a mistake worth recording.** Differencing the world position had
  been picking up every vertical source for free; the velocity signal that replaced it covered only the
  horizontal half, because `carry.y` is a platform ride and nothing else. Jumps stopped trailing entirely
  and it was reported as the effect having disappeared. `AnimationInput.vy` now carries the character's own
  vertical velocity, and the lag's vertical drive is `vy + carry.y` — complementary rather than
  overlapping, since the controller zeroes `vy` while grounded and hands the vertical to the surface while
  riding, so a jump is all `vy` and an elevator is all `carry.y`.
  `vy` is given to the lag and **withheld from the inertial rotations**, deliberately. There the signal
  would be differentiated, and free fall is not an upward acceleration — it is the absence of a ground
  reaction. Differentiating `vy` in flight yields a constant −g and would float the arms for the whole arc.
  **The stride's bob drives it too, on its own filter.** The bob is `−|sin(phase·τ)| · amplitude` and `phase`
  advances at `speed / (stride · 2)`, so its rate is available in closed form. That is not enough on its own:
  `phase` advances from the *position delta*, which arrives at the sim rate, so the rate inherits that
  staircase and differentiating amplifies it — left raw it put 27 mm of frame-to-frame jitter into the offset,
  more than the body's own. It needs averaging, but far less than `carry` does, and this only works because
  the two frequencies are far apart: the bob is ~3.2 Hz at top speed and the tick is 30 Hz. At 40 ms roughly
  two thirds of the bob survives and the staircase is down tenfold. Passing it through the 120 ms window
  `carry` needs would leave about a quarter of it, which is the negligible amount it had before it was added.
  The cost, recorded in a test: worst-case frame-to-frame jitter under a deliberately stepped position went
  from 3.9 mm to 6.9 mm — still under the body's own 25 mm, and this is the first number to move if shimmer is
  ever reported again.
  Also restructured by this: the driving velocity is smoothed **once** rather than per part, since all three
  joints hang off the same torso and were smoothing an identical signal three times.
  A test drives the animator with a position held for two frames at a time — the 30 Hz-into-60 fps case,
  plus a platform's carry so the per-tick step is as large as the report — and asserts the offset's
  frame-to-frame change stays under the *body's* own, which is 25 mm there because a held position also
  freezes the stride phase. The layer cannot be steadier than what it hangs off; it must not add jitter.
  **The velocity needs its own smoothing anyway, because `carry` is noisy at source.** It is
  `(applied − locomotion)/dt` from the controller — a per-tick *difference* of what the physics solver
  resolved, so it carries the solver's contact hash, and dividing by a 33 ms tick multiplies that by 30.
  Standing on a moving platform feeds this a few tenths of a m/s of tick-to-tick noise, which showed as a
  slight vibration even with the character still. `LAG_VELOCITY_HALFLIFE` is therefore 0.12 s, matching
  `inertiaHalfLife`, so the translation is filtered as heavily as the rotations that share the signal —
  those pass through two low-passes and never showed it. Costs nothing at a steady speed; costs a slightly
  softer arrival of the trail on a hard start.
  The body and the four leg parts are excluded **by construction**, not left untuned: the body's travel
  is `bodyOffset`, which the leg IK is solved against, and displacing a leg would slide the foot it is
  standing on. Every `jointOffset` entry but the neck's and the two shoulders' is asserted to be exactly
  zero.
- **Locomotion and `carry` get separate differentiation windows, because only one of them is a clean
  signal.** They are summed afterwards. `carry` is `(applied − locomotion)/dt` out of the controller — a
  per-tick difference of what the physics solver resolved — so it inherits the solver's contact hash, and
  dividing by a 33 ms tick multiplies that by 30. Differentiating again scales it by `ln2/window`, so the
  0.03 s window that locomotion needs to see a 0.1 s start turned a quiet platform ride into **several
  degrees** of arm and head shake. It was reported from the game twice, and the first fix — filtering the
  *translation* harder — did nothing, which is what identified the rotations as the real path.
  Locomotion can afford a sharp window because it comes from the controller's own speed and ramps
  smoothly. `carry` takes 0.12 s, and loses nothing by it: a platform's real accelerations play out over
  about a second. It is the noise that is fast, not the motion.
  A test drives a 2 m/s ride with ±0.3 m/s of per-tick hash and asserts under 0.2° of arm rotation change
  per frame, then drives a clean 0.1 s start and asserts it still moves the arm more than that — the two
  halves have to hold at once, and a single window cannot do it.
- **The acceleration is measured as the gap between a velocity signal and its own smoothed value**,
  sampled at the frame midpoint. For an exponential smoother that gap is exactly a low-passed
  derivative (`(raw − smoothed)·ln2/halfLife`), so nothing is differenced: `carry` updates at the
  30 Hz sim rate while this runs per rendered frame, and a plain difference is a staircase of spikes
  and zeroes. Reading the gap only before the frame's update — rather than averaging before and after
  — left a one-frame bias that scaled with `dt`, and 144 fps disagreed with 60 fps by 4%; the midpoint
  brings that under 1 mm on a 17 cm lag.
- `atan(a/g)` sets the magnitude, being the angle a pendulum hangs at under that acceleration. It
  saturates rather than exploding when a platform reverses in a single tick. **`g` is the simulation's
  own 55**, and it was 9.81 for as long as `carry` was the only input: platform rides accelerate gently,
  and normalizing them against 55 made every response five times too small to see. Feeding locomotion in
  inverts that argument entirely — against 9.81, a 5.6 g start pins the tilt near 90° and throws the
  character flat. The consequence to know about: every weight in the layer became 5.6× weaker for a
  given acceleration, which is *correct* for locomotion (5.6× the acceleration, so it nets out) and a
  real reduction for platforms. `inertiaVertical` and `inertiaFloat` were scaled up by 55/9.81 to
  compensate, because they are fed the vertical signal and locomotion is planar — a platform is still
  their only driver, so leaving them alone would have quietly made an elevator 5.6× weaker.
- **The inertial layer is rotations only.** An `inertiaTravel` term was added to it, translating each
  sprung joint against the acceleration, and then removed: the world-space joint lag above produces the
  same displacement from the same motion, and two mechanisms writing one `jointOffset` is worse than one.
  Keying translation to acceleration was also the specific mistake that hid the effect for two rounds —
  it makes a constant speed produce nothing, which is correct for a lean and wrong for a trail.
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

## Update — facing and locomotion speed travel too (protocol v9)

Two peer-animation bugs Kodjo found, both from deriving what only the owner knows:

- **A player who jumps one way and turns in the air never turned, for anyone else.** Facing follows
  the *input* direction, not the velocity: air control changes where you face while you keep
  travelling the way you jumped. The claim above — that the controller always faces its movement
  direction — is simply false while airborne, and false on the spot as well, where facing changes
  with no movement at all to derive it from.
- **A player carried by a platform walked, for everyone else, while sliding on their own screen.**
  Differencing a position gives *world* speed. `AnimationInput.speed` is documented here as
  locomotion speed excluding carry, and it is that contract the derived value was breaking.

Both are now sent: `f32` each upstream, a byte each on the snapshot (facing 1.4°, speed 0.063 m/s over
0–16 m/s). The owner passes its own rig exactly these two numbers, so a peer's rig is given the same
values rather than a guess at them. `docs/protocol.md` has the encoding and the delta rule — the relay
compares the *quantized* values, and turning on the spot now forces a relay that nothing else would.

**Interpolated differently, and it matters.** Speed is lerped between samples: it drives stride length
and swing amplitude, so at the snapshot rate it would staircase both. Facing is not lerped — it is an
angle, and lerping goes the wrong way round the circle half the time. It is taken from the sample at or
before the render time, like the flags, and the animator's own `yawHalfLife` smooths it, which is what
that knob is for.

**Cost, measured, not estimated:** snapshot entities 9 B → 11 B; the load harness went from 2.6 to
3.5 kB/s per client at 20 bots, against a 20–30 kB/s budget.

Still derived for peers: **vertical velocity**. Its only consumer is the joint lag, which wants total
vertical motion whatever caused it, so a platform's carry riding along in it is correct rather than a
compromise. Peers still brace for nothing on the inertial layer (`carry` is null for them), which is a
separate gap and unchanged.

## Update — the stride is paced by the surface underfoot, not by the world

Reported from the game: running the way a platform travels made the legs sprint, and running against it
made them crawl. Walking on a moving surface is relative to that surface, not to the world.

The phase was advancing by `min(worldPositionDelta, speed * dt * 1.5)`. On a platform the world delta is
locomotion **plus** carry, so with the platform it ran at that 1.5x cap and against it the delta fell
toward zero and the legs froze mid-stride. The comment above that line claimed the delta was there so a
carried character would not accrue stride while standing still on a mover — but that case works purely
because `speed` is zero, which is equally true without the delta. So the delta was doing nothing the
clamp needed and was wrong on the two cases it was actually deciding.

It is now `speed * dt` alone: `speed` is locomotion speed, so on a platform it *is* the surface-relative
distance, and on static ground the surface is not moving and the two agree. A teleport (respawn,
reconciliation) also cannot spin the legs any more, since no position difference feeds this term.

**`AnimationInput.position` is gone.** With the stride paced by speed it was the last consumer, and a
required field nothing reads is worse than a mechanical change across the call sites. Sixty-six of them,
all proven by the typechecker.

One behaviour deliberately changed with it: **walking into a wall now runs on the spot** instead of
freezing mid-stride. The world delta used to be zero there and pinned the phase. Making that exact again
needs the surface's *own* velocity, which `CharacterState.carry` cannot supply — it is
`(applied − locomotion)/dt`, so it conflates "the ground moved under me" with "I was blocked", and the
two want opposite answers. `stepCharacter` has the platform's velocity internally (`ride`) and could
expose it if the wall case ever matters.

The regression test asserts the property directly: identical sole traces at the same locomotion speed
with carry at 0, +4, −4 and −5 m/s (that last being a full walk with no world movement at all), and no
stride at all when carried at a standstill.

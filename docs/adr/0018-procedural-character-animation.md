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
  peer's ground and subtracting the platform's velocity (`LoadedLevel.basePose`); not done.
- Gait parameters (`DEFAULT_GAIT`) are not exposed in the debug pane, so tuning means editing code.
  Movement feel is live-tunable; this should match.
- `@mp/render-three` now depends on `@mp/character`. Safe: `@mp/character` imports `@mp/physics`
  **types only**, so no Rapier WASM enters the render bundle.
- Corner radius is a single knob (`cornerRadius`, default 0.03 m). 0 gives hard edges.

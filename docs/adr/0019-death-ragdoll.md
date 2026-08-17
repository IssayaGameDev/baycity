# ADR 0019 — Death is a local ragdoll; spawning assembles the body

## Context

Death and respawn already existed and were instant: touching a `hazard` trigger, or falling below the
level's `fallY` when `fallBehavior` is `respawn-checkpoint`, teleported the capsule to the last checkpoint
in the same tick. Nothing was seen.

Kodjo asked for the Roblox death: the character stops being animated and each part becomes its own rigid
body, separated from the others, dropped into physics and gravity, with a click to respawn.

## Choice

**Both kill paths go through the ragdoll** (Kodjo's call). Hazard contact and the fall plane are the same
death, so falling gets the same treatment as being killed by a pad. On `physical-fall` levels (the tower
variant) the fall plane is deliberately not a death at all, so only hazard contact ragdolls there — that
follows from the existing config rather than being a separate rule.

**Ten dynamic bodies seeded from the animated pose.** `partTransforms(pose, origin)` in `@mp/character`
forward-kinematics the rig to a world transform per part — the *box centre*, not the joint — and each one
becomes a `cuboid` dynamic body at exactly that transform. Seeding from the live pose is what stops the
corpse jumping at the instant of transition, which is the only thing that would give the trick away.

**Local and visual only.** Nothing about a death goes on the wire. Peers see that player stop moving.
(One flag does now — the update below — but still nothing about the corpse itself.)
Making every viewer agree needs either ten bodies per death in the snapshot or a deterministic seeded sim
in lockstep; Roblox does not do that either, and the wire budget is the thing this stack protects.

**The capsule keeps being stepped while dead.** It is invisible, fed zero input, and barred from dying
again, but it is not removed — the world step it shares is what makes the ragdoll's own bodies fall and
every platform in the level move. Removing it would freeze the ragdoll it exists to drive.

**Respawn reuses the existing path.** Left mouse button, during locked play only, calls the same
`respawn()` the pause menu's Restart calls: dispose the ragdoll, teleport to the last checkpoint, zero
momentum. The kill checks are gated on `dead`, or a corpse still falling past `fallY` would re-trigger
every tick.

**Spawning is the reverse: the body assembles a pair at a time**, each part dropping from above into the
place the animated rig would have put it, in Kodjo's order — feet, thighs, torso, shoulders, forearms, head,
building from the ground up. It plays on the first spawn as well as on every respawn.

Drawn with **loose parts too**, for a structural reason: the rig is a hierarchy, so dropping the torso in
would drag the legs that had already landed down with it. Ten independent meshes each go to their own place.

Targets are recomputed **every frame from the live pose**, so nothing is frozen and no input is locked — a
player already walking has their body arrive around them. `1 − p²` on the fall, so it accelerates downward
and reads as falling rather than easing in. Timing is three pane knobs (`pair gap`, `fall`, `drop from`);
the defaults total 0.43 s.

## Where the code lives, and why

- `@mp/character` — `partTransforms`. Pure math next to the rig data it walks, so it stays headless and
  testable. A ragdoll needs the same walk a renderer does; having two copies of it is how they drift.
- `@mp/render-three` — `createLooseParts`: the ten parts as *unparented* meshes, built by the same helper
  `createCharacterRig` uses, so a corpse cannot be a different colour or corner radius from the body it
  came from. After death there is no hierarchy left to nest — only ten rigid bodies.
- `modes/parkour/src/ragdoll.ts` — the ragdoll itself. It needs the physics world *and* the scene, and the
  mode is the only layer that owns both. `@mp/render-three` deliberately has no physics dependency (that
  is what keeps Rapier's WASM out of the render bundle) and `@mp/character` imports physics types only.
- `modes/parkour/src/assemble.ts` — the spawn assembly. No physics at all: it is a drawn animation toward
  transforms the animator already produces.
- `@mp/physics` — gained `setAngvel`. A ragdoll's parts have to tumble; only `setLinvel` existed.

## Consequences

- **The world's gravity had to become real, and that was the bug that made the first attempt useless.**
  The parkour world was created with zero gravity because the character is kinematic and integrates its
  own; nothing dynamic had ever existed in it. Rapier does not apply gravity to kinematic bodies, so
  setting the world's gravity to the character's own value changes nothing for the character and is the
  only thing that pulls the ragdoll's parts down. Without it the parts coasted off in a straight line and
  never stopped.
- **Rig visibility belongs to exactly one owner at a time.** `die()` hides it and the first version never
  showed it again, so respawning left an invisible player. It is now the *assembly* that owns it while
  running and restores it when the last part lands, which is a single place rather than a pair of calls that
  can drift apart. The assembly hides it per frame rather than once at the start, because a view does not
  exist until its first `upsert`.
- **A debug button exists** (`Death > Ragdoll now`). The real triggers cost a run to reach, and it exercises
  the assembly on the way back too.
- **The ragdoll is interpolated between sim ticks**, like the level pieces and the player. Rapier only moves
  its bodies on a tick, so writing their poses straight to the meshes showed the 30 Hz sim rate on a 60–144 Hz
  screen and read as a handful of updates a second. `capture()` on the tick, `sync(alpha)` on the frame,
  position lerped and rotation slerped. It cannot simply run at display rate despite being local: it shares
  the world with the character and the platforms, whose stepping is fixed, and its own world would mean a
  second copy of every level collider kept posed in both.
- **The world is stepped twice per tick and each step now advances half a tick.** The two steps are
  load-bearing — one so the platforms move, then the character resolves against where they now are, then
  another so Rapier's query pipeline reflects where the character ended up (a stale pipeline is what once
  made the character silently unable to walk). But at a full `TICK_DT` each, anything *dynamic* integrated
  twice per tick and ran at double speed, which is exactly what the ragdoll's parts did. Halving both leaves
  the total at one tick.
  Nothing else in the world is affected, and this is why: the level's pieces are kinematic and move to a pose
  the loader sets rather than by integration, so they arrive in step (A) regardless of its `dt`; and the
  character's own translation is computed by `stepCharacter` from the full `TICK_DT` and applied through
  `move`, not by Rapier integrating it. The ragdoll was the first dynamic body this world had ever held,
  which is why the doubling had never mattered before.
- The ragdoll's bodies collide with the invisible capsule that is still being stepped. Not corrected; the
  capsule is at the death position and the parts start inside it, so the effect is a small extra shove.
  **Wrong — it is worse than a shove, and it is fixed. See the layers note in the update below.**
- **Peers never ragdoll.** A remote player's death is invisible — they stop, then reappear at their
  checkpoint. Fixing it needs a death event on the wire, which is one flag, plus each viewer seeding a
  ragdoll from *its own* interpolated pose for that peer. Not built. **Superseded — see the update below.**

## Rejected

**Synchronised ragdolls.** See above — cost is in the snapshot, and per-client divergence is invisible in
practice because nobody is watching your corpse frame by frame.

**Joints between the parts** (a properly articulated ragdoll). Rapier has them, but Kodjo asked for parts
"all separated from each other", which is the Roblox behaviour and is also simpler: ten independent bodies
with no constraint solver to tune.

**Throwing the parts apart on death** — an outward impulse from the torso, random spin, restitution and
damping. All invented, none asked for, and removed. The instruction was to turn each part into a rigid body
and let physics have it; every knob beyond that was me designing.

**Reusing the rig's own meshes** by detaching them from their joints. Tempting — no second set of
geometry — but it leaves the rig in a broken state to restore on respawn, and the rig is shared code used
for peers too. A separate loose set is thrown away wholesale instead.

## Update — peers ragdoll too, locally

Watching a player die showed nothing: their rig stood at the death point until they reappeared at a
checkpoint. Kodjo asked for the corpse to be visible to everyone, explicitly *without* synchronising
it — different clients may land the parts in different places.

**One flag on the wire: `STATE_DEAD` (bit 2 of the v8 state byte).** No new message, no layout change,
no bytes added: the flags byte already existed and the relay already forces an entity into the next
snapshot when its flags change, so a death at a standstill still gets sent even though the quantized
position did not move. Everything else stays local, exactly as the original decision above says.

**Each viewer builds the corpse from its own pose of that peer.** `views.poseOf(id)` is the pose this
client last drew them in and `views.velocityOf(id)` its derived velocity (planar speed on the facing,
plus the smoothed vertical), so the parts start precisely where the rig was on *this* screen and carry
the momentum it appeared to have. Divergence between clients follows from that and is the point.

**The rig stops being animated while the corpse is up.** `upsert` is skipped for a dead peer, which
also leaves its derived-motion state frozen — and since a dead player does not move, that is the same
state it would have reached by being updated.

**Corpses are excluded from the camera probe, all of them, not only your own** (ADR 0020). A living
peer *is* mirrored as a kinematic capsule in the local world, so peers do push the camera; a ragdoll is
a visual whose position no two clients agree on, and ten cuboids tumbling round your feet because
someone died next to you should not move your view.

Cleanup has two paths, because a corpse can end either way: the flag clearing (they respawned — the rig
becomes visible again) or the peer disappearing from the snapshot mid-death (they left, and
`views.prune` only knows about rigs).

**A peer already dead when you join draws standing for one frame.** No pose exists until the first
`upsert`, so there is nothing to seed from; the rig is drawn once and the corpse goes up on the next
frame.

**The spawn assembly replicates too**, on the *falling* edge of the same flag and with the same timing
knobs, so a respawn looks the same from the outside as it does to the player it happened to. It is
driven by the peer's live animated pose exactly as ours is, so a peer already moving when they come back
has their body land around them.

Two details it needs:

- **The animator keeps running while the parts fall** (`upsert` is still called), because the assembly's
  targets are recomputed every frame from the pose. Only the *rig* is hidden.
- **A peer's derived motion is reset when they come back** (`views.resetMotion`). Peers' speed and facing
  come from differencing the rendered position, and a respawn is a teleport of several metres: undamped,
  it reads as a sprint for as long as the smoothing takes to decay, so the body would assemble around a
  running rig. Our own is immune — its speed comes from the sim, which the respawn zeroes.

**Not replicated: a peer's *first* spawn.** We assemble on our own first spawn, but a peer appearing for
the first time just appears. Joining a room would otherwise show every player already in it assembling,
which is not what happened to them. Left as it is, deliberately.

## Update — corpses and capsules are on separate collision layers

The original note above called the corpse-versus-capsule contact "a small extra shove". It is not: the
capsule is a metre-tall collider standing invisibly at the death point for as long as the player is
dead, so parts do not merely get nudged by it — they land on it and come to rest in mid-air. Kodjo saw
a head sitting on nothing where the capsule was. A dead *peer*'s mirror capsule does the same to their
corpse, since the mirror keeps being posed at the position they are still reporting.

One interaction is switched off, in `modes/parkour/src/layers.ts`: a character capsule and a corpse part
never collide. Corpses still collide with the level and with each other; capsules still collide with the
level and with each other, so walking into another player is unchanged.

Two details that are easy to get wrong:

- **The filters are written as "everything except", not "only these".** Level colliders and triggers
  never claimed a layer and keep Rapier's default membership in all of them, so they collide with both
  sides without being touched. A filter listing the layers it wants would stop colliding with the next
  thing anyone adds.
- **A capsule's layers have to be handed to the character controller's queries explicitly.** Rapier's
  KCC does not read its own collider's groups — `computeColliderMovement` and the `probeGround` ray take
  groups per call — so the wrapper stores the capsule's packed layers and passes them to both. Otherwise
  the parts pass through the capsule while the capsule is still blocked by, and can stand on, the parts.

Consequence, and it is deliberate: a living player walks straight through a corpse. A ragdoll is a local
visual that no two clients agree the position of, so letting it block movement would mean one player
being stopped by something nobody else can see.

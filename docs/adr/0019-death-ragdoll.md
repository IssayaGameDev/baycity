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
- **Peers never ragdoll.** A remote player's death is invisible — they stop, then reappear at their
  checkpoint. Fixing it needs a death event on the wire, which is one flag, plus each viewer seeding a
  ragdoll from *its own* interpolated pose for that peer. Not built.

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

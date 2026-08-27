# ADR 0059 — The player is in the component system

Status: accepted. `ModeDescriptor.player` attaches components to the local character, `CharacterAccess` is a
read-and-push surface, `Death` is the first of them, and the editor now play-tests on the real camera.

## Context

ADR 0058 gave a component a verb over its own node. That covers a level: a pad you touch, a door that opens.
It does not cover an **ability the player has**, because the player was not in the system at all.

Components attach to level nodes. The character was a capsule plus `stepCharacter`, and the only thing in
`Ctx` that could touch it was `character.launch(speed)` — one number, vertical, consumed, added for a
trampoline (ADR 0032). So a rope that pulls you round an arc, a dash, a wind volume: none of them had anywhere
to live *or* any way to act.

Kodjo's framing is what settled the shape, and it is worth recording because it is the reverse of where this
started. Asked what a character should be made of, he refused the question: a tic-tac-toe game has no
character, or one that is pure data; a racing game's is a car; a card game's is a card. **The platform must not
know what a character is made of.** So the character is not a special-cased shape to be widened — it is a
thing that carries components, and the blocky humanoid is one game's choice.

## Decision

**Components can be attached to the player, declared by the game, and they can read and push the character.**

### `ModeDescriptor.player`

A list of `ComponentData`, validated by the same registry as everything else. A level authors the world; it
does not author who is playing, so this is the game's and not the level's — that difference *is* the difference
between a pad you touch and an ability you have.

The runtime builds them from a synthetic `WorldNode`, so a component on the player sees the same `Self` as one
on a platform. Three things about that node are deliberately different, all documented where they bite:

- **It owns no colliders**, so `onContact` never fires on it. A hazard the player walks into fires on the
  *hazard*, which is where the rule was authored.
- **`node.position` is where it spawned**, because a `WorldNode`'s position is load-time data. The live answer
  is `ctx.character.position()`.
- **`self.offset` is `undefined`** even for a component declaring `moves`. The character is a controller
  resolved against the world, not a frame the loader poses; it moves by asking `ctx.character`, and driving it
  through the frame tree would bypass depenetration and snap-to-ground entirely.

They attach **after** every level node, so within one tick the movers have moved and the rules have fired by
the time an ability runs.

### `CharacterAccess` is a real surface

`launch` was the whole of it. Now: `position()`, `velocity()`, `carry()`, `grounded()`, `launch(speed)` and
`push(v)`.

Accessors rather than fields, because the state underneath mutates every tick and a snapshot would be stale
the moment a component held it. Structural over a `CharacterLike`, so `@mp/components` still does not import
the controller and cannot end up in a cycle with it.

**`push` accumulates within a tick where `launch` takes the max.** Two shoves from different directions have a
meaningful sum; two competing *heights* do not, and "strongest bumper wins" is the rule that cannot surprise
anybody.

### `CharacterState.impulse`

`push` writes a pending `impulse: Vec3` that `stepCharacter` consumes — `launch` generalised to three axes.

Why it goes through the step rather than onto `vx`/`vy`/`vz` from outside is `launch`'s reason unchanged:
leaving a surface is five decisions and not one. It is applied **after** the horizontal solve, in the same
place and for the same reason as a departing mover's velocity — earlier, and the ground brake eats most of a
flat impulse on the tick it lands. `vyStart` moves with it so the trapezoid integration stays exact.

**An upward impulse leaves the surface; a flat one does not.** A ground dash should keep its footing and let
friction spend the burst over the following ticks. Anything with a positive `y` has to release the ride or it
is discarded outright, because a rider's vertical belongs to the surface and `desired.y` ignores `vy`
completely while riding. An upward impulse also clears `jumpCut`, since letting go of the button must not
cancel a pull the world gave you.

Zeroed **in place** rather than replaced, so `push` can add into the same object and several components in one
tick all land. Inert at zero: all 119 character tests passed unchanged.

### `Death` — the first player component, and it has no hooks

The reaction, not the rule. The rule was already a component: a `Hazard` fires `effects.kill` and the game's
session decides whether it counts. What stayed hardcoded in the shared client was everything after — the rig
falls apart, you wait for a click, the body drops back two parts at a time on fixed timing — and every game got
the same one.

**It is data the client reads**, the same arrangement as `Collider` and `Renderer`, which are components the
*loader* reads. It has to be: a ragdoll is ten dynamic Rapier bodies and ten Three meshes built from the rig's
live pose, so a headless component cannot produce one. It does not need to — the client already knew the death
happened; what it lacked was the game's opinion about it.

Parameters are `ragdoll` plus the three assembly timings, defaulted to exactly what the client hardcoded, so a
game that says nothing dies the way it always did. `ragdoll: false` is the one genuinely new behaviour, and it
is the off-switch a game whose character is not a jointed figure needs.

Declared by **swing** and the **template**, deliberately not by parkour: that leaves a live A/B between the
declared path and the `mode.player === undefined` fallback, and the two have to look identical.

### `attachesTo`

`ComponentDef.attachesTo?: 'node' | 'player'`, default `'node'`. Both of the editor's Add Component menus go
through `Doc.canAdd`, so one check there stops either of them offering a death reaction for a staircase.

Not enforced at load: a hand-edited level naming one is not a file that fails to open. It decides what a tool
*offers*, which is the same standing `singleton` has.

### The editor play-tests on the real camera

Not strictly part of the player work, and found by checking a claim of my own that turned out to be false.
ADR 0056 recorded the editor's play-in-place camera as `OrbitControls`. It was not: `OrbitControls` is the
*edit* camera, and play mode had a **third** hand-written third-person camera — its own yaw and pitch, a fixed
distance, `lookAt` instead of a boom, no zoom, and no occlusion at all.

So every camera fix since ADR 0055 — the see-through hole, the below-the-feet rule, the three sightlines down
the body — was invisible in the one place you would go to check whether a level plays well.

It is `@mp/camera` now, the same object the game builds, with the two physics queries handed in over the play
world and the cutout mask passed to the play view. Built once rather than per play, so zoom and pitch survive
stopping and starting, and because the mask clones a material per occluder. The edit view still gets no
cutout — it would clone materials for a camera nobody is playing through.

## Consequences

- An ability the player *has* is expressible. What it can do is read the character and push it; what it cannot
  do is anything about presentation, which is the next seam (see Known open).
- `ModeDescriptor` grew one optional field and `Ctx.character` grew five methods. Nothing else in the
  descriptor changed, and no game had to.
- The editor's play-test and the game now share the camera, so camera feel is judgeable in the editor for the
  first time.
- `@mp/components` gained `PLAYER_COMPONENTS` beside `GAMEPLAY_COMPONENTS`, because the two are offered in
  different places — one in an editor menu, one in a descriptor.
- 984 tests, up from 976: eight on the access surface and the player entity.
- ADR 0056's note about the editor using `OrbitControls` for play was wrong and is corrected here. ADR 0057's
  Known open repeated it.

## Rejected

**Making the character a driveable node.** It is a kinematic character controller with depenetration and
snap-to-ground; posing it through the frame tree would throw all of that away. It moves by asking.

**Putting the death reaction in the mode instead of a component.** Behaviour that lands in `ModeDescriptor`
gets taken back out later — ADR 0053 moved `fallY` to a `Hazard`, ADR 0052 moved the rules out of the client.
The traffic only goes one direction, and an intermediate hop into the mode would have been paid for twice.

**A hooked `Death` that causes its own ragdoll.** Needs a host channel for view effects, which is a subsystem
and not a field. The hookless version covers everything that exists today, so the channel waits for something
that genuinely needs it.

**Replacing `launch` with `push`.** `launch` is the max-wins rule with a documented reason and tests; `push`
adds. They are different contracts and folding them would have changed bumper behaviour to buy nothing.

**Inventing a timed respawn** while making death authorable. `respawnOn: 'click' | 'timer'` is a feature, not a
parameterisation of one, and the click is what exists.

## Known open

- **A component cannot ask for anything about presentation.** No camera, no sound, no screen effect. This is
  what blocks a **per-node camera seam** — a trigger that locks the camera for a corridor, which is standard
  platformer vocabulary. It needs either an `Effects`-shaped channel for view requests or the host scanning
  touched nodes for data components, and *which* is an architectural decision, while *what a camera zone
  offers a level designer* is a design one. Both are Kodjo's, and both are why nothing was built for it here.
- **The wire still assumes a body.** Snapshots carry a transform plus a pose per player (ADR 0021),
  interpolation smooths a position, the camera orbits a point. A car or a card fits that; a board does not.
  Player components are local-only — component `state` is never serialized — so an ability is invisible to
  other players until whatever it does goes on the wire.
- **The character still is not data.** `RIG` is 11 hardcoded parts and `CHAR_RADIUS`/`CHAR_HALF_HEIGHT` are
  constants. `spawnFrom(standOffset)` (ADR 0057) and this ADR are the first two pieces of dissolving that; the
  rig itself, and locomotion as a component rather than a shared function, are not done.
- **`ModeDescriptor.tuning` and `standOffset` should eventually be that character's component params** rather
  than the game's fields. Left alone deliberately: moving them is a migration with no new capability in it.

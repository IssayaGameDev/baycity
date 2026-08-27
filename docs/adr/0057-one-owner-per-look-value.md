# ADR 0057 — One owner per look value: post-FX is level data, FOV is a camera parameter

Status: accepted. Post-FX moved into `config.environment`, `fov` joined `CameraParams`, and the spawn
placement every game had its own copy of is shared.

## Context

An audit of the editor and the renderer, looking for things that are hardcoded but should be authorable.

The editor came out nearly clean, which was the surprise: not one hardcoded gameplay component type in
~8,000 lines. The inspector switches on **parameter kind** rather than component type, gizmo colours come from
`mode.gizmos[c.type]`, the Add Component menu comes from the registry, and its play-test already runs
`mode?.tuning`. A new component gets an inspector, a gizmo and a menu entry with no editor change at all.

The renderer was not clean, and the shape of the problem was the same one ADR 0048 had already fixed once for
lighting: **a look value with no owner, copied into every app that needs it.**

- `createPostFX` was called with hand-written options in three places, and they had **drifted**. The editor and
  the viewer asked for `bloomStrength: 0.3`; the game asked for `0.1`. The tools did not show what you would
  play, and nothing compared them.
- `applyGreyboxEnvironment` was given `shadowRadius: 40` by both tools and `30` by the game. Same again.
- The game's debug pane held its *own* `{ bloom: true, bloomStrength: 0.1 }` object, so even within the game the
  sliders and the passes were two sources that happened to agree.
- Camera FOV was `60`, hardcoded inside `createThreeStage`, reachable by nothing.

ADR 0048 named this exact failure when it moved lighting into the level: "the parkour debug pane could tune the
sky live but saved nothing, so lighting could be previewed and never authored." Post-FX was sitting in that
state, one file over.

## Decision

**Every value that changes how the game looks has exactly one owner, and it is not a call site.**

### Post-FX is level data

`EnvironmentConfig` gains `postfx: PostFXConfig` — `ao`, `bloom`, `bloomStrength`. Same block as sun, ambient
and sky, for the reason ADR 0048 gave for keeping those three together: they are **tuned against each other**.
Ambient occlusion is most of what gives greybox its form, and bloom only fires on emissive materials, so a level
lit at dusk and a level lit at noon do not want the same numbers. Balancing coupled values across separate
config keys is how they drift.

Optionality stays load-bearing, exactly as ADR 0048 left it: absent is never an error, malformed always is. No
shipped level was migrated, because none had to be — all seven fall back and look the way they did.

`PostFX` gains the shape `GreyboxEnvironment` already had, which is what makes it authorable rather than merely
configurable:

- **`params` is live and public**, and a pane binds to *that object* rather than a copy. A pane bound to a copy
  goes on showing its own numbers after a level loads, so the sliders and the image disagree and nothing says
  which is lying. This is `skyParams`' rule, applied to the same problem.
- **`apply(from)`** assigns key by key from the level, or from `DEFAULT_POSTFX`, then `refresh()`. Never
  replaced, for the same reason: something is bound to it.
- **The GTAO pass is always built**, and switched with `.enabled`. It used to be skipped entirely on
  `ao: false`, which was fine while that was a build-time flag. It is a level's choice now, and levels change
  without reloading the page — a pass that does not exist cannot be switched back on. The two bracket passes
  that hide occluders for the AO prepass (ADR 0055) idle with it.

`DEFAULT_POSTFX` lives in `@mp/render-three`, not `@mp/content`: the schema has no numbers in it, the same split
`SkyConfig`/`DEFAULT_SKY_PARAMS` already uses. A test asserts the defaults are a value the level validator
accepts — otherwise a level saving what it was shown would fail to load, and nothing else compares the two
packages.

The defaults adopted are **the game's** previous numbers, so the game did not change and the two tools moved to
match it. That direction is deliberate: the game is the reference, and a tool that disagrees with it is the
thing that is wrong. `shadowRadius` was fixed the same way but by *deletion* — all three call sites stopped
overriding the renderer's own default, which is the game's 30.

The AO debug checkbox went with this. It was a second flag beside the passes, added by ADR 0055 to tell shading
apart from geometry; the level's `ao` is now the same switch, so the pane binds it directly. The sun-shadow
switch stays, having no level-data twin.

### FOV is a camera parameter

`fov` joins `CameraParams` and `CAMERA_TUNABLES`, defaulted to the 60 the stage hardcoded, so nothing looks
different until somebody drags the slider. It belongs with the camera because it is **feel** — it trades framing
against distortion the way the zoom range does — and the camera is where the rest of the feel lives.

`createOrbitCamera` now takes a `THREE.PerspectiveCamera` rather than a `THREE.Camera`. Every caller passed one,
and the design already assumed it: `PROBE_RADIUS` and `camHideMargin`'s default are both sized against the near
plane's corner at 60°. Those two do **not** follow `fov` — a very wide lens moves that corner outward and wants a
larger hide margin, which is a slider, so it can have one. Applied only when the value changed, since
`updateProjectionMatrix` rebuilds the projection and this moves on maybe one frame in a session.

Deliberately **not** level data. A level dictating your field of view is a different decision from a level
dictating its own light, and nothing has asked for it.

### The spawn placement is shared

`spawnFrom(standOffset)` in `@mp/mode`, replacing the byte-identical copy in `modes/parkour`, `modes/swing` and
`modes/_template` — same marker lookup, same golden-angle fan, same fallback. Three copies meant a fix to the fan
was three fixes, and a new game copied whichever version it started from.

**`standOffset` is a parameter, not an import.** Half a capsule plus its radius is *one character's* answer, and
a game whose character is a different size — or is not a capsule — has its own. Which is also why this takes the
number rather than importing `@mp/character`: nothing in the shared placement knows what the player is made of.

It takes `Pick<LoadedLevel, 'markers'>`, because the markers are all it reads. A `LoadedLevel` still satisfies
`ModeDescriptor.spawn`, and the fan can now be tested without standing up a physics world.

## Consequences

- The editor, the viewer and the game agree about post-FX and about the shadow frustum. The editor's shadows
  and bloom both changed to match the game, which is the first time the viewport has shown what you would play.
- Post-FX is authorable per level, with a Post-FX section in the Environment row beside Sun, Ambient and Sky.
- The game's Render folder and its Camera folder both edit live objects the level writes into, so loading a
  level moves the sliders instead of leaving them stale.
- FOV is tunable at runtime for the first time.
- `@mp/mode` has runtime code and a test file for the first time; it was types only.
- 970 tests pass, up from 958: 8 for the shared spawn, 2 for the post-FX defaults, 2 for the new schema block.

## Rejected

**A separate `postfx` key beside `environment` in `LevelConfig`.** Same mistake as three sibling keys for sun,
ambient and sky, which ADR 0048 rejected for the same reason: these are tuned against each other, so they go in
one block.

**Making `shadowRadius` level data too.** It is coupled to the sun and there is an argument for it, but nobody
has asked to author it, and adding a schema field with no author is what ADR 0052 records deleting. The drift is
fixed either way.

**Making the new-level starter content a mode field.** The audit listed `blankLevel`'s hardcoded ground slab as
per-game. Building it would mean adding a `ModeDescriptor` field no game supplies — precisely the "untested seam
with no callers" ADR 0052 removed. Dropped rather than built. Revisit when a game has a different scale.

**Moving `exposure` into the config in the same pass.** It is hardcoded, but it is not drifted and nothing asked
for it. Deciding a schema in a debug pane is how the settings bag ADR 0053 deleted got there.

## Known open

The audit's remaining findings, none of which this touches:

- **Components cannot move their own node.** `WorldNode` is fully readonly and only `Track` moves anything, as
  `pose = f(t)` evaluated by the loader. A door that opens when touched is not buildable in any game. This is the
  largest gap, and it is a missing verb rather than a missing component.
- **The player is not in the component system.** Components attach to level nodes; the character is a capsule
  plus `stepCharacter`. So an ability the player *has* — as opposed to a pad they touch — has nowhere to live.
  The intended answer is that the character becomes a node with components (locomotion, capsule, rig), which
  dissolves `ModeDescriptor`'s `tuning`, `standOffset` and `spawn` into that character's params. Kodjo's framing:
  a character need not be physical at all, so the platform must not know what one is made of.
- **The wire still assumes a body.** Snapshots carry a transform plus a pose per player (ADR 0021),
  interpolation smooths a position, the camera orbits a point. A card or a car fits that; a board game does not.
  It does not block the component work, and becomes the problem the day a game has no body.
- **Death reaction is hardcoded in `client.ts`** for every game — ragdoll, delay, what the corpse does. Decided:
  it becomes a component on the character, *after* the two items above, and explicitly not moved into the mode
  first. Behaviour that lands in the mode gets taken back out later (ADR 0052, ADR 0053); that hop would be paid
  for twice.
- **The character is not data.** `RIG` is 11 hardcoded parts and `CHAR_RADIUS`/`CHAR_HALF_HEIGHT` are constants,
  while `ModeDescriptor.standOffset` documents itself as existing so a game with a differently-sized character is
  not stuck with the capsule's. That seam does not exist yet. `spawnFrom` above is the first piece of it.
- ~~**The editor play-tests with `OrbitControls`**, not `@mp/camera`~~ — **wrong**, repeated from ADR 0056:
  it play-tested on a *third hand-written camera*, which is worse. Fixed in ADR 0059, which now shares
  `@mp/camera` with the game.
- **No per-node camera seam.** A trigger that locks the camera for a corridor is standard platformer vocabulary
  and has nowhere to live. Sits on top of the two items above.

Dropped from the audit deliberately: a `Goal` rule (`Goal` is a component with no hook and nothing ends a run),
and an explicit checkpoint ordering parameter (tree order works). Both Kodjo's call.

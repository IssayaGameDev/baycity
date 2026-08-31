# ADR 0062 — The humanoid is one avatar, and the tick is the platform's

Status: accepted. `@mp/character` is `@mp/humanoid`, its files are named for what they are, and
`TICK_RATE_HZ`/`TICK_DT` live in `@mp/core`.

## Context

Kodjo's reading of the codebase after ADR 0061, and it is correct: the layout still says the platform has one
character, while ADR 0059 had already decided the platform must not know what a character is made of. The
decision was made and the file names never heard about it.

`@mp/character`'s own header read "kinematic character-controller library (stack-level, mode-agnostic)". It
was neither. What was actually in it:

- `RIG` and eleven `PART_NAMES` — a blocky biped, in a file called `rig.ts`
- `createAnimator`, `GaitTuning`, `DEFAULT_GAIT` — a bipedal walk / run / idle / air cycle for *that* rig, in
  a file called `animate.ts`
- `stepCharacter`, `CHAR_RADIUS`, `CHAR_HALF_HEIGHT`, `DEFAULT_TUNING` — a capsule ground controller for a
  third-person camera, in a file called `character.ts`
- `TICK_RATE_HZ` and `TICK_DT` — **the simulation tick**, which is nothing to do with characters

Every name claimed the general case and delivered one specific answer. `animate.ts` is not animation, it is
one gait. `rig.ts` is not rigs, it is one skeleton. Kodjo called the tick constants the big oversight, and
they were: the editor, the viewer and the game client all imported a package called `character` to find out
how fast the world runs, and a game with no character would have had to as well.

Measured before deciding: 18 files import the package; only 3 outside it use the tick constants.

## Decision

**A rename, not a split. And the tick belongs to the platform.**

### `TICK_RATE_HZ` and `TICK_DT` → `@mp/core`

Beside the things that already keep time against them: `createSimClock` slews to this rate,
`startFixedLoop` runs at it, and the local controller render-interpolates between its ticks.

One number for every game, deliberately. A per-game tick rate is not a knob this stack has — peers share a
room and a synced clock (ADR 0006), and movement-base indices are assigned per tick (ADR 0021), so two games
at two rates would not be two games, they would be two protocols.

### `@mp/character` → `@mp/humanoid`

A rename rather than the split first proposed, because the measurement said there is **no residue**:

- `solveTwoBone` has exactly one caller, the gait. It is the gait's IK helper, not general-purpose maths.
- `PlatformFrame`, `PlatformPoseLookup` and `MovementBase` are used outside the package by exactly one file,
  `@mp/mode` — see Known open.
- The `Pose` the editor imports is `@mp/content`'s keyframe pose, not the rig's. A loose grep suggested
  otherwise and was wrong.

So keeping a general `@mp/character` behind a specific `@mp/humanoid` would have created a package holding two
types and one function, and would have implied a shared abstraction nobody has designed. When a second avatar
exists, what they share will be obvious. Guessing now is how the misleading names got here.

Files renamed to what they are: `humanoidRig.ts`, `bipedGait.ts`, `groundController.ts`. Each header now says
"**one** skeleton", "**one** gait", "**one** ground controller", and says what it assumes — the controller
assumes a capsule, a ground plane, two horizontal axes and a jump button.

**A game opts in by depending on the package.** That is the whole point of the name: parkour and swing list
`@mp/humanoid` because they want a blocky third-person biped, and a 2D game or a board game does not, so the
platform never hands them one. Before this it was structurally impossible to tell whether a game had chosen
the humanoid or merely inherited it.

### What this is not

**A pure move.** No behaviour changed, nothing was redesigned, and 1005 tests pass unchanged — which is the
whole verification. `CHARACTER_VERSION` became `HUMANOID_VERSION` and had no readers.

## Consequences

- 39 files touched: the package's own manifest and internals, 18 importers, and 9 `package.json` dependency
  entries. A game's dependency list now names the avatar it chose.
- The dependency `@mp/humanoid` → `@mp/components` (from ADR 0061's `createLocomotion`) stays acyclic;
  components never imports the humanoid, which is why `CharacterLike` was structural.
- Nothing imports a character package to get the tick rate any more.

## Rejected

**Splitting out a general `@mp/character` or `@mp/rig`.** Measured and rejected: there is nothing general in
there yet. See above.

**Doing the `ModeDescriptor.tuning` / `standOffset` migration in the same change.** I said this would have to
come along, and then found it cannot cheaply: removing `tuning` from the descriptor leaves the debug pane's
live binding with nowhere to go, and inventing that route is a feature rather than a move. Splitting it out
keeps this change verifiable by tests alone.

**Renaming `CharacterState`, `CharacterTuning`, `addCharacter`, `stepCharacter`.** They are the *ground
controller's* types and arguably want `Humanoid`-shaped names, but renaming them touches every call site and
every test for no structural gain. The file and package names carry the honesty; these can follow whenever
something else takes them.

## Known open

- **`@mp/mode` depends on `@mp/humanoid`**, and that is the remaining leak. `ModeDescriptor.tuning` and
  `standOffset`, and `PlayerHost`'s `character` / `tuning` / `platforms`, are all typed against this one
  avatar — so the platform's own game-contract package says every game contributes humanoid tuning. The cause
  is upstream and already recorded (ADR 0061): the shared client still *creates* the body with
  `addCharacter`, so the platform genuinely does own a capsule. Fixing the type edge without fixing that
  would be cosmetic.
- **The gait still cannot be told about a game's own state.** `AnimationInput` is six fields, all derived from
  `stepCharacter` — so a game with its own locomotion gets a run cycle while it swings on a rope. This is the
  animation half of ADR 0061 and needs the same three moves: widen the input, add the seam, make the shared
  one a default a game attaches.
- **The gait is not per-game either.** `client.ts` still holds one `{ ...DEFAULT_GAIT }` for every game;
  `ModeDescriptor` has no `gait` field. That one is twenty minutes and has been open since ADR 0056.
- **`@mp/render-three/characterRig.ts`** realizes this specific rig and is named as generally as the file it
  came from. Left alone here to keep the change one package wide.

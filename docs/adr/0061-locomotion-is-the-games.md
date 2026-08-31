# ADR 0061 — Locomotion is the game's

Status: accepted. `stepCharacter` is a component each game attaches, `InputCommand` carries the game's own
actions, and the runtime has a movement slot for the moment locomotion has to run in.

## Context

ADR 0059 put the player in the component system, and the question that followed was whether Swing could have
its own controller. It could not. `ModeDescriptor.tuning` changed the *numbers* and nothing changed the
*mechanics*: `stepCharacter` was one function every host called directly, so every game on the platform moved
the same way with different constants.

An audit of what "different movement" would actually touch found five layers, not one, and two of my own
claims about them were wrong:

- **The controller.** One shared function, called from the tick of both hosts.
- **The input command.** `{ moveX, moveZ, jump }` — two world axes and a button, which is a third-person
  platformer's whole vocabulary and was therefore every game's. I said this was also the wire shape; it is
  not, and its own doc says so: a client-authoritative client sends its resulting *position* (ADR 0011), never
  its input. It was in `@mp/net` only because an earlier design was going to transmit it.
- **The local controller.** `step(moveX, moveZ, jump?)` — the same assumption again.
- **The body.** I said a different shape was inexpressible. Also wrong: `addCharacterWith` already spreads
  over `radius` and `halfHeight`. Nothing used it.
- **The input mapping.** `createInputs` rotates WASD through the camera's yaw and demands pointer lock.

Kodjo's framing settled the shape, and it corrected mine. I had presented "the game supplies the access its
component needs" and "it is still a component" as a trade-off, with a widened `Ctx` as the price. They are not
in tension: the game builds its own definitions, so it can close over anything it likes, and `Ctx` does not
have to grow a field per capability at all.

## Decision

**A game attaches its locomotion. The platform provides the moment, not the movement.**

### `InputCommand.actions`

A `ReadonlySet<string>` of game-defined action names, beside the existing three fields. Names rather than more
fields, because the platform has no business knowing them: `ModeDescriptor.actions` maps action name →
physical key `code`s, a host fills the set from that, and the game's own component reads back the names it
declared. Nothing in between needs a list.

Optional, so the three existing fields stay the whole of an ordinary command and no existing caller changed.
Held-this-tick rather than pressed-this-tick: a press that must survive being shorter than a tick is what
`jump`'s buffer inside `stepCharacter` is for, and a game wanting the same does the same in its own component.

`actionsHeld(bindings, keys)` is shared by both hosts from `@mp/mode`, because a second copy of a mapping is
how the editor and the game came to disagree about post-FX (ADR 0057). It is also the only DOM-free part of
the input path, so it is the part with tests.

**`InputCommand` moved to `@mp/core`.** It was never a network type. Leaving it in `@mp/net` would have meant
the component system naming it by depending on the netcode, which is backwards. The move also took
`@mp/character`'s dependency on `@mp/net` away entirely — the controller no longer imports the transport.

`LocalController.step` takes a command instead of `(moveX, moveZ, jump?)`. Positional arguments do not survive
a fourth thing.

### The movement slot

`ComponentRuntime.locomote(tick, timeMs, dt, cmd)`, running a new `onLocomote` hook and nothing else.

Its own call rather than part of `fixedUpdate`, because it is a different **moment**. The host's tick is
two-phase: clock-driven pieces move, the world half-steps, the character resolves against where they are
*now*, and the world half-steps again. `fixedUpdate` runs before all of that (ADR 0058), so locomotion placed
there would resolve the character against last tick's platforms — which is the platform-carry jitter the
two-phase step exists to avoid.

So this is the one thing the platform genuinely has to own: not what movement is, but when it happens.

### Locomotion is a component the game builds

`createLocomotion(deps, type?)` in `@mp/character` returns a `ComponentDef` whose `onLocomote` calls
`stepCharacter`. **A move, not a rewrite** — `stepCharacter` is untouched and its 119 tests pass unchanged.
What changed is who decides to call it.

`ModeDescriptor.playerDefs?: (host: PlayerHost) => readonly ComponentDef[]` is the seam. A host calls it when
a level is joined and passes the result as `PlayerEntity.defs`, which the runtime tries before the registry
and only for the player. That is what lets a definition close over the live character, which does not exist
when the registry is built.

`PlayerHost` is deliberately small — the character, the tuning, the level's platform poses — because those are
the things the *host* owns. Anything else a game's component needs, the game closes over itself, since the
game is what runs `playerDefs`. That is the whole of "the game supplies its own access", and it is why `Ctx`
gained nothing.

The registry still holds a `LOCOMOTION_DEF` with nothing bound: that is what a tool validates against, and a
registry listing everything the game uses is the point of having one. Only the closure differs, so the two
cannot meaningfully drift.

**No parameters, deliberately.** Making `CharacterTuning` the component's params is the obvious move and is
wrong today: the debug pane is bound to the mode's live `tuning` object, so params would be a second source
for the same fourteen numbers and they would drift — the exact failure ADR 0057 exists to have fixed once.
Tuning arrives through `deps` as the one source it already is. Moving it into params needs the runtime to
expose a live instance's params first, and is its own migration.

`type` is a parameter, so a game names its own: two games with different locomotion both showing as
`Locomotion` would be two things wearing one name.

## Consequences

- A game can have different **mechanics**, not just different numbers. Swing can write its own locomotion,
  attach it, and share nothing with parkour but the tick it runs in.
- **A game that attaches none does not move.** The editor's play-test used to fall back to `DEFAULT_TUNING`,
  quietly play-testing parkour in a level belonging to another game; now there is nothing to ask and nothing
  happens, which is the honest answer.
- `@mp/character` depends on `@mp/components` now, and no longer on `@mp/net`. Acyclic — components never
  imports character, which is why `CharacterLike` was structural.
- Parkour, Swing and the template each declare `Locomotion` alongside `Death`. Behaviour is identical: this
  was a move.
- 1005 tests, up from 991.

### One bug worth recording

`defineComponent` decided data-or-behaviour from a **hand-written list** of hook names, so the first component
carrying only `onLocomote` looked like data and the runner skipped it entirely. Silent, and indistinguishable
from the hook never firing. Both sides read `HOOK_NAMES` now, and a test builds a component per hook name and
asserts each one counts — so the next hook cannot ship the same way.

## Rejected

**Locomotion as a `ModeDescriptor` field** — a function the game supplies. Simpler, and it is behaviour in the
mode, which we have twice paid to take back out (ADR 0052, ADR 0053). The traffic only goes one way.

**Threading a generic through the component system** so `Ctx` could carry a game-typed access bag. Invasive,
and unnecessary once the game builds its own definitions.

**Module-level mutable state in the game's package** to bind the character. Works, and it is the version where
two sessions in one tab would quietly share a character.

**Making `CharacterTuning` the component's params.** See above — it would create the two-sources drift on
purpose.

**More fields on `InputCommand` for each game's actions.** The platform would learn what a dash is.

## Known open

- **The input mapping is still the client shell's.** `createInputs` rotates WASD through the camera's yaw and
  asks for pointer lock, with no way for a game to opt out. A 2D game wants neither. This is the next of the
  five layers.
- **The camera is still orbit-only.** `shot()` (ADR 0060) pins the eye but still tracks the player, and
  `createThreeStage` hardcodes a perspective camera, so an orthographic side-on view is not expressible.
- **The body is still the shared client's.** `addCharacter` is called by the host, so a game attaching no
  locomotion still gets a capsule and a rig standing where it spawned. A game with no character at all — a
  board game — needs the client to stop owning the player entirely.
- **`ModeDescriptor.tuning` and `standOffset`** should end up as that character's component params. Blocked on
  the pane binding, above.
- **The animator still reads character state**, so a game with its own locomotion gets the humanoid gait fed
  from fields it may not use.

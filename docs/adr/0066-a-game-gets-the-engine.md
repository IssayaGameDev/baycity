# ADR 0066 — A game gets the engine, not a hook per idea

Status: accepted. `PlayerHost` carries the physics world and the level; `startTpsClient` returns the scene, a
per-frame hook, the world-space rig parts, the camera, the world and the level.

## Context

ADR 0065 left one question open: what does it actually cost to build something the platform has no concept of?
Three answers were given to it during the same session and all three were wrong — "about 700 lines", "two
accessors", "three doors" — because each was a guess about the *shape* of the gap rather than a trace of a
feature through the code.

So the swing rope was traced, need by need, against what exists:

| Need | Before this ADR |
| --- | --- |
| Logic every tick, state kept between ticks | ✅ its own component + closure |
| Read and move the capsule | ✅ `PlayerHost.character()` → `body.move` |
| Replace walking with a pendulum while swinging | ✅ the game owns `onLocomote` (ADR 0061) |
| Cast to find an anchor | ❌ no world — though `castSphere` exists |
| Is that surface tagged? | ❌ no level — though `nodeOf(collider)` exists |
| Draw a rope | ❌ no scene |
| **Redraw it every rendered frame** | ❌ **no such seam anywhere** |
| Attach it to the drawn hand | ❌ no rig pose |
| Peers see where it is anchored | ❌ real bytes on the wire |
| Camera behaves differently mid-swing | ❌ no camera |

**Half of it already worked**, including the one that looked least likely: ADR 0061 handed the game the whole
movement slot, so a pendulum integrator needs nothing new.

The gaps turned out to be three different kinds, which is the finding:

- **Access** (world, level, scene, rig parts, camera). The object exists and works; nobody passes it.
- **Structural** (the per-frame hook). Every component hook is fixed-tick by design. There was no render-frame
  seam for game code anywhere in the codebase, and `ThreeStage.setRenderStep` *replaces* rather than adds — the
  nametag pass already holds it (ADR 0065).
- **Budget** (a peer's anchor). A `Vec3` on every snapshot at 20 Hz. Kodjo's call, not a technical one.

## Decision

**Hand over the engine's own objects. Do not add a concept per idea.**

This is not the pattern ADR 0065 was written to stop, and the distinction is the whole point:

- A field on `ModeDescriptor` means *the platform now knows about your feature*. `states`, `animator`, `gait` —
  each taught the platform a new concept, and the next idea needed another. That is how it reached 15 fields.
- Handing over the Rapier world and the Three scene teaches the platform **nothing**. A rope, a grapple, a
  portal and a laser all want `castSphere` and "put this in the scene", and the stack holds no concept of any
  of them.

### Simulation: `PlayerHost` gains two

`world: () => PhysicsWorld | null` and `level: () => LoadedLevel | null`. Getters, like the rest, so a component
built before a respawn cannot capture a stale one.

`@mp/mode` took `@mp/physics` as a dependency for it. **Not a new coupling**: `character()` already returns a
`CharacterState` whose `body` is a physics type, so this contract always leaked physics. It is now honest.

The **editor fills both too**, from its play-test's real world and real level, so a game's component behaves the
same in play-in-place as in the game. Anything it *draws* will not appear there — the editor has no frame hook
to offer — which is the known limit.

### Drawing: `startTpsClient` returns the keys

`scene`, `onFrame`, `partsOf`, `camera`, `world`, `level`, `id` — beside `dispose`.

**Growing a return value is not the smell that growing an options bag is.** An option is a game declaring a
feature to the platform. A return value is the platform handing over what it built.

`onFrame` runs at the **end** of the frame — after the level is posed, every body is drawn and the camera is
placed — so `partsOf` and `camera` answer for this frame rather than the last.

`createFrameHooks` is its own function with its own tests, because the iteration rule is the whole of it and
fails silently: a hook that **removes itself while running** (a rope that lets go) would, over a live `Set`,
skip whatever came next. That reads as a second effect flickering, not as a bug in the registry.

### The probe found a real gap in this ADR's own API

The handle first exposed was `poseOf`, which is joint-**local**. There was no way to put a line's end on a hand,
because only `@mp/tps` knows the position a rig was last *drawn* at. It became `partsOf` — world space, via the
`last` position `CharacterViews` already keeps for motion differencing.

That is the argument for the probe existing at all: five accessors built against a traced feature, with nothing
using them, would have shipped with this bug in it.

## Consequences

- A rope is now ordinary game code in `modes/swing`, except for peers seeing it.
- `modes/swing/src/probe.ts` exercises **five of the six** handles at runtime, behind `?probe=1` so nothing
  about swing changes. It casts up-and-ahead each tick, names the authored node it hit, and draws a line from
  the right hand to it every rendered frame. It is meant to be deleted when a real feature uses the same
  handles.
- `camera` is **not exercised** — nothing a line between two points wants it for, and inventing a use would
  prove less than saying so. Typecheck-proven and no more.
- 6 new tests, all on `createFrameHooks`: delta and order, unregistering, registering twice, a hook removing
  itself without skipping the next, a hook adding one that does not run until next frame, and `clear`.
- All five apps `vite build` clean.

## Rejected

**A `scene` on `PlayerHost`.** It would make `@mp/mode` — the game contract two headless tools consume — depend
on Three. The same mistake as folding `@mp/tps` into `@mp/humanoid` (ADR 0065). Simulation handles go on the
host; view handles come back from the client.

**A `TpsClientOptions.onFrame`.** It would be the sixteenth field, and it would only serve games that call
`startTpsClient`. A returned hook serves any caller.

**Drawing from `onFixedUpdate`.** The whole reason the structural gap is structural: 30 Hz drawing attached to a
per-frame rig visibly comes apart.

**Building the rope now.** Infrastructure and a feature at once is two jobs, and the feature needs design
decisions that are Kodjo's.

## Known open

- **A peer's rope cannot be drawn.** Their anchor is a `Vec3` and nothing carries values (ADR 0064): five
  boolean bits are free, bytes are not. Either the wire widens or peers swing without visible ropes.
- **The editor's play-test cannot draw.** No frame hook there, and it still does not animate at all (ADR 0063).
- **Nothing tracks what a game adds to the scene.** `dispose` releases what the client made; a game's own
  objects are the game's to remove. The probe returns its own remover, which is the pattern.
- **No arbitrary cast shapes.** `castSphere` and `sphereOverlaps` are what the physics package exposes; a
  capsule or box sweep would need adding there.

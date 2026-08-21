# ADR 0056 — The game client is a package, not a game's `main.ts`

Status: accepted. `@mp/camera` and `@mp/game-client` have both landed. `client.ts` was **moved, not
redesigned** — breaking it into scene / netcode / render modules is a follow-up, now safe to do incrementally
because callers only see `startGameClient`.

## Context

ADR 0052 made a game one `ModeDescriptor`: its component registry, character tuning, gizmo colours, spawn
and rules `session`. That seam works — the editor discovers a game by globbing `modes/*/src/editorMode.ts`,
the server is generic, and `rules.ts` is headless so a tool can play-test a game without a second copy of its
logic.

What it did not cover is the **client application**. `modes/parkour/src/main.ts` reached 1487 lines, and
almost none of it was parkour: the Three stage and post-FX, asset preload, joining a room, interpolation,
peer views, nametags, the ragdoll and spawn assembly, the pause screen, the debug pane, touch wiring, the
render loop, and the entire camera.

Nothing forced the split, because there was one game. Kodjo asking for a second one is what made the cost
visible: copying that file means every fix to it gets made twice, and this repo had just spent a long session
on the camera alone (ADR 0055).

## Decision

**A game owns its rules, its look and its level list. The stack owns the client.**

Which is dependency law 3 — "modes are thin compositions" — applied to the thing that was exempt from it.

### `@mp/camera`

The third-person camera (ADR 0020 + ADR 0055): boom, zoom, occlusion, the see-through hole, the landing dip,
and whether the player's own rig is inside the lens. Roughly 300 lines that were in a game's composition
root.

Two rules shape its surface, and both are what make it testable:

- **No DOM.** The host owns pointer lock, wheel events and touch, and calls `lookMouse` / `lookTouch` /
  `zoomNotch` / `zoomPinch`. The camera keeps the sensitivities, because those are feel and belong with the
  rest of the feel, but it has no opinion about input devices.
- **No physics import.** `observe(queries)` takes the two casts it needs. The world does not exist when the
  camera is built — the local sim arrives with the first snapshot — and injecting them is what lets the
  occlusion decision be tested against slabs on a number line, which is how the ADR 0055 rules are covered.

`update(dt, body, setOccluders)` places the camera around the capsule's centre and returns whether the rig is
drawable. The host still decides *that*, because death and the spawn assembly also have a say.

**The tunables are data**, not a UI. `CAMERA_TUNABLES` is a list of `{ key, label, min, max, step }` and the
host builds whatever pane it has, so the camera does not depend on Tweakpane and a new parameter cannot ship
without a slider. A test checks every key against `DEFAULT_CAMERA_PARAMS`, since a list of names beside the
thing it names can drift.

`cameraOcclusion.ts` moved here as `occlusion.ts` with its 16 tests unchanged.

### `@mp/game-client`

`startGameClient(descriptor)` is the whole surface. A game supplies its `ModeDescriptor` and an
`index.html` with a `#view` canvas and a `#status` line; the stack supplies the Three stage, the post-FX,
the asset preload, joining a room, interpolation, peer views, nametags, the ragdoll and spawn assembly, the
pause screen, the debug pane, touch, the camera and the render loop.

The descriptor is the whole of what varies: its registry validates and instantiates the level, its tuning
drives the controller, its `session` is the rules, its `spawn` places arrivals, and its **name** picks both
the level list and the save key.

Two things had to change beyond moving files, and both were seams that only made sense for one game:

- **`ModeDescriptor.spawn` takes an optional `seed`.** Parkour had a second exported `spawnFor` for it,
  because a client spreads several arrivals around one marker and a tool places exactly one body. That is one
  function with an optional argument, not two.
- **`localParkourPersistence` became `localProgress(mode)`**, keyed by the game's own name. Two games in one
  browser sharing `parkour.state` would let a checkpoint in one resume a run in the other. Tested.

**Level and asset bundling moved too.** Both use `import.meta.glob`, whose paths resolve relative to the
file — and a package's `src` sits at the same depth as a mode's, so the globs find exactly what they found
before. `levelsFor(mode, registry)` replaces a module-level `MODE_NAME`.

## Consequences

- **`modes/parkour/src/main.ts` is 12 lines**, from 1487. The mode is six files: the descriptor, its rules,
  that composition, and three test files guarding its own rules, levels and asset references.
- Its `package.json` went from 12 workspace dependencies to 8. A game no longer depends on `@mp/client`,
  `@mp/net`, `@mp/render-pixi`, `@mp/i18n`, `colyseus.js` or `tweakpane` — it cannot reach the netcode or
  the UI toolkit, which is the dependency law made structural rather than advisory.
- `client.ts` is 1239 lines in one function. That is the cost of moving without redesigning, taken knowingly.
- The debug pane's camera block went from 16 hand-written bindings to a three-line loop.
- `@mp/camera` imports both `@mp/render-three` and (structurally) physics's query shapes without depending on
  the package. It is browser-side view code, so this breaks no dependency law: simulation still never imports
  rendering.
- The editor could use this for its play-in-place camera, which today is `OrbitControls`. Not done, not
  needed, worth knowing.

## Rejected

**Folding the shell into `@mp/client`.** That package is the netcode client — local sim, interpolation, clock
sync, input — it is headless-capable so bots can use it, and it has real unit tests. Dropping an application
into it would break the one property that makes it useful to a bot.

**Copying `main.ts` for the second game and extracting later, with two data points to compare.** The usual
advice, and wrong here: the file's churn is concentrated in exactly the part that is not game-specific, so
the copy would start diverging on the first camera fix.

**Leaving the camera in the mode and extracting only the netcode.** The camera is the piece with the most
change traffic and the piece a second game would most obviously want identical.

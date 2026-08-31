# ADR 0065 — A game composes the client, instead of being called by it

Status: accepted, landing in phases. **Phase 0 only** is built: every allocator in `@mp/game-client` owns its
release, and `startGameClient` returns a `GameClient` with `dispose`.

## Context

`startGameClient` (ADR 0056) is an inversion-of-control framework: it defines what a game *is* and offers a
hook per part that may vary. Measured against that shape, on 2026-08-31:

- `ModeDescriptor` had **8 fields**. It has **15**. Six of the seven added in one session are optional hooks.
- `client.ts` is **947 lines** and owns the scene, camera, input, netcode, render loop and player.

The pattern holds while the framework's model of a game matches the game. It fails whenever a game wants
something the framework has **no concept of** — a rope has no platform rope to vary — and then the only move
available is a sixteenth field. Every fix in ADRs 0058-0064 was that move.

Reading the file settles what the split actually is. It is not platform-versus-game; it is four groups:

| Group | What | Lines |
| --- | --- | --- |
| Platform | clock sync, snapshots, room, codecs, fixed loop, level instantiation, physics world, assets | ~180 |
| Plumbing | canvas, renderer, post-FX, input, status line, pause overlay, resize | ~200 |
| **The third-person humanoid game** | rigs, nametags, ragdolls, peer corpses, spawn assembly, orbit camera, occlusion queries, landing dip, touch HUD, own-rig visibility | ~450 |
| Wiring | the tick body, the render body, what to send | ~120 |

**The third group is a game wearing the platform's clothes.** Half the file is what a blocky third-person guy
does, and that is precisely why the descriptor grew a knob per humanoid feature: there was no way to *import*
the humanoid game, so every one of its parameters had to be punched through the framework as a field.

Three consumers already want those pieces without the framework. `tools/editor/src/main.ts` is 3031 lines and
imports `@mp/humanoid` and `@mp/camera` raw, hand-rolling its own play-test; the viewer does the same;
`packages/game-client/src/index.ts` says so in its own doc.

## Decision

**A game assembles the client from parts, rather than handing over a descriptor and being called back.** The
framework keeps only what has to be uniform *across clients in a room* — tick rate, wire format, level schema,
snapshot interpolation — because that is what agreement is actually required for. Everything else becomes a
thing a game calls.

Landing in phases, each ending runnable:

| Phase | What |
| --- | --- |
| **0** | Every allocator owns its release; `startGameClient` returns a handle. **Built.** |
| 1 | Group three extracted to `@mp/tps`. A move, not a rewrite; the descriptor is untouched. |
| 2 | Groups one and two extracted as services, each with its own teardown. |
| 3 | Inversion. `_template/main.ts` composes; the descriptor drops to ~6 fields. |
| 4 | Swing's rope, as the acceptance test: game code touching Three and Rapier directly, no new field. |

Phase 4 is the gate on phase 3. If the rope needs a sixteenth field, phase 3 was wrong.

`@mp/tps` is a **separate package** rather than folded into `@mp/humanoid`, because `@mp/humanoid` has no
Three.js in it at all — its dependencies are `@mp/components`, `@mp/core`, `@mp/physics`, and that is why nine
things import it cheaply, including two headless tools. Group three is entirely Three.js. Math on one side,
pixels on the other, is the line that already exists and is worth not crossing.

### Phase 0: teardown

`GameClient.dispose` is ordered deliberately rather than by unwinding creation, because creation order is
wrong here: the world is built inside `initLocalSim` long after the render loop starts, so a reverse unwind
would free Rapier's memory while a tick could still read it.

1. Both loops stop. Nothing ticks after this.
2. The room is left, and the ping timer cleared.
3. Listeners come off `document`, `window` and the canvas.
4. Everything drawn is released: rigs, level meshes, lights, loose bodies, overlays, the pane.
5. The renderer, then the physics world — last, because step 1 is the only guarantee nothing touches it again.

Three collaborators gained teardown they did not have. `Inputs` (seven listeners on `window`, `document` and
the canvas, none of them removable before this — added through a local `on` helper that records the removal
call at the point of adding, since `removeEventListener` matches on (type, function, options) and a
re-declared arrow silently fails to match), `CharacterViews`, and `installDebugPane` (which returns a
`DebugPane` now; tweakpane's own `dispose` leaves the host div behind, and the div carries the z-index).

`prune` was leaking a texture and a material per player who left the room: the nametag is added to `rig.root`
after the rig is built, so `rig.dispose()` never knew it was there. Both paths share one `drop` now.

## Consequences

- Nothing calls `dispose`. The page owns the client for its whole life and the browser reclaims everything on
  unload. It is written now because teardown is only cheap while the allocation is being written, and phases
  1-3 move every allocation in this file.
- It is also what a game-to-game swap inside one page needs later, which is not built and not planned.
- `await startGameClient(MODE)` still compiles unchanged in all three games — the return value is ignored.
- **happy-dom** is now a root dev dependency, applied per file (`// @vitest-environment happy-dom`) rather
  than suite-wide, so the other 78 files stay in Node and stay fast. It costs ~1.3 s of setup per DOM file.
- 5 new tests. The views empty their scene and forget their characters; and four on `Inputs.dispose` —
  keys stop being recorded (including the one held at teardown, which would otherwise read as held for ever),
  the camera stops being steered, a second `createInputs` on the same page works while the first goes deaf,
  and a second `dispose` does not throw. Three of the four were confirmed to **fail** with the removal loop
  commented out, which is the only evidence that a teardown test tests anything.
- The "second inputs" test asserts on the **keyboard**, not the camera. Every mouse and wheel handler is gated
  on `document.pointerLockElement === canvas`, so a stale handler fails that check regardless — a camera
  assertion there passes whether the listener was removed or not.

## Rejected

**Keep adding fields.** Field sixteen exists for exactly one idea, like the last seven.

**Fold group three into `@mp/humanoid`.** Nine importers, two of them headless, would drag in a renderer they
never asked for.

**Rewrite in one pass.** `client.ts` has no test at all; a single 947-line reorganization gives a regression
four phases to hide in.

**Hack swing first with direct access, then invert.** The evidence would be real and the work would be thrown
away. Phase 4 gets the same evidence by making the rope the exam instead of the rehearsal.

## Known open

- **`client.ts` has zero tests**, and the 1029 in the suite are all on packages. The gate for phases 0-3
  stays Kodjo playing parkour, swing, the template and the editor.
- **`dispose` is untested end to end**: `startGameClient` needs a WebGL context, which no fake browser has.
- **The nametag leak fix is unverified.** happy-dom implements no 2D canvas context — `getContext('2d')`
  returns null — and the nametag draws text on a canvas. Testing it means the native `canvas` module, which
  needs a toolchain on Windows and is not worth one assertion. The fix is verified by reading only.
- **The debug pane's `dispose` is untested.** It would need a twelve-field fake of the whole client's live
  objects to reach one `pane.dispose()`, and it is dev tooling that no player sees.
- Everything in phases 1-4.

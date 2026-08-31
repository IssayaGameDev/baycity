# ADR 0065 — A game composes the client, instead of being called by it

Status: accepted, landing in phases. **Phases 0, 1 and 2** are built: every allocator owns its release, the
third-person game is `@mp/tps`, and the netcode, the level and the page are three services.

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
| **1** | Group three extracted to `@mp/tps`. **Built.** |
| **2** | The netcode, the level and the page extracted as services. **Built.** |
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

### Phase 1: `@mp/tps`

Two halves, deliberately, because they carry very different risk.

**The move.** Seven files — `characterView`, `pane`, `inputs`, `ragdoll`, `assemble`, `nametag`, `layers`, with
their two tests — relocated whole: 1048 lines, no edits beyond imports. `OVERLAY_LAYER` went sideways to
`@mp/render-three`, because it is an agreement between the two-pass render step (which stayed in
`@mp/game-client`'s scene) and every object that opts into the layer (now `@mp/tps`'s nametag), and those are
different packages now. A second copy of that number is how two halves of one agreement drift (ADR 0057).

`@mp/game-client` stopped re-exporting the character views and the body layers. A game that wants a rig imports
the game that has one rather than reaching through the platform for it.

**The rewrite.** `avatars.ts`: the rigs, the corpses and the spawn assemblies as one module. These were 127
interleaved lines threaded through the tick and the render loop, and interleaved is the point — a corpse
suppresses an assembly, an assembly hides a rig, a death needs the pose the rig was last *drawn* in, and all
three want the same interpolation alpha. Split across a host and a package, the host would have had to know
that order. Kept together, the order is the module.

What is left in `client.ts` is the three questions only a *client* can answer: where a peer is once their base
frame is undone (ADR 0021), whether their dead bit is set, and where the camera ended up. **Nothing in
`@mp/tps` reads a flag byte or a base index.**

`setSelfVisible` is separate from `drawSelf` rather than a field on it, because the camera is placed *after* the
bodies are drawn: folding the camera's answer into `drawSelf` would have hidden the rig on last frame's
placement and flickered. Three things decide whether your own rig is drawn and only one is the client's, so the
`&&` lives in `@mp/tps` and the client passes one boolean.

`world` is a getter because the world arrives with the first snapshot and the avatars are built before it. A
peer who dies before then keeps their rig for a frame, which was already the behaviour.

### Phase 2: three services

`netHost.ts` (171 lines) — the room, the clock, the snapshot stream, the roster, the display name. **This is
the part that genuinely must be uniform**: every client in a room has to agree on the wire format and on what
time it is, or nobody sees anybody in the right place. It is therefore the one piece that stays framework when
phase 3 hands the rest over. It knows a game *name* and a level name, and only as the two matchmaking filters.

Synchronous, with the join in flight, because that is what it was inline: the render loop starts before the
room is joined, and `id()` returning `null` for most of the first second is load-bearing (ADR 0055). Making it
`await` would have been a behaviour change dressed as a refactor.

`levelHost.ts` (104 lines) — instantiate into the world, wait for assets, build the meshes and the content
lights, apply the level's environment and post-FX. Colliders and meshes in **one** call deliberately: two would
let a level be walkable before it is visible, and `addLevel` is synchronous, so the only place to wait for
models is before it. Also platform, because `baseIndex` goes on the wire and only means anything if every
client instantiated the same JSON in the same order (ADR 0021).

`shell.ts` (146 lines) — the 2D overlay, the pause screen, the touch HUD, the pointer-lock handoff, the resize.
Plumbing rather than platform: nothing in it is needed for two clients to agree on anything. It is simply what
any game rendered into a canvas wants, and having it inline is what made `startGameClient` the only way to get
it.

**What was left alone.** `initLocalSim` is still 300 lines in `client.ts`, and that is deliberate: it is the
point where the mode, the avatars, the camera, the input, the netcode and the tuning all meet. Extracting it
would mean a function of fifteen parameters, which is worse than leaving it — and it is exactly what phase 3
moves into a game's own `main.ts`, where all fifteen are local.

`client.ts` 947 → 750 lines.

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
- 14 more tests on `avatars.ts` — the part of phase 1 that was a rewrite, and the part with the most ways to
  be quietly wrong. Every gate in the state machine: a rig left alone while dead, hidden while assembling,
  shown once the body lands, hidden by the camera alone; a death refused before any rig is drawn, happening
  without a ragdoll when the game declared none or before a world exists, dropping one body per part; a peer
  with no world keeping their rig, a peer already dead on join not getting a corpse from a pose that does not
  exist, a corpse cleared and reassembled on respawn, a peer killed again mid-respawn keeping only the corpse,
  and a leaver taking their corpse with them. The physics is a fake world handing out bodies that stay put —
  nothing here asserts on how a part falls, and a real Rapier world would only make it async.
- The peer paths needed a stubbed 2D canvas context to be reachable at all (happy-dom implements none), so
  those tests carry a seven-method fake of what the nametag draws with. That stub does **not** make the leak
  fix testable: it proves nothing about a real texture.
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

- **`client.ts` has zero tests**, and the 1043 in the suite are all on packages. The gate for phases 0-3
  stays Kodjo playing parkour, swing, the template and the editor.
- **`dispose` is untested end to end**: `startGameClient` needs a WebGL context, which no fake browser has.
- **The nametag leak fix is unverified.** happy-dom implements no 2D canvas context — `getContext('2d')`
  returns null — and the nametag draws text on a canvas. Testing it means the native `canvas` module, which
  needs a toolchain on Windows and is not worth one assertion. The fix is verified by reading only.
- **The debug pane's `dispose` is untested.** It would need a twelve-field fake of the whole client's live
  objects to reach one `pane.dispose()`, and it is dev tooling that no player sees.
- **`client.ts` is still 750 lines**, and phases 3-4 are the rest of this ADR.
- **`pnpm -s typecheck` hides recursive errors, and `| head` hides the exit code.** Phase 1 was committed
  (`3c40cbd`) with two unused-import errors in `client.ts` because both were true at once: `-s` suppressed
  `pnpm -r run typecheck`'s output, and piping the command into `head` made the pipeline's status `head`'s. The
  errors are fixed in phase 2. Verify with `pnpm -r run typecheck` and read the exit code — never through a
  pipe.
- **`ModeDescriptor` has not shrunk yet.** Phase 1 deliberately left it alone — nine of its fifteen fields die
  in phase 3, when a game passes them as arguments instead of declaring them.
- The editor and the viewer still hand-roll their own play-test against `@mp/humanoid` and `@mp/camera`. They
  are the obvious consumers of `@mp/tps` now, and neither has been pointed at it.
- Everything in phases 1-4.

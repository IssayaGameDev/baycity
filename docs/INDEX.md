# Docs Index

One hop to any doc. Three layers: **platform** (the shared stack, one file per subsystem, current state),
**games** (one folder per game, one file per system, current state), **ADRs** (why, append-only). What a
system *is* lives in platform/games; why it is that way lives in the ADR the doc cites.

Orient: this file → `platform/README.md` → the game's `README.md` → only what the task needs.

## Platform — `docs/platform/`

| Doc | What |
| --- | --- |
| [README.md](platform/README.md) | The stack in ten lines, dependency direction, this list |
| [workspace.md](platform/workspace.md) | Packages, imports, scripts, ports, adding a package or a game |
| [content.md](platform/content.md) | Node/component schema, prefabs, levels, assets, `content/games/*.json` |
| [components.md](platform/components.md) | Parameter kinds, `defineComponent`, hooks, registries as code + data, built-ins |
| [mode.md](platform/mode.md) | `ModeDescriptor`, `ModeSession`, `PlayerHost`, settings — what a game supplies |
| [netcode.md](platform/netcode.md) | Client-authoritative rooms, tick, wire format, clock sync, interpolation |
| [physics.md](platform/physics.md) | The Rapier wrapper |
| [humanoid/controller.md](platform/humanoid/controller.md) | `CharacterTuning`, `stepCharacter`, caps, envelope numbers |
| [humanoid/gait.md](platform/humanoid/gait.md) | `GaitTuning` by layer, the animator, what a game can override |
| [humanoid/rig.md](platform/humanoid/rig.md) | Parts, constants, `partTransforms`, `partsOf` |
| [client/services.md](platform/client/services.md) | `@mp/game-client`: the services, uniform vs universal |
| [client/tps.md](platform/client/tps.md) | `startTpsClient` options and every `TpsClient` handle |
| [client/input.md](platform/client/input.md) | Keyboard, mouse, touch zones, actions, `InputCommand` |
| [rendering.md](platform/rendering.md) | Stage, post-FX, overlay layer, level view, assets, world labels, Pixi UI |
| [editor.md](platform/editor.md) | What it authors, content API client, locks in the editor, edits as ops, live levels, game discovery, adoption, Play |
| [editor-server.md](platform/editor-server.md) | The content API, Access identity, locks, live documents, session commits, upload, deploy |
| [content-sync.md](platform/content-sync.md) | The live mirror, `content-root.ts`, the `@content` alias, `.env` |
| [tooling.md](platform/tooling.md) | share, bots, netsim, viewer |
| [budgets.md](platform/budgets.md) | The tripwires and how each is measured |

## Games — `docs/games/`

| Game | Docs |
| --- | --- |
| [keyboard](games/keyboard/README.md) | progression, balance, world-1, steps, keycaps, stages-and-wins, pads, hud, debug, known-open |
| [parkour](games/parkour/README.md) | the reference game: checkpoints, goal, hazards |
| [swing](games/swing/README.md) | the rope: a game-owned locomotion and a travelling state |

`modes/_template` is documented in `platform/workspace.md` (how to add a game).

## ADRs — `docs/adr/`

Append-only. Context, decision, rejected alternatives. Titles only here; a doc above cites the number where the
why matters.

| # | Title |
| --- | --- |
| [0001](adr/0001-monorepo-tooling.md) | Monorepo tooling |
| [0002](adr/0002-transport-and-client-clock.md) | Transport implementations and the pre-sync client clock |
| [0003](adr/0003-physics-and-renderer.md) | Physics wrapper and Three.js renderer |
| [0004](adr/0004-prediction-and-netsim.md) | Prediction, reconciliation, and network simulation (superseded by 0011) |
| [0005](adr/0005-predicting-props.md) | Predicting props (superseded by 0011) |
| [0006](adr/0006-clock-sync-and-lag-compensation.md) | Clock sync and lag-compensated hits |
| [0007](adr/0007-delta-and-quantization.md) | Delta encoding, quantization, schema versioning |
| [0008](adr/0008-hud-and-input.md) | HUD (PixiJS) and input abstraction |
| [0009](adr/0009-load-validation.md) | Load validation with headless bots |
| [0010](adr/0010-tps-character-controller.md) | TPS character-controller prototype + pluggable game |
| [0011](adr/0011-client-authoritative.md) | Client-authoritative netcode |
| [0012](adr/0012-roblox-like-character-controller.md) | Roblox-like kinematic character controller |
| [0013](adr/0013-colyseus-rooms.md) | Colyseus rooms foundation |
| [0014](adr/0014-content-pipeline.md) | Data-driven content pipeline + modes layering |
| [0015](adr/0015-ui-rendering.md) | PixiJS for all game UI |
| [0016](adr/0016-localization.md) | Localization (`@mp/i18n`) |
| [0017](adr/0017-convex-colliders.md) | Convex colliders for authored swept surfaces |
| [0018](adr/0018-procedural-character-animation.md) | Procedural animation on a rigid character rig |
| [0019](adr/0019-death-ragdoll.md) | Death is a local ragdoll; spawning assembles the body |
| [0020](adr/0020-camera.md) | Third-person camera |
| [0021](adr/0021-relative-to-base-replication.md) | A rider replicates in its platform's frame |
| [0022](adr/0022-touch-controls.md) | Touch controls |
| [0023](adr/0023-authoring-content.md) | Content is authored in the in-browser editor |
| [0024](adr/0024-editor-ui-shell.md) | The editor's UI is a fixed-panel DOM shell |
| [0025](adr/0025-nested-placement.md) | Instances nest to arbitrary depth |
| [0026](adr/0026-asset-pipeline.md) | Assets are referenced by id; a material is a shader instance |
| [0027](adr/0027-content-is-data-only.md) | Geometry is authored data; the code kit is deleted |
| [0028](adr/0028-materials-replace-styles.md) | `style` is deleted, materials are it |
| [0029](adr/0029-keyframe-tracks.md) | Motion is a keyframe track, edited on a timeline |
| [0030](adr/0030-keyboard-shortcuts.md) | Shortcuts match the character; undo is a snapshot |
| [0031](adr/0031-multi-selection.md) | Multi-selection, with a primary |
| [0032](adr/0032-bumper.md) | A bumper, and triggers that carry parameters |
| [0033](adr/0033-piece-objects-and-prefab-overrides.md) | A piece is an object; a placement overrides it |
| [0034](adr/0034-coyote-time.md) | Coyote time, and two vertical stops |
| [0035](adr/0035-component-system.md) | A node holds components |
| [0036](adr/0036-component-runtime.md) | Components run, deterministically |
| [0037](adr/0037-timeline-edits-a-parameter.md) | The timeline edits a declared parameter |
| [0038](adr/0038-inspector-chrome.md) | The Inspector's chrome is ours |
| [0039](adr/0039-mesh-and-renderer.md) | `Visual` splits into `Mesh` and `Renderer` |
| [0040](adr/0040-context-menus.md) | One context menu |
| [0041](adr/0041-jump-feel.md) | Jump feel |
| [0042](adr/0042-fast-vertical-platforms.md) | Fast vertical platforms |
| [0043](adr/0043-air-control-matches-roblox.md) | Air control equals ground control |
| [0044](adr/0044-standard-bevel.md) | Rounded cuboids at one standard radius |
| [0045](adr/0045-skybox.md) | An equirectangular sky, lossless WebP |
| [0046](adr/0046-procedural-sky.md) | A designed gradient sky; the sun as one input |
| [0047](adr/0047-lights-are-components.md) | A light is a node with a `Light` component |
| [0048](adr/0048-sun-is-a-level-setting.md) | Lighting is level data |
| [0050](adr/0050-tracks-are-offsets-and-assets.md) | A keyframe is an offset; a track can be an asset |
| [0051](adr/0051-dope-sheet.md) | The Animation panel is a dope sheet |
| [0052](adr/0052-a-game-is-a-descriptor.md) | A game is a descriptor the tools take as an argument |
| [0053](adr/0053-the-kill-plane-is-a-component.md) | The kill plane is a hazard |
| [0054](adr/0054-trigger-colliders.md) | A collider can be a trigger |
| [0055](adr/0055-see-through-obstructions.md) | An obstruction dithers away |
| [0056](adr/0056-the-client-is-a-package.md) | The game client is a package |
| [0057](adr/0057-one-owner-per-look-value.md) | One owner per look value |
| [0058](adr/0058-components-can-move-their-node.md) | A component can move its node |
| [0059](adr/0059-the-player-is-in-the-component-system.md) | The player is in the component system |
| [0060](adr/0060-the-camera-can-be-put-somewhere.md) | The camera can be put somewhere |
| [0061](adr/0061-locomotion-is-the-games.md) | Locomotion is the game's |
| [0062](adr/0062-the-humanoid-is-one-avatar.md) | The humanoid is one avatar; the tick is the platform's |
| [0063](adr/0063-animation-is-the-games.md) | Animation is the game's |
| [0064](adr/0064-a-games-states-travel.md) | A game's own states travel in spare bits |
| [0065](adr/0065-a-game-composes-the-client.md) | A game composes the client |
| [0066](adr/0066-a-game-gets-the-engine.md) | A game gets the engine, not a hook per idea |
| [0067](adr/0067-the-swing-is-a-force-not-a-controller.md) | The swing is a force, not a controller |
| [0068](adr/0068-a-peers-rope-is-re-derived-not-sent.md) | A peer's rope is re-derived, not sent |
| [0069](adr/0069-a-keyboard-is-one-node.md) | A keyboard is one node; its keys are generated |
| [0070](adr/0070-the-frame-meter-is-off-by-default.md) | The frame meter is off by default |
| [0071](adr/0071-experience-buys-levels-and-levels-buy-speed.md) | Experience buys Levels, Levels buy Speed |
| [0072](adr/0072-a-world-point-on-the-screen.md) | A world point on the screen; the `+1` popup |
| [0073](adr/0073-a-stage-is-whatever-ends-on-a-wins-pad.md) | A stage is whatever ends on a Wins pad |
| [0074](adr/0074-one-tunnel-the-relay-rides-through-the-page.md) | One tunnel: the relay rides through the page |
| [0075](adr/0075-a-game-picks-its-debug-folders.md) | A game picks its debug folders |
| [0076](adr/0076-the-editor-refuses-a-prefab-the-game-cannot-load.md) | The editor refuses a prefab the game cannot load (amended by 0077) |
| [0077](adr/0077-a-games-shared-components-are-data-the-editor-adds-to.md) | A game's shared components are data the editor adds to |
| [0078](adr/0078-a-fast-character-keeps-its-momentum.md) | A fast character keeps its momentum |
| [0079](adr/0079-the-inertia-layer-believes-only-so-much.md) | The inertia layer believes only so much |
| [0080](adr/0080-the-treadmill-runs-you-at-your-own-speed.md) | The treadmill (amended by 0081) |
| [0081](adr/0081-a-step-is-a-tick-of-held-input.md) | A step is a tick of held input |
| [0082](adr/0082-text-standing-in-the-world-and-pads-that-set-the-step.md) | Text standing in the world; pads that set the step |
| [0083](adr/0083-content-is-authored-on-a-hosted-editor.md) | Content is authored on a hosted editor |
| [0084](adr/0084-the-game-reads-a-live-mirror-of-the-box.md) | The game reads a live mirror of the box |
| [0085](adr/0085-a-staging-game-on-the-box.md) | A staging game on the box |
| [0086](adr/0086-play-in-the-editor-is-the-real-game.md) | Play in the editor is the real game |
| [0087](adr/0087-a-games-numbers-are-settings-and-a-simulator-reads-them.md) | A game's numbers are settings, and a simulator reads them |
| [0088](adr/0088-a-curve-is-points-the-designer-places.md) | A curve is points the designer places |
| [0089](adr/0089-a-level-is-edited-live.md) | A level is edited live |
| [0090](adr/0090-a-shape-is-a-built-in-mesh-sized-by-scale.md) | A shape is a built-in mesh, sized by the object's scale |
| [0091](adr/0091-a-level-references-a-prefab-by-id.md) | A level references a prefab by id, and a prefab is edited live |
| [0092](adr/0092-peers-are-quantized-over-a-kilometre.md) | A peer's position is quantized over ±1000 m, not ±40 m |

`Design archive/` holds superseded design material and is not maintained.

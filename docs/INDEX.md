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
| [content.md](platform/content.md) | Node/component schema, prefabs, levels, assets, the per-game folder layout |
| [sequences.md](platform/sequences.md) | Stages of steps as a pure function of time: data, API, timing and combining rules |
| [components/api.md](platform/components/api.md) | Parameter kinds, `defineComponent`, hooks, the runtime, registries as code + data |
| [components/built-ins.md](platform/components/built-ins.md) | Every shipped definition and its params; the shared set |
| [components/boss.md](platform/components/boss.md) | `Boss`: the three-node shape, the trigger rule, what it chases |
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
| [editor.md](platform/editor.md) | What it authors, content API client, edits as ops, live levels, game discovery, adoption, Play |
| [editor-server.md](platform/editor-server.md) | The content API, Access identity, live documents, session commits, upload, deploy |
| [content-sync.md](platform/content-sync.md) | The live mirror, `content-root.ts`, the `@content` alias, `.env` |
| [tooling.md](platform/tooling.md) | share, bots, netsim |
| [budgets.md](platform/budgets.md) | The tripwires and how each is measured |

## Games — `docs/games/`

| Game | Docs |
| --- | --- |
| [keyboard](games/keyboard/README.md) | progression, balance, world-1, steps, keycaps, stages-and-wins, pads, hud, debug, known-open |

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
| [0029](adr/0029-keyframe-tracks.md) | Motion is a keyframe track, edited on a timeline — superseded by 0103 |
| [0030](adr/0030-keyboard-shortcuts.md) | Shortcuts match the character; undo is a snapshot |
| [0031](adr/0031-multi-selection.md) | Multi-selection, with a primary |
| [0032](adr/0032-bumper.md) | A bumper, and triggers that carry parameters |
| [0033](adr/0033-piece-objects-and-prefab-overrides.md) | A piece is an object; a placement overrides it |
| [0034](adr/0034-coyote-time.md) | Coyote time, and two vertical stops |
| [0035](adr/0035-component-system.md) | A node holds components |
| [0036](adr/0036-component-runtime.md) | Components run, deterministically |
| [0037](adr/0037-timeline-edits-a-parameter.md) | The timeline edits a declared parameter — superseded by 0103 |
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
| [0050](adr/0050-tracks-are-offsets-and-assets.md) | A keyframe is an offset; a track can be an asset — superseded by 0103 |
| [0051](adr/0051-dope-sheet.md) | The Animation panel is a dope sheet — superseded by 0103 |
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
| [0093](adr/0093-a-level-says-how-far-it-reaches.md) | A level says how far it reaches, and the editor draws it |
| [0094](adr/0094-the-viewport-has-a-navigation-gizmo.md) | The viewport has a navigation gizmo, and an isometric camera behind it |
| [0095](adr/0095-a-component-can-see-every-player.md) | A component can see every player, and the Boss is what wanted it |
| [0096](adr/0096-weight-grows-with-the-square-root-of-speed.md) | Weight grows with the square root of speed, and only when you lose it |
| [0097](adr/0097-deleting-a-prefab-unlinks-its-placements.md) | Deleting a prefab unlinks its placements |
| [0098](adr/0098-a-placement-can-override-its-prefab-roots-components.md) | A placement can override its prefab root's components |
| [0099](adr/0099-a-node-can-be-switched-off.md) | A node can be switched off, and its subtree with it |
| [0100](adr/0100-moving-the-character-releases-its-footing.md) | Moving the character from outside the controller releases its footing |
| [0101](adr/0101-the-inspector-binds-to-a-copy.md) | The Inspector binds to a deep copy, never to the document |
| [0102](adr/0102-the-active-checkbox-lives-in-the-inspector.md) | The active checkbox lives in the Inspector, not the Hierarchy |
| [0103](adr/0103-motion-is-a-speed-not-a-keyframe.md) | Object motion is a speed on a component, not a keyframe track — superseded by 0137 |
| [0104](adr/0104-a-deck-may-not-outrun-its-rider.md) | A deck may not outrun its rider: the overtake probe, and slicing the tick |
| [0105](adr/0105-boarding-is-arriving-not-rising.md) | Boarding is decided by where a surface is met, and a rider is seated on it |
| [0106](adr/0106-a-movers-metre-is-a-metre.md) | A Mover's metre is a metre, and it picks its own frame |
| [0107](adr/0107-the-air-is-not-free.md) | The air is not free |
| [0108](adr/0108-a-game-is-a-folder.md) | A game is a folder |
| [0109](adr/0109-the-editor-reopens-what-you-left.md) | The editor reopens what you left |
| [0110](adr/0110-a-level-is-managed-like-an-asset.md) | A level is managed like an asset |
| [0111](adr/0111-a-placement-can-be-unlinked.md) | A placement can be unlinked |
| [0112](adr/0112-the-inspector-edits-the-whole-selection.md) | The Inspector edits the whole selection |
| [0113](adr/0113-a-reparent-is-one-edit.md) | A reparent is one edit, and a step is not a constraint |
| [0114](adr/0114-one-snap-increment-per-tool.md) | One snap increment per tool, and rotation snaps absolutely |
| [0115](adr/0115-the-keys-are-the-games-not-the-platforms.md) | The keys belong to the game, on one shared grid |
| [0116](adr/0116-a-cell-belongs-to-the-board-its-centre-is-on.md) | A cell belongs to the board its centre is on |
| [0117](adr/0117-snapping-moves-the-corner.md) | Snapping moves the corner, not the centre |
| [0118](adr/0118-the-keyboard-grid-goes-back-on-the-platform.md) | The keyboard grid goes back on the platform |
| [0119](adr/0119-a-face-is-a-handle.md) | A face is a handle |
| [0120](adr/0120-a-game-describes-what-a-tool-draws.md) | A game describes what a tool draws |
| [0121](adr/0121-the-editor-is-a-shell-around-subsystems.md) | The editor is a shell around subsystems |
| [0122](adr/0122-revert-and-apply-have-two-scopes.md) | Revert and Apply have two scopes |
| [0123](adr/0123-a-prefab-document-is-open-for-every-reference.md) | A prefab document is open for every reference |
| [0124](adr/0124-a-resolved-definition-never-reaches-disk.md) | A resolved definition never reaches disk |
| [0125](adr/0125-the-preview-poses-the-tree-in-one-walk.md) | The preview poses the tree in one walk |
| [0126](adr/0126-a-reparent-re-expresses-the-authored-pose.md) | A reparent re-expresses the authored pose |
| [0127](adr/0127-a-hill-is-followed-not-fallen-down.md) | A hill is followed, not fallen down |
| [0128](adr/0128-a-pull-moves-the-whole-selection.md) | A pull moves the whole selection |
| [0129](adr/0129-a-face-is-chosen-before-it-is-pulled.md) | A face is chosen before it is pulled |
| [0130](adr/0130-a-child-added-to-a-placement-can-be-applied.md) | A child added to a placement can be applied |
| [0131](adr/0131-a-prefabs-piece-can-be-copied.md) | A prefab's piece can be copied |
| [0132](adr/0132-hiding-a-node-is-a-view-not-an-edit.md) | Hiding a node is a view, not an edit |
| [0133](adr/0133-a-placement-can-do-without-a-piece.md) | A placement can do without a piece |
| [0134](adr/0134-a-drag-carries-the-whole-selection.md) | A drag carries the whole selection |
| [0135](adr/0135-a-difference-is-recorded-on-any-piece.md) | A difference is recorded on any piece |
| [0136](adr/0136-an-angle-is-rounded-in-degrees.md) | An angle is rounded in degrees |
| [0137](adr/0137-motion-is-a-sequence-of-stages.md) | Motion is a sequence of stages |
| [0138](adr/0138-only-easing-is-borrowed.md) | Only easing is borrowed |
| [0139](adr/0139-a-placement-records-every-difference-in-a-sequence.md) | A placement records every difference in a sequence |
| [0140](adr/0140-a-frame-is-drawn-on-the-loops-own-schedule.md) | A frame is drawn on the loop's own schedule |
| [0141](adr/0141-the-game-runs-sequences.md) | The game runs sequences |
| [0142](adr/0142-the-editor-previews-sequences-while-motion-runs.md) | The editor previews sequences while Motion runs |
| [0143](adr/0143-a-sequence-is-edited-as-boxes-in-the-inspector.md) | A sequence is edited as boxes in the Inspector |
| [0142](adr/0142-a-board-has-a-key-budget.md) | A board has a key budget |
| [0144](adr/0144-a-move-point-is-dragged-on-a-copy-in-the-viewport.md) | A move point is dragged on a copy in the viewport |
| [0145](adr/0145-a-selection-is-outlined-in-one-pass.md) | A selection is outlined, everyone's in one pass |
| [0146](adr/0146-my-selection-shows-its-edges.md) | My selection shows its edges |
| [0147](adr/0147-a-sequence-is-edited-as-cards-on-a-rail.md) | A sequence is edited as cards on a rail, with its own controls |
| [0148](adr/0148-a-level-says-whether-the-camera-sees-through.md) | A level says whether the camera sees through; by default it collides |
| [0149](adr/0149-the-tools-float-over-the-viewport.md) | The tools float over the viewport; the top bar is the document and running it |
| [0150](adr/0150-the-hierarchy-reads-like-unitys.md) | The Hierarchy reads like Unity's, and its drag is rebuilt |
| [0151](adr/0151-prefab-editing-is-one-tree-and-one-translator.md) | Prefab editing is rebuilt on one tree and one translator |
| [0152](adr/0152-the-inspector-is-cards-of-our-own-fields.md) | The Inspector is cards of our own fields |
| [0153](adr/0153-one-mesh-renderer.md) | `Mesh` folds into `Renderer`: one Mesh Renderer |
| [0154](adr/0154-a-keyboard-rides-its-board.md) | A keyboard's caps ride the board a sequence carries |
| [0155](adr/0155-the-status-bar-becomes-notices.md) | The status bar becomes notices, and its state moves to where it belongs |
| [0156](adr/0156-asset-changes-reach-every-editor.md) | Asset changes reach every editor, and the server keeps its asset list in memory |
| [0157](adr/0157-the-editor-recompiles-only-what-changed.md) | The editor recompiles only what changed, in place, and saves a material in order |
| [0158](adr/0158-a-selection-is-shown-never-refused.md) | A selection is shown, never refused: anyone edits anything |
| [0159](adr/0159-data-file-assets-are-live-documents.md) | Assets that are data files are live documents |
| [0160](adr/0160-a-field-someone-is-in-is-ringed-in-their-colour.md) | A field someone is in is ringed in their colour |
| [0161](adr/0161-each-game-has-its-own-asset-library.md) | Each game has its own asset library, beside the shared one |
| [0162](adr/0162-the-games-window-holds-the-levels.md) | The games window holds the levels |
| [0163](adr/0163-the-project-window-is-folders-of-square-tiles.md) | The Project window is folders of square tiles, under two roots |
| [0164](adr/0164-a-click-selects-an-asset-a-drag-places-it.md) | A click selects an asset, a drag places it |
| [0165](adr/0165-the-asset-inspector-shows-a-picture-facts-and-users.md) | The asset Inspector shows a picture, the facts, and who uses it |
| [0166](adr/0166-several-assets-at-once-keys-and-sorting.md) | Several assets at once, Unity's keys, and a sort in the Project window |
| [0167](adr/0167-a-redraw-walks-once-frees-its-own-and-touches-what-changed.md) | A redraw walks the tree once, frees only its own, and touches only what changed |
| [0168](adr/0168-the-inspector-follows-an-edit-made-elsewhere-in-place.md) | The Inspector follows an edit made elsewhere in place |
| [0169](adr/0169-a-game-page-downloads-one-level-and-only-what-it-uses.md) | A game page downloads one level and only what it uses |
| [0170](adr/0170-the-procedural-sky-is-the-only-sky.md) | The procedural sky is the only sky |
| [0171](adr/0171-parkour-swing-the-viewer-and-goal-are-deleted.md) | Parkour, Swing, the viewer and `Goal` are deleted |
| [0172](adr/0172-play-is-always-the-games-own-page.md) | Play is always the game's own page |
| [0173](adr/0173-file-locks-are-deleted.md) | File locks are deleted |
| [0174](adr/0174-one-component-per-file.md) | One component per file |
| [0175](adr/0175-a-shared-component-can-be-removed-from-a-game.md) | A shared component can be removed from a game |
| [0176](adr/0176-reference-fields-take-drops.md) | Reference fields take drops, and a press that drags selects nothing |
| [0177](adr/0177-component-fields.md) | Component fields, and reference fields as Unity has them |
| [0178](adr/0178-pickers-and-add-component-in-folders.md) | Pickers and Add Component in folders |
| [0179](adr/0179-snapping-moves-the-centre-on-the-axes-dragged.md) | Snapping moves the centre, on the axes dragged |
| [0180](adr/0180-the-world-grid-and-align-to-grid.md) | The world grid, and Align to Grid |
| [0181](adr/0181-data-assets.md) | Data assets |
| [0182](adr/0182-keys-take-their-colours-from-a-style.md) | Keys take their colours from a style, and letters can face four ways |
| [0183](adr/0183-no-ambient-occlusion-on-carried-caps.md) | No ambient occlusion on a carried board's caps |
| [0184](adr/0184-follow-takes-their-selection-and-motion.md) | Following takes their selection and their Motion preview |

`Design archive/` holds superseded design material and is not maintained.

# `@mp/tps` — the third-person client

`packages/tps/src/index.ts`. The third-person humanoid game as a package (ADR 0065): rigs, ragdoll, boom camera,
walk cycle, debug pane. Built from `@mp/game-client` services (`docs/platform/client/services.md`). Every shipped
game's `main.ts` is `await startTpsClient(options)`.

## `startTpsClient(options: TpsClientOptions): Promise<TpsClient>` — `client.ts`

Host page owes it `#view` (canvas) and `#status` (element). Level: `?level=<name>` else `levels.defaultName`;
unknown name logs and falls back.

### `TpsClientOptions`

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | `string` | Level filter, save key, matchmaking filter |
| `registry` | `Registry` | Component types validating/instantiating the level |
| `session` | `ModeDescriptor['session']` | Headless rules (ADR 0052) |
| `spawn` | `ModeDescriptor['spawn']` | Arrival placement, spread by id |
| `tuning` | `CharacterTuning` | Locomotion feel; **copied** on the way in (ADR 0057) |
| `player?` | `readonly ComponentData[]` | Player's own components (ADR 0059) |
| `playerDefs?` | `ModeDescriptor['playerDefs']` | Built per session against `PlayerHost` (ADR 0061) |
| `actions?` | `ModeDescriptor['actions']` | Action name → key codes (ADR 0061) |
| `gait?` | `GaitTuning` | Retunes shared walk cycle; absent = `DEFAULT_GAIT` (ADR 0063). Copied. |
| `animator?` | `AnimatorFactory` | **Replaces** the shared cycle (ADR 0063) |
| `states?` | `readonly string[]` | Game states sent to peers, bit order, max 5 (ADR 0064) |
| `playerStates?` | `() => ReadonlySet<string>` | Which states are set locally now |
| `debugFolders?` | `readonly DebugFolder[]` | Platform pane folders wanted; absent = all, `[]` = none (ADR 0075) |

### `TpsClient` handles

```ts
dispose: () => void                       // loops → net → DOM (input, shell) → drawn (avatars, level, pane) → postfx, stage, world.free(). Idempotent.
readonly scene: THREE.Scene               // add/remove freely; not tracked, not disposed for you
onFrame: (fn: (dt: number) => void) => () => void   // per rendered frame, end of frame; returns remover (ADR 0066)
partsOf: (id: EntityId) => Record<PartName, PartTransform> | null  // rig parts, world space, as last drawn
id: () => EntityId | null
peers: () => readonly Peer[]              // rebuilt per frame from the render pass; base frame undone (ADR 0068)
readonly camera: OrbitCamera              // params live
readonly tuning: CharacterTuning          // the live copy the controller reads and the pane binds
toScreen: (world: Vec3) => { x: number; y: number } | null  // overlay pixels; null behind lens (ADR 0072)
readonly ui: UiOverlay                    // shared Pixi layer; read ui.width/height, not window
readonly debugPane: DebugPane['pane']     // tweakpane root
world: () => PhysicsWorld | null          // null before first snapshot
level: () => LoadedLevel | null
meshesOf: (node: WorldNode) => readonly THREE.Mesh[]   // deduped across node.colliderHandles (ADR 0082)
material: (assetId: string) => THREE.Material | null   // level-loaded material (ADR 0082)
data: (assetId: string) => DataAsset | undefined       // a level-loaded data asset as its file holds it; readData reads it (ADR 0181)
excludeFromAO: (object: THREE.Object3D) => () => void  // add to AO-ignore set; returns undo (ADR 0082)
```

```ts
interface Peer { id: EntityId; position: Vec3; yaw: number; states: ReadonlySet<string> }
```

### Frame order (`stage.start` callback)

1. `frameDt = min(0.1, elapsed)`; `simLoop.pump()` runs any due tick, then `tickAlpha = simLoop.alpha()` — the
   loop's own schedule, not the time since a tick ran (ADR 0140).
2. `level.render(tickAlpha)` — level meshes + lights interpolated.
3. Self: `avatars.drawSelf(...)` from `controller.renderPositions(tickAlpha)`, the same instant.
4. Peers: for each `net.sample()` → `worldFromBase(loaded, e, true)` → `peerFrame.push` → `avatars.drawPeer(...)`.
5. `avatars.prune(seen)`.
6. Touch (if `touch.active()`): `setEnabled(!paused)`, `drainLook()` → `orbit.lookTouch`/`zoomPinch`; tap while
   dead = respawn; `touchHud.draw(joystick, jumpButton)`.
7. `orbit.update(frameDt, ownPos, level.setOccluders)` → `avatars.setSelfVisible(myId, placed.rigVisible)`.
8. `frameHooks.run(frameDt)` — **game `onFrame` hooks**, after level, bodies, camera.
9. `pane.frame()` — frame meter, **last** (ADR 0070).

Then `stage.setRenderStep` (set by `createScene`) draws post-FX + overlay layer.

### Fixed tick (`startFixedLoop`, `TICK_RATE_HZ`) — after `onWelcome`

`syncRemotes` (kinematic capsule mirrors, `BODY_LAYERS`) → `input.worldMove()` (zero when dead) → `controller.step({
moveX, moveZ, jump, actions })` → landing dip `orbit.land` → `avatars.capture()` → `net.send({ position, flags, yaw,
speed, base })` (v10 base frame; `packStates(states, playerStates())` in spare flag bits) → `components.contact` →
`rules.takeDeath()` → `die()` → `rules.takeTeleport?.()`.

`LocalWorld.applyInput`: `components.fixedUpdate` → `loaded.update` → `world.step(TICK_DT/2)` →
`components.locomote(cmd)` → `world.step(TICK_DT/2)`.

## Debug pane — `pane.ts`

```ts
DEBUG_FOLDERS = ['camera','sky','touch','movement','render','gait','idle','inertia','head','jointLag','air','death'] as const
type DebugFolder = (typeof DEBUG_FOLDERS)[number]
installDebugPane(opts: DebugPaneOptions): DebugPane
interface DebugPane { readonly pane: Pane; frame: () => void; dispose: () => void }
```

- Built in `DEBUG_FOLDERS` order, only keys in `opts.folders` (absent = all). Root `Pane({ title: 'Debug', expanded: false })`
  in a fixed div `top:8px;right:8px;width:256px;z-index:100`.
- Frame meter (`stats.js`) always built, off by default; toggle binding `frame meter` (ADR 0070).
- Every folder binds an object owned elsewhere (`orbit.params`, `env.sunAngles/skyParams`, `touchLayout`, `tuning`,
  `postfx.params`, `gait`, `assembleTiming`); no state of its own. `orbit.params.camSeeThrough` starts as the
  level's `config.cameraSeeThrough` (`createOrbitCamera` options, ADR 0148); Camera's `see through` flips it live.
- **A game adds its own folder**: `client.debugPane.addFolder({ title })` and bind its own objects (ADR 0067).
  Keyboard passes `debugFolders: []` and still gets the root (ADR 0075).

## Death / ragdoll / assembly

`Death` component (`packages/components/src/player/death.ts`, `attachesTo: 'player'`, singleton) is read once from
`options.player` (defaults via `readParams(Death.params, {}, Death.type)` when absent): `ragdoll: bool = true`,
`assembleStagger = 0.05`, `assembleFall = 0.18`, `assembleHeight = 2.5`. Timing goes into a live `AssemblyTiming`
(`{ stagger, fall, height }`) bound by the `death` pane folder. On `die()` (hazard or fall plane via `rules.takeDeath`;
also the pane's "Ragdoll now"), `avatars.die(id, translation, velocity)` seeds `createRagdoll` (`ragdoll.ts`) from
the rig's last drawn pose: one dynamic cuboid per `PART_NAMES` on `CORPSE_LAYERS`, inheriting velocity, poses
captured per tick and slerp-interpolated per frame. Returns `false` if no rig has been drawn (stays alive). The
capsule keeps stepping while dead (drives ragdoll and platforms) with no input; `STATE_DEAD` is the only thing on the
wire. Respawn (`requestRespawn`: click while locked, look-region tap, pause Restart) → `avatars.reassemble()` →
`createAssembly` (`assemble.ts`): loose parts drop in from `height` in `ORDER` pairs (lower legs → upper legs → body
→ chest → upper arms → lower arms → head), `1 - p²` fall, targets recomputed per frame from the live pose. Peers get
the same corpse/assembly on the dead flag's edges, seeded from the pose this client drew them in.

## Avatars — `avatars.ts`

```ts
createAvatars({ scene, gait, makeAnimator?, timing, world: () => PhysicsWorld | null, ragdoll? = true }: AvatarsOptions): Avatars
```

Owns every body on screen and their ordering: `CharacterViews` (`characterView.ts`: rig + animator + nametag per
id, base-switch slip smoothing `BASE_SWITCH_HALFLIFE = 0.1`), own ragdoll + assembly, per-peer ragdolls and
assemblies. Handles: `drawSelf`, `setSelfVisible(id, cameraSays)` (`!dead && !assembling && cameraSays`),
`drawPeer`, `prune`, `die`, `reassemble`, `assembling`, `capture`, `obstacles(ownCollider)` (own capsule + every
corpse collider, for camera occlusion exclusion), `poseOf`, `partsOf`, `resetMotion`, `dispose`. Reads no flag byte
or base index — the caller passes `dead` and world-space placement.

## Other exports

`createFrameHooks(): FrameHooks` (`add/run/clear/size`; iterates a copy so a hook may remove itself),
`createCharacterViews`, `SELF_COLORS`/`PEER_COLORS`, `makeNameLabel(text): THREE.Sprite` (`worldLabel` at
`CHAR_HALF_HEIGHT + CHAR_RADIUS + 0.5`), `createRagdoll`, `createAssembly`, `BODY_LAYERS`/`CORPSE_LAYERS`
(`layers.ts`: capsules never collide with corpses), `createInputs` (`docs/platform/client/input.md`),
`TPS_VERSION = '0.0.0'`.

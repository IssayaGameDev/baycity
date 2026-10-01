import { createLocalController, type LocalController, type LocalWorld } from '@mp/client'
import {
  createSimClock,
  startFixedLoop,
  TICK_DT,
  TICK_RATE_HZ,
  vec3,
  yawOf,
  type EntityId,
  type LoopHandle,
  type Vec3,
} from '@mp/core'
import { packStates, unpackStates, STATE_DEAD, STATE_GROUNDED, STATE_RISING } from '@mp/net'
import { createPhysicsWorld, initPhysics, type PhysicsBody, type PhysicsWorld } from '@mp/physics'
import {
  addCharacter,
  type AnimatorFactory,
  type PartName,
  type PartTransform,
  CHAR_HALF_HEIGHT,
  CHAR_RADIUS,
  type CharacterState,
  type CharacterTuning,
  DEFAULT_GAIT,
  type GaitTuning,
  releaseFooting,
} from '@mp/humanoid'
import { createOrbitCamera, type OcclusionQueries, type OrbitCamera } from '@mp/camera'
import { PLAYER_NODE_ID, type ModeDescriptor, type PlayerHost } from '@mp/mode'
import { type ComponentData, type DataAsset, type LoadedLevel, type WorldNode } from '@mp/content'
import {
  Death,
  characterAccess,
  componentOn,
  createComponentRuntime,
  readParams,
  type ComponentRuntime,
  type Registry,
} from '@mp/components'
import {
  createNetHost,
  createScene,
  createShell,
  createStatusLine,
  loadLevel,
  loadLevelInto,
  localProgress,
  worldFromBase,
  type LevelHost,
  type Shell,
  type UiOverlay,
} from '@mp/game-client'

import { THREE as THREEImpl, type THREE } from '@mp/render-three'

import { createAvatars, type Avatars } from './avatars'
import { createFrameHooks } from './frameHooks'
import { type AssemblyTiming } from './assemble'
import { createInputs } from './inputs'
import { BODY_LAYERS } from './layers'
import { installDebugPane, type DebugFolder, type DebugPane } from './pane'

/**
 * The game client, for any game on the platform (ADR 0056).
 *
 * A `ModeDescriptor` is the whole of what varies: its registry validates and instantiates the level, its
 * tuning drives the controller, its `session` is the rules, its `spawn` places arrivals, and its name picks
 * the level list and the save key. What is left here is the Three stage, the post-FX, the asset preload,
 * joining a room, interpolation, the pause screen, touch, and the render loop.
 *
 * **What is no longer here**: every body on screen, the camera's DOM events, the debug pane, and what a death
 * looks like all live in `@mp/tps` (ADR 0065), because they are one game's opinion rather than the platform's.
 * This file drives them; it does not own them.
 *
 * **Being taken apart (ADR 0065).** The remaining ~900 lines are a platform half (clock, snapshots, room,
 * codecs, fixed loop, level, physics, assets) and a plumbing half (canvas, renderer, post-FX, input, status,
 * pause, resize). Phase 2 makes each a service with its own teardown; phase 3 hands the composition to the
 * game's own `main.ts` and `ModeDescriptor` drops to about six fields.
 *
 * The host page owes it two elements: a `#view` canvas and a `#status` line.
 */
/**
 * A running game client.
 *
 * One method, and it exists so that starting a client is a reversible act (ADR 0065). Nothing in the stack
 * calls it yet — the page owns the client for its whole life and the browser reclaims everything on unload.
 * It is here because `dispose` is only cheap to write while the thing that allocates is being written: this
 * file is about to be taken apart into services, and each one carries its own teardown from the start rather
 * than having one reconstructed for it later.
 */
/** One other player, as this frame drew them. */
export interface Peer {
  id: EntityId
  /** World space, already out of any platform frame it was riding. */
  position: Vec3
  /** Facing (radians) as sent — it follows their *input*, not their velocity (v9). */
  yaw: number
  /** This game's own states that are set for them, off the spare flag bits (ADR 0064). */
  states: ReadonlySet<string>
}

/**
 * A running third-person client, and the keys to the things it built.
 *
 * **Returning handles is not the same smell as growing `TpsClientOptions`** (ADR 0066). An option is a game
 * declaring a feature *to* the platform, and the platform then has to hold a concept per idea — which is how
 * `ModeDescriptor` reached fifteen fields. These are the engine's own objects, handed over: a game draws with
 * the scene, casts with the world, and the platform learns nothing about what it drew or why.
 *
 * The pairing that matters is `scene` + `onFrame`. A component can already run logic every tick and move the
 * character (ADR 0061), so simulation was never the gap; **drawing was**, because component hooks are all
 * fixed-tick and a thing drawn at 30 Hz attached to a rig animated per frame visibly comes apart.
 */
export interface TpsClient {
  /**
   * Stop the loops, leave the room, release the DOM and free the physics world.
   *
   * Ordered deliberately rather than by unwinding creation: the loops go first, because a tick that ran after
   * `world.free()` would be reading freed WASM memory, and the world is created long after the render loop
   * starts. Safe to call twice.
   */
  dispose: () => void
  /**
   * The Three scene, for anything the game draws itself.
   *
   * Add and remove as you like; nothing here tracks it. What the client owns it disposes, and what a game adds
   * is a game's to dispose — `dispose` does not walk the scene looking for strangers.
   */
  readonly scene: THREE.Scene
  /**
   * Run `fn` once per **rendered** frame, with the frame's delta in seconds. Returns the call that removes it.
   *
   * Additive, unlike `ThreeStage.setRenderStep`, which replaces — the nametag pass already holds that
   * (ADR 0065). Called at the **end** of the frame, after the level is posed, the bodies are drawn and the
   * camera is placed, so `poseOf` and `camera` both report this frame rather than the last.
   */
  onFrame: (fn: (dt: number) => void) => () => void
  /**
   * Every part of a character's rig, **in world space, as it was last drawn**.
   *
   * Drawn rather than simulated, which is the point: rigs are animated per rendered frame, so anything pinned
   * to a hand has to follow the frame and not the 30 Hz tick. `null` for a character with no rig yet.
   *
   * Pair it with `onFrame`. Reading it from a component's `onFixedUpdate` would give the same answer three or
   * four frames running.
   */
  partsOf: (id: EntityId) => Record<PartName, PartTransform> | null
  /** Our own id, or `null` before the server has assigned one — which is most of the first second. */
  id: () => EntityId | null
  /**
   * Every other player as this frame drew them (ADR 0068).
   *
   * Position and facing are already **out of any moving platform's frame** (ADR 0021) and on the delayed
   * timeline the rig was drawn on, so a game reading this sees exactly what the eye sees. `states` is this
   * game's own bits off the flags byte (ADR 0064) — the whole of what a peer can tell you about itself beyond
   * where it is.
   *
   * Rebuilt once per frame from what the render pass already computed, not sampled again: two samples in one
   * frame land on slightly different interpolation times, and a rope drawn from one while the body was drawn
   * from the other would hang off the hand.
   *
   * Empty until the first snapshot. Never includes us.
   */
  peers: () => readonly Peer[]
  /** The boom camera, for a game that wants to change how it behaves. Its params are live. */
  readonly camera: OrbitCamera
  /**
   * The character's **live** tuning — the object the controller reads every tick and the debug pane binds.
   *
   * Not the one passed in: that is copied on the way in (ADR 0057), so a game writing into its own descriptor's
   * object changes nothing. Keyboard did exactly that for fifty levels (ADR 0071's correction). A game that
   * drives a tuning value at runtime writes it here.
   */
  readonly tuning: CharacterTuning
  /**
   * Where a world point is on the 2D overlay, in **overlay pixels**, or `null` if it is behind the camera
   * (ADR 0072).
   *
   * A helper rather than the raw `PerspectiveCamera`, because every game wanting to pin a label to a thing in
   * the world would otherwise redo the same three steps: project through the camera, map clip space to the
   * overlay's pixels — **not** the window's, which differ on mobile — and reject points behind the lens, which
   * project to a mirrored position in front of it.
   *
   * General, not a concept per feature: "where is this on screen" is what damage numbers, nameplates,
   * waypoints and this game's XP popups all want.
   */
  toScreen: (world: Vec3) => { x: number; y: number } | null
  /**
   * The 2D overlay, for a game's own HUD (ADR 0071).
   *
   * The same Pixi layer the pause screen and the touch controls are on (ADR 0015), because a second Pixi
   * application would mean a second canvas, a second stacking order and a second resize to keep in step. Add
   * to `ui.root`; what a game adds is a game's to remove.
   *
   * Sized from the **Three canvas** rather than the window, and re-laid-out on resize — read `ui.width` and
   * `ui.height` rather than the window's, or a HUD sits a browser-bar's height out of place on mobile.
   */
  readonly ui: UiOverlay
  /**
   * The debug pane's root, for a game to add a folder of its own (ADR 0067).
   *
   * A game's feel is the game's, and feel is set by eye rather than by argument (ADR 0018) — so the numbers
   * that matter most to a new mechanic are exactly the ones with nowhere to live before this.
   */
  readonly debugPane: DebugPane['pane']
  /** This client's physics world, or `null` before the first snapshot brought a level. */
  world: () => PhysicsWorld | null
  /** The instantiated level, or `null` before there is one. */
  level: () => LoadedLevel | null
  /**
   * The drawn meshes of a level node (ADR 0082), for a game to restyle a piece of the level at runtime — an
   * active pad, a lit door. Empty before the level exists or for a node that draws nothing. The same "hand over
   * a fact" move as `partsOf` (ADR 0066): the game changes a material, the platform never learns what a pad is.
   */
  meshesOf: (node: WorldNode) => readonly THREE.Mesh[]
  /**
   * A material asset the level loaded, by id (ADR 0082). Every material a component parameter names is loaded
   * with the level, so a game restyling a node reads the id off the component and asks here.
   */
  material: (assetId: string) => THREE.Material | null
  /**
   * A data asset the level loaded, by id, as its file holds it (ADR 0181): every one a component parameter names
   * is on the level's needs list. Read it against its type with `readData`.
   */
  data: (assetId: string) => DataAsset | undefined
  /**
   * Keep an object out of the ambient-occlusion prepass (ADR 0082). Returns the undo.
   *
   * A billboard in the world pass draws no depth, but the AO prepass draws everything with an override
   * material and would see it as a tilted quad — the dark ghost the nametags were moved to the overlay layer
   * to escape. A sign that must hide behind walls cannot live on that layer, so it stays in the world and is
   * excluded here instead, the same way the surfaces wearing the camera's cutout are (ADR 0055).
   */
  excludeFromAO: (object: THREE.Object3D) => () => void
}

/**
 * Everything this game is, as arguments.
 *
 * A superset of what `ModeDescriptor` carries plus the four things only a client reads (`gait`, `animator`,
 * `states`, `playerStates`), which is why they left the descriptor in ADR 0065: a field on the platform's
 * game-contract existed only because there was no other door. Here they are simply parameters of the
 * third-person game, which is what they always were.
 *
 * A game that wants something this cannot express does not add a field — it stops calling this and composes
 * `@mp/game-client`'s services itself, which is roughly this file with its own opinions instead of these.
 */
export interface TpsClientOptions {
  /** Which game: the level filter, the save key, and one of the two matchmaking filters. */
  name: string
  /** The component types this game installs — what validates and instantiates a level. */
  registry: Registry
  /** The rules, headless, so the editor's play-in-place runs these and not a second copy (ADR 0052). */
  session: ModeDescriptor['session']
  /** Where an arrival stands. Spread by id, so two players joining at once do not stack. */
  spawn: ModeDescriptor['spawn']
  /** Locomotion feel. Copied on the way in — the debug pane binds the copy (ADR 0057). */
  tuning: CharacterTuning
  /** The player's own components (ADR 0059). A level authors the world; who is playing is the game's. */
  player?: readonly ComponentData[]
  /** Their definitions, built per session against the live character (ADR 0061). */
  playerDefs?: ModeDescriptor['playerDefs']
  /** This game's own controls, by name (ADR 0061). The names are the game's; the client only maps keys. */
  actions?: ModeDescriptor['actions']
  /** Retunes the shared walk cycle — stride, bob, lean, arm swing. Absent is the shipped biped (ADR 0063). */
  gait?: GaitTuning
  /** **Replaces** the shared cycle. Wrap `createAnimator` to add a state to it (ADR 0063). */
  animator?: AnimatorFactory
  /**
   * States of this game's own that have to reach other players, **in bit order** (ADR 0064).
   *
   * Five are free — they ride the spare bits of a flags byte already being sent. Appending is safe;
   * reordering silently reinterprets every peer's bits. A sixth throws.
   */
  states?: readonly string[]
  /** Which of them are set for the local player right now. Closes over whatever the game likes. */
  playerStates?: () => ReadonlySet<string>
  /**
   * Which of the platform's debug folders this game wants (ADR 0075). Absent is all of them; `[]` is none.
   *
   * The pane's root is handed back either way (`debugPane`), so a game with none of the platform's folders
   * still adds its own. The frame meter is always there.
   */
  debugFolders?: readonly DebugFolder[]
}

/**
 * The third-person game the platform ships, started (ADR 0065).
 *
 * This was `@mp/game-client`'s `startGameClient`, and moving it here is the whole point of ADR 0065: it is not
 * the platform, it is one game — a blocky humanoid seen over its own shoulder, with a boom camera, a ragdoll
 * death and a walk cycle. Every game the stack ships happens to be that game, so it lives here **once** rather
 * than being copied into three `main.ts` files that would immediately drift.
 *
 * What it is built out of is `@mp/game-client`'s services — the status line, the scene, the room and clock,
 * the level, the page, the fixed loop. Those are the platform, and a game that is not this game composes them
 * directly.
 */
export const startTpsClient = async (mode: TpsClientOptions): Promise<TpsClient> => {

  /**
   * Which level: `?level=<name>` picks a file from this game's own folder, `content/<game>/levels/`, and no
   * param gets its `default.level.json` (ADR 0108). The name stays **bare** — the page knows which game it
   * is — so every game gets to own a `default`. A typo falls back to the default rather than bricking the
   * page, and says so in the console.
   *
   * The name also picks the **room** — see `connect`, which filters on game *and* level, so two games'
   * `default` are two rooms. Everyone sharing a room has to be on the same
   * level: the geometry differs, and so does the movement-base index a rider puts on the wire, which is
   * assigned in instance order at load (ADR 0021). Mismatched clients would place each other on the
   * wrong platform entirely.
   */
  /**
   * Fetched with only what it uses, relative to this page's own address (`loadLevel`, ADR 0169): files beside a
   * build, the local dev server's from disk, the editor server's live on the box. Validated against the game's
   * registry before anything is built.
   */
  const picked = await loadLevel(mode.name, new URLSearchParams(location.search).get('level'), mode.registry, new URL(import.meta.env.BASE_URL, location.href).href)
  const levelName = picked.name
  const levelData = picked.level

  const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!
  const canvas = $<HTMLCanvasElement>('#view')
  const statusEl = $<HTMLDivElement>('#status')

  // The status line owns the locale too, because the line is key-driven and has to re-render on a switch.
  const status = createStatusLine(statusEl)
  const setStatus = status.set

  // The scene: stage, greybox pipeline, sky, post-FX, and the render step that draws nametags after
  // post-FX. The AO pass asks for the currently-holed surfaces fresh each frame — the level does not exist
  // yet, it arrives with the first snapshot (ADR 0055).
  /** Objects a game keeps out of the AO prepass (ADR 0082), alongside the cutout's surfaces. */
  const aoExcluded = new Set<THREE.Object3D>()
  const { stage, env, postfx } = await createScene(canvas, () => [...(level?.occluding() ?? []), ...aoExcluded])

  // Player views (own + peers): the blocky rig, procedurally animated, + billboard nametag.
  // One shared gait object so the debug pane retunes every character live (ADR 0018).
  // The game's gait if it has an opinion, the shipped one otherwise (ADR 0063). Copied, because this object
  // is what the debug pane binds and what every animator reads fresh each frame — the descriptor's must not
  // be mutated out from under a second session.
  /**
   * This game's own states for the local player, this frame (ADR 0064).
   *
   * Asked once and reused for both the outgoing state message and our own rig, so what peers are told and what
   * we draw cannot disagree. Empty for a game that declared none, which is every game the stack ships.
   */
  let ownStates: ReadonlySet<string> = new Set()
  const readOwnStates = (): ReadonlySet<string> => (mode.playerStates === undefined ? ownStates : (ownStates = mode.playerStates()))

  const gait: GaitTuning = { ...(mode.gait ?? DEFAULT_GAIT) }
  /**
   * What dying looks like: the game's `Death` component, or the shipped defaults when it declares none
   * (ADR 0059).
   *
   * Read once, here, rather than per death: it is authored data, not live state. The values then stay live on
   * the debug pane, which is bound to `assembleTiming` — so a game can ship an opinion and it can still be
   * dialled by eye.
   */
  const death = componentOn(mode.player ?? [], Death) ?? readParams(Death.params, {}, Death.type)
  const assembleTiming: AssemblyTiming = { stagger: death.assembleStagger, fall: death.assembleFall, height: death.assembleHeight }

  /**
   * Every body on screen — rigs, corpses, spawn assemblies — as one thing that owns the order they interact in
   * (ADR 0065).
   *
   * This was 127 lines threaded through the tick and the render loop here. What is left in this file is the
   * three questions only a *client* can answer: where a peer is once their base frame is undone, whether their
   * dead bit is set, and where the camera ended up.
   *
   * `world` is a getter because the world arrives with the first snapshot and this is built before it.
   */
  const avatars: Avatars = createAvatars({
    scene: stage.scene,
    gait,
    ...(mode.animator === undefined ? {} : { makeAnimator: mode.animator }),
    timing: assembleTiming,
    world: () => physicsWorld,
    ragdoll: death.ragdoll,
  })

  // --- camera orbit (mouselook via pointer lock) ---
  /**
   * The whole camera is `@mp/camera` now (ADR 0056): boom, zoom, occlusion, the see-through hole, the landing
   * dip and the own-rig hide. It used to be some 300 lines here, which a second game would have had to copy
   * and every fix would have had to be made twice.
   *
   * What stays in this file is what a *host* owes it: the DOM events it has no business knowing about, the
   * physics queries once a world exists, and the character position to orbit.
   */
  // The level says whether the camera sees through or collides (ADR 0148); the rest is the camera's own.
  const orbit = createOrbitCamera(stage.camera, { params: { camSeeThrough: levelData.config.cameraSeeThrough === true } })
  /**
   * The sun-shadow switch, kept because a hole in a surface leaves its *shading* behind (ADR 0055).
   *
   * Its AO twin has gone: ambient occlusion is level data now, so the pane binds `postfx.params` directly and
   * a second flag beside it would just be something else to keep in step.
   */
  const debug = { sunShadows: true }
  // Everything the player presses (`inputs.ts`), which is also what keeps the camera DOM-free: a mouse
  // delta becomes `lookMouse`, a wheel tick becomes `zoomNotch` (ADR 0056).
  const input = createInputs({
    canvas,
    camera: orbit,
    isDead: () => dead,
    onRespawn: () => requestRespawn?.(),
    // This game's own controls, if it has any (ADR 0061). The names are the game's; this only maps keys.
    ...(mode.actions === undefined ? {} : { actions: mode.actions }),
  })
  const touch = input.touch
  /**
   * The 2D overlay and everything on it, once it exists.
   *
   * Nullable because it is built with an `await` **after** the render loop starts, so a frame can run before
   * there is any of it and the loop has to cope rather than reference it eagerly.
   */
  let shell: Shell | null = null


  // Live locomotion feel, owned here because the sim and the render loop both read it. The pane only binds it.
  const tuning: CharacterTuning = { ...mode.tuning }
  // Everything live-tunable, in one place (`pane.ts`). It is pure wiring — every folder binds an object
  // somebody else owns — so it is the one part of this file that came out whole.
  const pane = installDebugPane({
    camera: orbit,
    debug,
    stage,
    env,
    postfx,
    tuning,
    gait,
    touchLayout: input.layout,
    assembleTiming,
    onTouchIgnore: input.ignore,
    onDeath: () => requestDeath?.(),
    ...(mode.debugFolders !== undefined ? { folders: mode.debugFolders } : {}),
  })

  /**
   * The room, the clock and the snapshot stream — the part of a client that must be uniform across everyone in
   * it, and therefore the platform's (`netHost.ts`, ADR 0065).
   *
   * Started here rather than awaited: the join is in flight while the first frames render, so `net.id()` is
   * `null` for most of the first second and everything downstream already copes with that (ADR 0055).
   */
  const net = createNetHost({
    game: mode.name,
    level: levelName,
    // What this level says it reaches (ADR 0093). The room takes it from whoever arrives first.
    bounds: levelData.config.netBounds,
    setStatus,
    onWelcome: (id: EntityId) => {
      void initLocalSim(id)
    },
  })
  let controller: LocalController | null = null
  let ownFacing = 0
  /** The level, once the first snapshot has brought us one. Colliders, meshes and content lights together. */
  let level: LevelHost | null = null
  /**
   * The instantiated half of it, held separately because it is read on far more paths than the drawn half —
   * the tick, the base-frame maths, the components, the rules.
   */
  let loaded: LoadedLevel | null = null
  let requestRespawn: (() => void) | null = null // set once the local sim exists; used by the pause menu's Restart
  let requestDeath: (() => void) | null = null // set once the local sim exists; the death path, for the ragdoll
  /**
   * Whether we are dead: it gates input, the kill checks and the flag we send.
   *
   * Only the *fact* stays here. What a death looks like — the loose bodies, the corpses of peers, the body
   * dropping back in — is `@mp/tps`'s, because it is a game's opinion (ADR 0065). Nothing about a death goes
   * on the wire but this one bit.
   */
  let dead = false
  /** The client's own physics world, once the local sim exists. Peer corpses are dynamic bodies in it. */
  let physicsWorld: PhysicsWorld | null = null
  /** The fixed sim loop, once the local sim exists. Held only so `dispose` can stop it. */
  let simLoop: LoopHandle | null = null
  // Per-player state behind a pluggable adapter (mode seam): local now, account-backed later.
  const persistence = localProgress(mode.name)

  const initLocalSim = async (id: EntityId): Promise<void> => {
    await initPhysics()
    // Client-owned world (ADR 0011). The character is kinematic and integrates its own gravity, so Rapier's
    // gravity never touches it — but the ragdoll's parts are *dynamic* and it is the only thing that pulls
    // them down. It was zero here, which left a corpse coasting off in a straight line for ever.
    const world = createPhysicsWorld({ gravity: { x: 0, y: -tuning.gravity, z: 0 } })
    physicsWorld = world // the render loop builds peers' corpses in it
    // Colliders and meshes in one call (`levelHost.ts`, ADR 0065). The level schema is platform, because
    // `baseIndex` goes on the wire and only means anything if every client instantiated the same JSON in the
    // same order (ADR 0021).
    level = await loadLevelInto({
      world,
      scene: stage.scene,
      data: levelData,
      registry: mode.registry,
      cutout: orbit.cutout,
      env,
      postfx,
      assets: picked,
    })
    loaded = level.loaded
    /**
     * **The rules run themselves.** `Bumper`, `Checkpoint` and `Hazard` carry their own `onContact`, so this
     * mode supplies only what dying and making progress *mean* here, and the branches that used to sit in the
     * tick — a checkpoint loop, a `Math.max` over bumper powers, a hazard `Set` — are gone.
     *
     * Adding a rule is now a component definition and nothing here at all, which is the difference between a
     * component system and a switch statement. Nothing in this file names `Bumper` any more.
     */
    /**
     * The rules themselves live in `rules.ts` (ADR 0052), headless, so the editor's play-in-place runs *these*
     * instead of a second hand-written copy. They had already drifted: the editor died on any fall, ignoring
     * `fallBehavior`, so a tower level killed you there and let you fall here.
     *
     * What stays in this file is what a *client* does about it — persistence, and driving the camera and the
     * bodies rather than owning them.
     */
    const playerState = persistence.load()
    const rules = mode.session(loaded, {
      from: playerState.checkpoint,
      onProgress: (progress) => {
        playerState.checkpoint = progress
        persistence.save(playerState)
      },
    })

    // Spawn: wherever the rules resumed to (a persisted checkpoint), else this game's spawn rule, which
    // spreads arrivals around the marker by id so two players do not stack.
    const spawn = playerState.checkpoint >= 0 ? rules.respawnAt() : mode.spawn(loaded, id)
    const char: CharacterState = addCharacter(world, spawn, BODY_LAYERS)
    ownState = char // the render loop reads velocity/grounded straight off the sim for our own rig

    /**
     * Camera occlusion: the two queries `@mp/camera` needs, against this client's own world. Everything in
     * the level is a collider already — including the hazard and checkpoint pads, which are solid pieces you
     * stand on, so the camera treating them as geometry is right.
     *
     * Excluded: ourselves. The boom starts at the capsule's crown, so the probe overlaps the capsule every
     * frame and would report zero clearance — and, while dead, our own scattered parts, which are our body
     * rather than scenery. Which colliders those are is `avatars.obstacles`, because the corpses are its
     * (ADR 0065); the capsule is the only handle this file owns.
     */
    const selfColliders = (): number[] => avatars.obstacles(char.body.colliderHandle)
    const queries: OcclusionQueries = {
      cast: (origin, direction, maxDistance, more) => {
        const skip = selfColliders()
        return world.castSphere({
          origin,
          direction,
          maxDistance,
          radius: orbit.probeRadius,
          exclude: more === undefined ? skip : [...skip, ...more],
        })
      },
      occupied: (point) => world.sphereOverlaps({ center: point, radius: orbit.probeRadius, exclude: selfColliders() }),
    }
    orbit.observe(queries)

    /**
     * Respawn: move to wherever the rules say (the last checkpoint, or the spawn) and leave nothing behind.
     *
     * Triggered by touching a hazard pad or falling below the kill plane — both are `takeDeath`'s call now.
     *
     * **Everything the old footing owned has to go with the position**, and forgetting `base` was a real bug
     * (ADR 0100). It survived death and respawn, so the controller's second, longer look for the surface it
     * was riding (`groundController.ts`, the bounce-fall guard) could re-acquire the platform the player died
     * on and then move them to their stored local spot on it — a respawn at the spawn followed a tick later
     * by a yank into the air. It also reached peers: while `base` is set, the position on the wire is the
     * *local* one, so everyone else drew the player at their old spot on that platform.
     *
     * The other three are the same class, smaller: a leftover `carry` is last tick's platform push, and
     * `liftVel`/`liftStore` is a departed mover's momentum held for a late jump, which would hand a fresh
     * spawn a free boost.
     */
    const respawn = (): void => {
      dead = false
      avatars.reassemble()
      char.body.setPosition(rules.respawnAt())
      releaseFooting(char)
    }
    requestRespawn = respawn // let the pause menu's Restart reach it

    /**
     * The live components, and the two things this mode lets a rule ask for.
     *
     * `progress` takes the node rather than an index, because what counts as progress is the mode's business:
     * the ordered list a saved index means anything against lives here, and **only touchable nodes are in it** —
     * a checkpoint nothing can reach is not a step in a progression.
     *
     * `kill` sets a flag instead of calling `die()` directly, because death is gated on not already being dead
     * and on the fall plane in the same breath, and one place deciding that is one place to read.
     */
    /**
     * What this host can offer the game's player components (ADR 0061). Getters, because the character is
     * replaced on a respawn and `tuning` is the live object the debug pane is bound to.
     */
    const playerHost: PlayerHost = {
      character: () => char,
      tuning: () => tuning,
      platforms: () => loaded?.basePose,
      // The world and the level themselves (ADR 0066), so a game's component can cast against the one and ask
      // the other what it hit. Getters for the same reason as the rest: both outlive nothing here, but a
      // component built before a respawn must not capture a stale one.
      world: () => physicsWorld,
      level: () => loaded,
    }
    // The player's own components come from the descriptor, not from the level (ADR 0059): a level authors
    // the world, and who is playing is the game's business. Their *definitions* can come from the game too
    // (ADR 0061), built against the host above, which is how locomotion stopped being the platform's.
    const components: ComponentRuntime = createComponentRuntime(loaded, mode.registry, {
      ...(mode.player === undefined
        ? {}
        : {
            player: {
              id: PLAYER_NODE_ID,
              components: mode.player,
              ...(mode.playerDefs === undefined ? {} : { defs: mode.playerDefs(playerHost) }),
            },
          }),
      character: characterAccess(char),
      effects: rules.effects,
      /**
       * Peers, for a component that has to reason about everyone and not just its own player (ADR 0095).
       *
       * The tick timeline, not the render one: `worldFromBase(..., false)` resolves a rider against the base
       * pose the sim is at, which is the same frame `onFixedUpdate` runs in. Sampling the rendered pose here
       * would put a peer standing on a moving platform a fraction of a step away from where the rule thinks
       * the platform is.
       */
      peers: () =>
        net.sample().map((e) => ({
          id: e.id as number,
          position: worldFromBase(loaded, e, false).position,
          alive: (e.flags & STATE_DEAD) === 0,
        })),
      alive: () => !dead,
    })
    // Tick 0 at level time 0: the clock has not started, and a component that wants "now" gets it in
    // `onFixedUpdate`. Counted here rather than read off the clock so the number a component sees is the
    // number of steps this level has run, which is what a deterministic fold is indexed by.
    /**
     * The furthest a deck may travel in one physics slice and still be ridden (ADR 0104).
     *
     * The distance from the capsule's centre to its soles: a deck starts at the soles, so a step longer
     * than this ends above the centre, where the downward probe begins and where the controller can no
     * longer sweep the capsule free. Measured exact to 0.02 m at 1.18 m and broken at 1.27 m, which brackets
     * it. Derived from the character rather than typed, so a taller capsule gets a longer allowance.
     */
    const RIDEABLE_STEP = CHAR_HALF_HEIGHT + CHAR_RADIUS

    let tickCount = 0
    /**
     * The clock at the end of the previous tick, so a sliced tick can pose the level at instants *between*
     * the two. Starts at the first tick's own time, which makes the first tick a single slice — there is no
     * previous instant to interpolate from, and nothing has moved yet.
     */
    let prevTickMs = -1
    components.attach(tickCount, 0, TICK_DT)

    /**
     * Death: the animated rig is replaced by one dynamic body per part in exactly the pose it was in, and the
     * player waits for a click. Both kill paths come through here — hazard contact and the fall plane are
     * the same death, so they get the same ragdoll.
     *
     * The capsule keeps being stepped while dead, because the world step it shares drives the ragdoll's own
     * bodies and every platform in the level. It is just invisible, given no input, and not allowed to die
     * again until it respawns.
     */
    const die = (): void => {
      if (dead) return
      // `false` means no rig has been drawn yet, so there is nothing to fall apart and we are not dead.
      dead = avatars.die(id, char.body.translation(), vec3(char.vx, char.vy, char.vz))
    }
    requestDeath = die
    avatars.reassemble() // the first spawn arrives the same way a respawn does

    // This local sim IS the truth for our own character (client-authoritative, ADR 0011).
    // Clock-driven pieces advance one fixed step per fixed step, tracking the synced server
    // clock by slewing. Reading `serverNow()` directly here would stall the platforms whenever
    // the loop runs several ticks in one wake, while the character kept advancing a full step
    // each — the platform-carry jitter (see @mp/core simClock).
    const simClock = createSimClock({ tickMs: TICK_DT * 1000, reference: () => net.serverNow() })
    /** How late, by the loop's schedule, the tick running now runs: the clock takes its reference back by it. */
    let tickLateMs = 0

    const local: LocalWorld = {
      applyInput: (cmd) => {
        // Two-phase step so the character resolves against the platforms' CURRENT positions,
        // not last tick's: (A) advance clock-driven pieces on the synced clock and step so they
        // move, (B) step the character against them — the controller's depenetration + snap-to-
        // ground then carry it up a rising platform and push it off a sweeping bar.
        // The piece we are riding is posed without velocity so only our own carry moves us; every
        // other piece keeps its velocity so it can still shove us (the spinning bar). See the loader.
        // Each step advances half a tick, so the two together advance exactly one. At a full tick each,
        // anything *dynamic* in the world integrated twice per tick and ran at double speed — which is what
        // the ragdoll's parts did. Neither of the other two things in here is affected: the level's pieces are
        // kinematic and move to a pose the loader sets rather than by integration, and the character's own
        // translation is computed by `stepCharacter` from the full `TICK_DT` and applied through `move`.
        const nowMs = simClock.tick(tickLateMs)
        // Components run **before** the frame tree, not after it (ADR 0058). A component can move its own
        // node now, and it writes an offset the frame tree reads — so running `update` first would pose
        // everything from last tick's offsets and land every driven node one tick late. The old order was
        // harmless only while nothing a component could reach was writable.
        components.fixedUpdate(++tickCount, nowMs, TICK_DT)
        /**
         * **Sliced when something moves too far to be stood on** (ADR 0104).
         *
         * A kinematic deck is teleported into place, and a teleport is not swept, so one that travels more
         * than the rider's centre-to-sole distance in a step lands *above* them — and the character
         * controller will not sweep a capsule out of a collider it is already inside. Measured at 30 Hz: the
         * carry is exact to 0.02 m at 1.18 m of travel per step and fails outright at 1.27 m.
         *
         * So the tick is posed and resolved in equal slices small enough that no deck crosses that distance
         * in one of them. Every level without a fast mover reports one slice and runs exactly as before.
         *
         * **Inside one `tick()`**, which is what keeps the netcode contract (ADR 0081): the local controller
         * still sees one step per tick, prediction still replays whole ticks, and the slice count is derived
         * from the level and the clock, so every client computes the same one.
         *
         * `fixedUpdate` stays at one call per tick — a component's `tickCount` and its seeded `ctx.random`
         * are per tick by definition (ADR 0036), and running hooks several times would fire a rule twice.
         * Only the frame tree, the physics and the movement slot are sliced.
         */
        if (prevTickMs < 0) prevTickMs = nowMs
        const slices = loaded?.motionSlices(prevTickMs, nowMs, RIDEABLE_STEP) ?? 1
        const sliceDt = TICK_DT / slices
        const half = sliceDt / 2
        for (let s = 1; s <= slices; s++) {
          // Motion is a pure function of time (ADR 0103), so an intermediate pose is exact rather than
          // interpolated: the level really is where it would have been at that instant.
          const at = prevTickMs + ((nowMs - prevTickMs) * s) / slices
          // Only the first slice moves where a frame blends from, so the drawing spans the whole tick.
          loaded?.update(at, char.base?.colliderHandle, s === 1)
          world.step(half) // (A) platforms move
          // The movement slot (ADR 0061). This was `stepCharacter(...)` called straight from here, which is
          // why every game had the same locomotion whether it suited them or not. The game's own locomotion
          // component occupies this moment now — between the two half-steps, so the character resolves
          // against where the platforms are *now*.
          components.locomote(tickCount, at, sliceDt, cmd)
          world.step(half) // (B) character resolves against the moved platforms
        }
        prevTickMs = nowMs
      },
      readState: () => new Map<EntityId, Vec3>([[id, char.body.translation()]]),
    }
    controller = createLocalController({ world: local, tickRateHz: TICK_RATE_HZ })

    // Remote players mirrored as kinematic capsules so walking into one collides locally.
    const remotes = new Map<EntityId, PhysicsBody>()
    const syncRemotes = (): void => {
      const seen = new Set<EntityId>()
      for (const e of net.sample()) {
        if (e.id === id) continue
        seen.add(e.id)
        let mirror = remotes.get(e.id)
        if (mirror === undefined) {
          mirror = world.addKinematicBody({
            position: worldFromBase(loaded, e, false).position,
            shape: { kind: 'capsule', halfHeight: CHAR_HALF_HEIGHT, radius: CHAR_RADIUS },
            // A body, so corpses pass through it: a dead peer's mirror stands invisibly at their death
            // point and their own parts were landing on it.
            layers: BODY_LAYERS,
          })
          remotes.set(e.id, mirror)
        }
        mirror.setNextKinematicTranslation(worldFromBase(loaded, e, false).position)
      }
      for (const [rid, mirror] of remotes)
        if (!seen.has(rid)) {
          mirror.remove()
          remotes.delete(rid)
        }
    }

    simLoop = startFixedLoop({
      tickRateHz: TICK_RATE_HZ,
      onTick: (_dt, _index, lateMs) => {
        tickLateMs = lateMs
        syncRemotes()
        // No input while dead — but the character is still stepped, because that same world step is what
        // makes the ragdoll's bodies fall and the level's platforms move.
        const move = dead ? { x: 0, z: 0 } : input.worldMove()
        if (move.x !== 0 || move.z !== 0) ownFacing = Math.atan2(move.x, move.z)
        // Held *or* tapped. The two level reads (`keys.has`, `touch.jump`) are what make holding either one
        // re-jump the instant you land (ADR 0022); the two latches are what make a tap shorter than a tick
        // register at all. Both latches are drained every tick, dead or alive and menu or no menu, so a
        // press made during a pause cannot surface as a jump later. `stepCharacter` holds the press for
        // `jumpBufferTime` from here, which is what lets it land slightly before the ground does.
        const keyTap = input.takeJump()
        const touchTap = touch.drainJumpPress()
        const vyBefore = char.vy
        const groundedBefore = char.grounded
        controller!.step({
          moveX: move.x,
          moveZ: move.z,
          jump: !dead && (input.keys.has('Space') || touch.jump() || keyTap || touchTap),
          // Whatever else this game's controls do, by name (ADR 0061). Empty for a game that declared none,
          // which is every game the stack ships.
          actions: input.actions(),
        })
        // Landing, for the camera's dip below. Taken from the vertical speed *before* the step, since
        // `stepCharacter` zeroes it the moment footing is found. Scaled by the speed a plain jump lands at,
        // so a normal landing is 1 and a long drop is more.
        if (!groundedBefore && char.grounded && vyBefore < 0) {
          const ref = Math.sqrt(2 * tuning.gravity * tuning.jumpHeight)
          orbit.land(-vyBefore / ref)
        }
        // After the world has stepped: loose bodies only move on a tick, so this is where their new pose is
        // taken and the render loop interpolates between the last two. Ours and every peer's corpse are
        // bodies in this same world, so one call captures them all.
        avatars.capture()

        const p = controller!.state().get(id)
        if (p) {
          // Position plus everything about us a viewer cannot derive from it (v8/v9): vertical velocity
          // passes through zero at every jump apex, so "grounded" has to be told, not inferred; facing
          // follows the input rather than the movement; and locomotion speed is what is left after a
          // platform's carry is taken out. These are exactly the values our own rig is animated from,
          // just below — a peer's rig should be given the same numbers, not a guess at them.
          // The game's own states ride the spare bits of the same byte (ADR 0064) — five of them, already paid
          // for. Without this a peer mid-dash is drawn running, because a game-supplied animator reads its
          // state by closure (ADR 0063) and a closure cannot answer for somebody else's machine.
          const flags =
            (char.grounded ? STATE_GROUNDED : 0) |
            (char.vy > 0 ? STATE_RISING : 0) |
            (dead ? STATE_DEAD : 0) |
            packStates(mode.states, readOwnStates())
          // Riding a clock-driven piece? Then send the transform **in that piece's frame** and say which
          // piece it is (v10, ADR 0021). A viewer draws the level at its own current time and draws peers
          // on a delayed timeline, so a world position puts a rider where they were 100 ms ago on a deck
          // drawn where it is now — up to a metre out on the fast mover, and visibly sliding across the
          // deck as it turns around. The relative transform does not change while the platform moves, so
          // the two clocks stop mattering. `char.base.localPos` is the very same quantity the carry solver
          // already keeps for its own use, so nothing new is computed here.
          //
          // Index + 1, because 0 means "no base". Above 254 there is no room in the byte, so those pieces
          // fall back to world coordinates rather than aliasing onto another piece's frame.
          const baseIdx = char.base === undefined ? undefined : loaded?.baseIndex(char.base.colliderHandle)
          const base = baseIdx !== undefined && baseIdx < 255 ? baseIdx + 1 : 0
          const basePose = base === 0 ? undefined : loaded?.basePoseOf(base - 1, 'tick')
          net.send({
            position: basePose === undefined ? p : char.base!.localPos,
            flags,
            yaw: basePose === undefined ? ownFacing : ownFacing - yawOf(basePose.rotation),
            speed: Math.hypot(char.vx, char.vz),
            base: basePose === undefined ? 0 : base,
          })
          // Real contact: the colliders the capsule pushed against this tick. Handed straight to the
          // components on whatever nodes own them — a corpse triggers nothing, which is why this is gated.
          // Solids the capsule pushed against, plus the triggers it is standing inside (ADR 0054) 2014 a sensor
          // resolves no movement, so it never appears in `collisions` and has to be asked for.
          if (!dead) components.contact([...char.body.collisions(), ...char.body.overlaps()])
          // A rule killed us — a hazard pad, or the hazard plane under the level (ADR 0053). One question,
          // asked of the rules, which also consumes the flag. Gated on `dead`, because a corpse still resting
          // on the plane keeps generating contacts.
          if (rules.takeDeath() && !dead) die()
          // A rule moved us without killing us — cashing out at the end of a stage (ADR 0073). Position and
          // momentum only: the rig stays whole, so nothing about death is involved.
          const teleport = dead ? null : (rules.takeTeleport?.() ?? null)
          if (teleport !== null) {
            char.body.setPosition(teleport)
            // The same release a respawn needs, and for the same reason (ADR 0100): cashing out while riding
            // a platform used to leave `base` set, and the next tick dragged the player back onto it.
            releaseFooting(char)
          }
        }
      },
    })
  }

  /** What a game asked to have run every rendered frame (ADR 0066). */
  const frameHooks = createFrameHooks()
  /** Reused by `toScreen`, which a game may call once per popup per frame. */
  const projected = new THREEImpl.Vector3()
  /**
   * Every peer as the last render pass drew them (ADR 0068).
   *
   * Rebuilt in place each frame rather than reallocated, and read by `peers()` — so a frame hook sees the same
   * interpolation instant the bodies were drawn at.
   */
  let peerFrame: Peer[] = []

  // --- render ---
  let ownPos: Vec3 = { x: 0, y: 1, z: 0 }
  let ownState: CharacterState | null = null // set once the local sim exists; drives our own animation
  let lastFrameAt = performance.now()
  stage.start(() => {
    // Animation is evaluated per rendered frame, not per sim tick, so it is smooth at any refresh
    // rate; everything it drives is smoothed by half-life rather than per-frame fraction.
    const nowMs = performance.now()
    const frameDt = Math.min(0.1, (nowMs - lastFrameAt) / 1000)
    lastFrameAt = nowMs
    // Any tick that is due runs first, then everything is drawn at one fraction of the way into the next,
    // read off the loop's own schedule (ADR 0140). Interpolating by the time since a tick *ran* put each frame
    // off by however late the timer fired, times the speed of what was drawn: a rider saw the whole view shake.
    simLoop?.pump()
    const tickAlpha = simLoop === null ? 1 : simLoop.alpha()
    level?.render(tickAlpha)

    // Own character: our authoritative local sim, render-smoothed. Peers: interpolated.
    const seen = new Set<EntityId>()
    peerFrame = []
    const myId = net.id()
    if (myId !== null && controller) {
      seen.add(myId)
      ownPos = controller.renderPositions(tickAlpha).get(myId) ?? ownPos
      // Our own inputs are exact — we own the sim — so nothing is derived for us. Dead or assembling is
      // `@mp/tps`'s to picture; we only say which.
      avatars.drawSelf(
        myId,
        {
          isSelf: true,
          position: ownPos,
          yaw: ownFacing,
          speed: ownState !== null ? Math.hypot(ownState.vx, ownState.vz) : 0,
          vy: ownState?.vy ?? 0,
          grounded: ownState?.grounded ?? true,
          rising: (ownState?.vy ?? 0) > 0,
          // Motion we did not ask for — a platform carrying us, a bar shoving us, a wall stopping us.
          carry: ownState?.carry ?? null,
          // Our own rig is drawn from our own sim, in world space, on one timeline — there is no frame
          // change to smooth over, so this is always 0 for us however much platform we are riding.
          base: 0,
          name: net.myName,
          // The same set the outgoing state message used, so our rig and every peer's view of us agree.
          states: readOwnStates(),
        },
        frameDt,
        { dead, tickAlpha, at: ownPos },
      )
    }
    for (const e of net.sample())
      if (e.id !== myId) {
        seen.add(e.id)
        // Out of the base's frame and into the world, against the pose the deck was *drawn* at — which is
        // what pins a rider to a moving platform instead of leaving them 100 ms behind it (ADR 0021).
        // Everything below uses this, not `e.position`: the rig, the corpse it is seeded from, the spawn
        // assembly's targets.
        const at = worldFromBase(loaded, e, true)
        // What a game can read about them this frame (ADR 0068). Recorded here because this is where the base
        // frame has just been undone and the timeline is the one the rig is about to be drawn on.
        const peerStates = unpackStates(mode.states, e.flags)
        peerFrame.push({ id: e.id, position: at.position, yaw: at.yaw, states: peerStates })
        // Peers: facing, locomotion speed and grounded/rising all come off the wire (v8/v9) — a position
        // curve cannot tell facing from heading, nor walking from being carried. Only the vertical is
        // still derived, and it is the one place where carry riding along in it does no harm: the joint
        // lag wants total vertical motion, whatever caused it.
        //
        // A peer's death is one flag; what it *looks* like — the corpse, seeded from the pose this client
        // last drew them in, and the body dropping back in afterwards — is `@mp/tps`'s (ADR 0019, ADR 0065).
        avatars.drawPeer(
          e.id,
          {
            isSelf: false,
            position: at.position,
            yaw: at.yaw,
            speed: e.speed,
            vy: null,
            grounded: (e.flags & STATE_GROUNDED) !== 0,
            rising: (e.flags & STATE_RISING) !== 0,
            // A peer's platform carry, for nothing on the wire: v10 already says *which* piece they are
            // riding, and a piece's own motion is known to every client, so the velocity it imparts at the
            // rider's exact spot is derivable here. That is the dominant case — a deck starting, stopping
            // or reversing under someone — and it is why a peer now braces against it like its owner does.
            // Still missing: being shoved by something you are *not* standing on, and a wall taking your
            // momentum. Neither is a base, and both would need real bytes (ADR 0021).
            carry: e.base === 0 ? null : loaded?.baseCarry(e.base - 1, e.position) ?? null,
            // Their game states, out of the spare flag bits (ADR 0064). This is the whole of what makes a
            // peer's dash look like a dash rather than a run.
            states: peerStates,
            base: e.base,
            name: net.nameOf(e.id) ?? '…',
          },
          frameDt,
          { dead: (e.flags & STATE_DEAD) !== 0, tickAlpha },
        )
      }
    // Drop players who left the room, and whatever they were mid-way through.
    avatars.prune(seen)

    // Touch: one drain per frame, applied exactly where the mouse and wheel handlers apply theirs. Drained
    // rather than read, so a frame never consumes the same drag twice (ADR 0022).
    if (touch.active()) {
      // The menu owns the screen while it is open: no routing, no camera swing, nothing held. Closed until the
      // overlay exists, so the first frames route normally rather than being treated as paused.
      const paused = shell?.isOpen() ?? false
      touch.setEnabled(!paused)
      const t = touch.drainLook()
      orbit.lookTouch(t.dx, t.dy)
      if (t.pinch !== 0) orbit.zoomPinch(t.pinch)
      // Tap in the look region = the mobile respawn, matching desktop's left click.
      if (t.tapped && dead && !paused) requestRespawn?.()
      if (shell !== null) {
        shell.touchHud.setVisible(!paused)
        shell.touchHud.draw(touch.joystick(), touch.jumpButton())
      }
    }


    /**
     * The camera, and with it the see-through hole and the visibility of your own rig. One call, because all
     * of it is `@mp/camera`'s now (ADR 0056) — what it needs from here is the character's capsule centre and
     * somewhere to report the surfaces it wants holed.
     */
    const placed = orbit.update(frameDt, ownPos, (handles: readonly number[]) => level?.setOccluders(handles))
    // Whether your own rig is drawn. Three things want a say and only this one is the client's, so the
    // camera's answer goes in and `@mp/tps` resolves it against the other two. After the camera, because it
    // needs this frame's placement rather than last frame's. Peers are unaffected — they always see you.
    if (myId !== null) avatars.setSelfVisible(myId, placed.rigVisible)

    // The game's own drawing, last: the level is posed, every body is drawn and the camera is placed, so
    // `partsOf` and `camera` answer for this frame (ADR 0066).
    frameHooks.run(frameDt)

    // The frame meter, after everything this frame does — the game's own hooks included, which is the point of
    // measuring at all (ADR 0070). A no-op while it is switched off.
    pane.frame()
  })
  /**
   * The page around the game (`shell.ts`, ADR 0065): the 2D overlay, the pause screen, the touch HUD, and the
   * pointer-lock handoff that makes lock *be* the pause state on a mouse.
   *
   * Awaited **after** the render loop has started, exactly as it was inline — which is why `shell` is nullable
   * and the loop above checks it. A frame can and does run before the overlay exists.
   */
  shell = await createShell({
    canvas,
    isTouch: () => touch.active(),
    sensitivity: {
      get: () => orbit.params.sensitivity,
      set: (v) => {
        orbit.params.sensitivity = v
      },
    },
    roster: () => {
      const me = net.id()
      return { me: net.myName, peers: net.roster().filter((peer) => peer.id !== me).map((peer) => peer.name) }
    },
    onRestart: () => requestRespawn?.(),
  })

  let disposed = false
  return {
    scene: stage.scene,
    camera: orbit,
    tuning,
    // Non-null by here: `createShell` is awaited above, which is also why the render loop's own reads of
    // `shell` are guarded and this is not.
    ui: shell.ui,
    toScreen: (world) => {
      projected.set(world.x, world.y, world.z).project(stage.camera)
      // `project` divides by w, which is negative behind the lens — the point comes back mirrored into view
      // rather than absent, so it has to be rejected explicitly.
      if (projected.z > 1) return null
      return {
        x: ((projected.x + 1) / 2) * shell.ui.width,
        // Clip space has +y up and the overlay has +y down.
        y: ((1 - projected.y) / 2) * shell.ui.height,
      }
    },
    debugPane: pane.pane,
    id: () => net.id(),
    peers: () => peerFrame,
    partsOf: (id) => avatars.partsOf(id),
    world: () => physicsWorld,
    level: () => loaded,
    meshesOf: (node) => {
      if (level === null) return []
      // A node drawing a model lists all its colliders against one mesh; dedupe so a caller sees each once.
      const out = new Set<THREE.Mesh>()
      for (const handle of node.colliderHandles) for (const mesh of level.meshesOf(handle)) out.add(mesh)
      return [...out]
    },
    material: (assetId) => level?.material(assetId) ?? null,
    data: (assetId) => level?.data(assetId),
    excludeFromAO: (object) => {
      aoExcluded.add(object)
      return () => aoExcluded.delete(object)
    },
    onFrame: frameHooks.add,
    dispose: () => {
      if (disposed) return
      disposed = true
      // (1) Nothing ticks from here. Both loops, before anything they read is taken away — and the game's own
      // frame hooks with them, since they read `poseOf` and the world.
      stage.stop()
      simLoop?.stop()
      frameHooks.clear()
      // (2) The connection, and the timer that was feeding it.
      net.dispose()
      // (3) The DOM. `input` owns seven listeners, the shell owns two.
      input.dispose()
      shell?.dispose()
      // (4) What is drawn: rigs and nametags, the level's meshes and lights, every loose body, the pane.
      avatars.dispose()
      level?.dispose()
      pane.dispose()
      // (5) The renderer, then the world. The world is last because step (1) is the only guarantee that
      // nothing will touch it again, and freeing it is the one step that cannot be undone.
      postfx.dispose()
      stage.dispose()
      physicsWorld?.free()
      physicsWorld = null
    },
  }
}

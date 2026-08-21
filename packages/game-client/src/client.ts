import {
  createClockSync,
  createLocalController,
  createSnapshotClient,
  createSnapshotReassembler,
  type LocalController,
  type LocalWorld,
} from '@mp/client'
import { clamp, createSimClock, rotateVec3, startFixedLoop, vec3, yawOf, type EntityId, type Vec3 } from '@mp/core'
import {
  decodePong,
  decodeRoster,
  decodeSnapshot,
  decodeWelcome,
  encodePing,
  encodeState,
  MSG_PONG,
  MSG_ROSTER,
  MSG_SNAPSHOT,
  MSG_WELCOME,
  NET_CHANNEL,
  readMessageType,
  STATE_DEAD,
  STATE_GROUNDED,
  STATE_RISING,
} from '@mp/net'
import { createPhysicsWorld, initPhysics, type PhysicsBody, type PhysicsWorld } from '@mp/physics'
import { addLevel, addLights, assetIdsIn, createAssetRuntime, type ContentLights, type LevelView } from '@mp/render-three'
import {
  addCharacter,
  CHAR_HALF_HEIGHT,
  CHAR_RADIUS,

  stepCharacter,
  TICK_DT,
  TICK_RATE_HZ,
  type CharacterState,
  type CharacterTuning,
  DEFAULT_GAIT,
  partTransforms,
  type GaitTuning,
} from '@mp/character'
import { createOrbitCamera, type OcclusionQueries } from '@mp/camera'
import type { ModeDescriptor } from '@mp/mode'
import { instantiateLevel, type LoadedLevel } from '@mp/content'
import { characterAccess, createComponentRuntime, type ComponentRuntime } from '@mp/components'
import { t } from '@mp/i18n'
import { createTouchHud, createUiOverlay, uiButton, type ListItem, type TouchHud } from '@mp/render-pixi'
import { Client, type Room } from 'colyseus.js'

import { createAssembly, type Assembly, type AssemblyTiming } from './assemble'
import { createInputs } from './inputs'
import { installDebugPane } from './pane'
import { createScene } from './scene'
import { createStatusLine } from './status'
import { createCharacterViews, PEER_COLORS, SELF_COLORS } from './characterView'
import { BODY_LAYERS } from './layers'
import { createPauseMenu } from './pauseMenu'
import { createRagdoll, type Ragdoll } from './ragdoll'
import { ASSET_DB, CLIP_SOURCE, assetUrlOf, materialOf } from './assets'
import { levelsFor } from './levels'
import { localProgress } from './persistence'

/**
 * The game client, for any game on the platform (ADR 0056).
 *
 * A `ModeDescriptor` is the whole of what varies: its registry validates and instantiates the level, its
 * tuning drives the controller, its `session` is the rules, its `spawn` places arrivals, and its name picks
 * the level list and the save key. Everything else here — the Three stage, the post-FX, the asset preload,
 * joining a room, interpolation, peer views, nametags, the ragdoll and spawn assembly, the pause screen, the
 * debug pane, touch, and the render loop — is the same for every game, which is exactly why it stopped being
 * a game's file.
 *
 * **Moved, not redesigned.** This was `modes/parkour/src/main.ts` and it is still one long composition
 * root; the entry point is what is new. Breaking it into scene / netcode / render modules is the follow-up,
 * and it is safe to do incrementally now that callers only see `startGameClient`.
 *
 * The host page owes it two elements: a `#view` canvas and a `#status` line.
 */
export const startGameClient = async (mode: ModeDescriptor): Promise<void> => {

  // Relay endpoint. Defaults to the dev host on :9200. `?server=wss://host` overrides it, so a
  // tunnelled page (served from a different origin than the relay) can point at its own relay URL.
  const SERVER_URL = new URLSearchParams(location.search).get('server') ?? `ws://${location.hostname}:9200`

  /**
   * Which level: `?level=<name>` picks a file from `content/levels/`, no param gets `default.json`. A typo
   * falls back to the default rather than bricking the page, and says so in the console.
   *
   * The name also picks the **room** — see `connect`. Everyone sharing a room has to be on the same
   * level: the geometry differs, and so does the movement-base index a rider puts on the wire, which is
   * assigned in instance order at load (ADR 0021). Mismatched clients would place each other on the
   * wrong platform entirely.
   */
  const levels = levelsFor(mode.name, mode.registry)
  const levelName = ((): string => {
    const requested = new URLSearchParams(location.search).get('level')
    if (requested === null) return levels.defaultName
    try {
      levels.byName(requested)
      return requested
    } catch (e) {
      console.error(`${String(e)} — falling back to ${levels.defaultName}`)
      return levels.defaultName
    }
  })()
  const levelData = levels.byName(levelName)

  const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!
  const canvas = $<HTMLCanvasElement>('#view')
  const statusEl = $<HTMLDivElement>('#status')

  // The status line owns the locale too, because the line is key-driven and has to re-render on a switch.
  const status = createStatusLine(statusEl)
  const setStatus = status.set

  // The scene: stage, greybox pipeline, sky, post-FX, and the render step that draws nametags after
  // post-FX. The AO pass asks for the currently-holed surfaces fresh each frame — the level does not exist
  // yet, it arrives with the first snapshot (ADR 0055).
  const { stage, env, postfx, photoSky } = await createScene(canvas, () => levelView?.occluding() ?? [])

  // Player views (own + peers): the blocky rig, procedurally animated, + billboard nametag.
  // One shared gait object so the debug pane retunes every character live (ADR 0018).
  const gait: GaitTuning = { ...DEFAULT_GAIT }
  const views = createCharacterViews(stage.scene, gait)
  // Spawn assembly timing. Declared up here so the debug pane below can bind it.
  const assembleTiming: AssemblyTiming = { stagger: 0.05, fall: 0.18, height: 2.5 }

  // --- camera orbit (mouselook via pointer lock) ---
  /**
   * The whole camera is `@mp/camera` now (ADR 0056): boom, zoom, occlusion, the see-through hole, the landing
   * dip and the own-rig hide. It used to be some 300 lines here, which a second game would have had to copy
   * and every fix would have had to be made twice.
   *
   * What stays in this file is what a *host* owes it: the DOM events it has no business knowing about, the
   * physics queries once a world exists, and the character position to orbit.
   */
  const orbit = createOrbitCamera(stage.camera)
  /**
   * A peer's world transform from what the wire carried (v10, ADR 0021). While `base` is non-zero the
   * position and facing are in that clock-driven piece's frame, so they have to be brought back out
   * through the piece's pose — and *which* pose matters: `rendered` for anything drawn, so the rider sits
   * still on the deck the eye can see, and the sim tick's for the collision proxy, which resolves against
   * where physics has the deck.
   *
   * Falls back to treating the values as world-space if the piece is unknown, which is what a client that
   * somehow lacks it should do: slightly wrong beats nowhere.
   */
  const worldFromBase = (e: { position: Vec3; yaw: number; base: number }, rendered: boolean): { position: Vec3; yaw: number } => {
    const pose = e.base === 0 ? undefined : loaded?.basePoseOf(e.base - 1, rendered ? 'render' : 'tick')
    if (pose === undefined) return { position: e.position, yaw: e.yaw }
    const p = rotateVec3(pose.rotation, e.position)
    return {
      position: vec3(pose.position.x + p.x, pose.position.y + p.y, pose.position.z + p.z),
      yaw: e.yaw + yawOf(pose.rotation),
    }
  }

  /** Post-processing switches, kept because a hole in a surface leaves its *shading* behind (ADR 0055). */
  const debug = { sunShadows: true, ambientOcclusion: true }
  // Everything the player presses (`inputs.ts`), which is also what keeps the camera DOM-free: a mouse
  // delta becomes `lookMouse`, a wheel tick becomes `zoomNotch` (ADR 0056).
  const input = createInputs({
    canvas,
    camera: orbit,
    isDead: () => dead,
    onRespawn: () => requestRespawn?.(),
  })
  const touch = input.touch
  /**
   * The on-screen controls, and whether the pause menu is up. Both live on the Pixi overlay, which is built
   * with an `await` **after** the render loop starts — so a frame can run before they exist and the loop has
   * to cope with that rather than reference them eagerly.
   */
  let touchHud: TouchHud | null = null
  let menuOpen: () => boolean = () => false


  // Live locomotion feel, owned here because the sim and the render loop both read it. The pane only binds it.
  const tuning: CharacterTuning = { ...mode.tuning }
  // Everything live-tunable, in one place (`pane.ts`). It is pure wiring — every folder binds an object
  // somebody else owns — so it is the one part of this file that came out whole.
  installDebugPane({
    camera: orbit,
    debug,
    stage,
    photoSky,
    env,
    postfx,
    tuning,
    gait,
    touchLayout: input.layout,
    assembleTiming,
    onTouchIgnore: input.ignore,
    onDeath: () => requestDeath?.(),
  })

  // --- netcode (Colyseus rooms, ADR 0013) ---
  const clock = createClockSync()
  const reassembler = createSnapshotReassembler()
  const interp = createSnapshotClient({ interpolationDelayMs: 100, serverNow: () => clock.serverNow() })
  let myId: EntityId | null = null
  let controller: LocalController | null = null
  let ownFacing = 0
  let room: Room | null = null
  let loaded: LoadedLevel | null = null // the instantiated level (colliders + markers + visuals)
  let levelView: LevelView | null = null // Three meshes for the level; sync() re-poses moving pieces
  let levelLights: ContentLights | null = null // content lights (ADR 0047); the sun is the sky's, not one of these
  let lastSimTickAt = 0 // wall-clock of the last fixed tick, for render-interpolating clock-driven pieces
  let requestRespawn: (() => void) | null = null // set once the local sim exists; used by the pause menu's Restart
  let requestDeath: (() => void) | null = null // set once the local sim exists; the death path, for the ragdoll
  // Death state. `dead` gates input and the kill checks; `ragdoll` is the loose bodies, synced per frame
  // and thrown away on respawn. Local and visual only — nothing about a death goes on the wire.
  let dead = false
  let ragdoll: Ragdoll | null = null
  /**
   * Peers' corpses, one per dead remote player. A death travels as a single flag (`STATE_DEAD`) and the
   * ragdoll is built here, from *this* client's interpolated pose of that player — so every viewer's
   * corpse lands somewhere different and no part positions ever go on the wire (ADR 0019).
   */
  const peerRagdolls = new Map<EntityId, Ragdoll>()
  /**
   * Peers' spawn assemblies, one per peer whose body is currently dropping back in. Same trigger as the
   * corpse — the *falling* edge of `STATE_DEAD` — and the same timing knobs, so a respawn looks the same
   * from the outside as it does to the player it happened to.
   */
  const peerAssemblies = new Map<EntityId, { assembly: Assembly; elapsed: number }>()
  /** The client's own physics world, once the local sim exists. Peer corpses are dynamic bodies in it. */
  let physicsWorld: PhysicsWorld | null = null
  // Spawn assembly: the body drops in a pair at a time. Runs on the first spawn and every respawn, and owns
  // the rig's visibility while it does — the rig only reappears once the last part has landed.
  let assembly: Assembly | null = null
  let assembledFor = 0
  const startAssembly = (): void => {
    assembly?.dispose()
    assembly = createAssembly({ scene: stage.scene, look: { colors: SELF_COLORS } })
    assembledFor = 0
  }
  const clearRagdoll = (): void => {
    ragdoll?.dispose()
    ragdoll = null
    dead = false
  }
  const names = new Map<EntityId, string>() // peer id -> display name (from ROSTER)

  // Auto-assigned random display name (player-chosen names come later — ADR 0013).
  const ADJ = ['Swift', 'Brave', 'Calm', 'Lucky', 'Sly', 'Bold', 'Keen', 'Wily']
  const NOUN = ['Fox', 'Otter', 'Hawk', 'Wolf', 'Lynx', 'Crow', 'Bear', 'Mole']
  const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)]!
  const myName = `${pick(ADJ)} ${pick(NOUN)}`
  // Colyseus onMessage hands us a Uint8Array view; our codecs take a standalone ArrayBuffer.
  const toArrayBuffer = (m: Uint8Array): ArrayBuffer => {
    const copy = new Uint8Array(m.byteLength)
    copy.set(m)
    return copy.buffer
  }

  // Per-player state behind a pluggable adapter (mode seam): local now, account-backed later.
  const persistence = localProgress(mode.name)

  const initLocalSim = async (id: EntityId): Promise<void> => {
    await initPhysics()
    // Client-owned world (ADR 0011). The character is kinematic and integrates its own gravity, so Rapier's
    // gravity never touches it — but the ragdoll's parts are *dynamic* and it is the only thing that pulls
    // them down. It was zero here, which left a corpse coasting off in a straight line for ever.
    const world = createPhysicsWorld({ gravity: { x: 0, y: -tuning.gravity, z: 0 } })
    physicsWorld = world // the render loop builds peers' corpses in it
    loaded = instantiateLevel(world, levelData, mode.registry, CLIP_SOURCE)

    // Build the level's greybox meshes via the shared renderer (content C3). Marker pads are
    // just their (colour-coded) box here; radius/overlay visualization belongs in the viewer.
    // Assets first, then build: `addLevel` is synchronous, so a level is never briefly walkable with its
    // models still arriving. Anything unreferenced is never fetched, so a greybox level costs nothing.
    const assets = createAssetRuntime({ db: ASSET_DB, urlOf: assetUrlOf, materialOf })
    await assets.load(assetIdsIn(loaded.visuals))
    levelView = addLevel(stage.scene, loaded.visuals, { assets, cutout: orbit.cutout })
    levelLights = addLights(stage.scene, loaded.lights)
    // The level owns its sun, and moving it rebakes the sky so the two cannot disagree (ADR 0048).
    env.applyEnvironment(loaded.config.environment)
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
     * What stays in this file is what a *client* does about it — persistence, ragdolls, assembly, the camera.
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
     * single frame and would report zero clearance; and while dead the ragdoll's parts are our own body too,
     * not scenery to be shoved away from.
     */
    /**
     * What the camera must not be shoved by: our own capsule, our own corpse, and **every** corpse. A living
     * peer is mirrored as a kinematic capsule here, so they do move the camera — but a ragdoll is a visual
     * whose position no two clients agree on, and ten cuboids tumbling round your feet because someone died
     * next to you should not shove your view. Read fresh per query, since the ragdoll comes and goes.
     */
    const selfColliders = (): number[] => {
      const skip = [char.body.colliderHandle, ...(ragdoll?.colliders ?? [])]
      for (const corpse of peerRagdolls.values()) skip.push(...corpse.colliders)
      return skip
    }
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

    // Respawn: teleport to wherever the rules say (the last checkpoint, or the spawn) and kill momentum.
    // Triggered by touching a hazard pad or falling below the kill plane — both are `takeDeath`'s call now.
    const respawn = (): void => {
      clearRagdoll()
      char.body.setPosition(rules.respawnAt())
      char.vx = 0
      char.vy = 0
      char.vz = 0
      char.grounded = false
      startAssembly()
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
    const components: ComponentRuntime = createComponentRuntime(loaded, mode.registry, {
      character: characterAccess(char),
      effects: rules.effects,
    })
    // Tick 0 at level time 0: the clock has not started, and a component that wants "now" gets it in
    // `onFixedUpdate`. Counted here rather than read off the clock so the number a component sees is the
    // number of steps this level has run, which is what a deterministic fold is indexed by.
    let tickCount = 0
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
      const pose = views.poseOf(id)
      if (pose === null) return // no rig drawn yet; nothing to fall apart
      dead = true
      ragdoll = createRagdoll({
        world,
        scene: stage.scene,
        transforms: partTransforms(pose, char.body.translation()),
        velocity: vec3(char.vx, char.vy, char.vz),
        look: { colors: SELF_COLORS },
      })
    }
    requestDeath = die
    startAssembly() // the first spawn arrives the same way a respawn does

    // This local sim IS the truth for our own character (client-authoritative, ADR 0011).
    // Clock-driven pieces advance one fixed step per fixed step, tracking the synced server
    // clock by slewing. Reading `serverNow()` directly here would stall the platforms whenever
    // the loop runs several ticks in one wake, while the character kept advancing a full step
    // each — the platform-carry jitter (see @mp/core simClock).
    const simClock = createSimClock({ tickMs: TICK_DT * 1000, reference: () => clock.serverNow() })

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
        const half = TICK_DT / 2
        const nowMs = simClock.tick()
        loaded?.update(nowMs, char.base?.colliderHandle)
        // Components run on the synced clock, before physics, so what one of them writes is what this tick
        // resolves against. Nothing built in uses it yet; an authored component would.
        components.fixedUpdate(++tickCount, nowMs, TICK_DT)
        world.step(half) // (A) platforms move
        stepCharacter(char, cmd, TICK_DT, tuning, loaded?.basePose) // rides whatever it stands on
        world.step(half) // (B) character resolves against the moved platforms
        lastSimTickAt = performance.now()
      },
      readState: () => new Map<EntityId, Vec3>([[id, char.body.translation()]]),
    }
    controller = createLocalController({ world: local, tickRateHz: TICK_RATE_HZ })

    // Remote players mirrored as kinematic capsules so walking into one collides locally.
    const remotes = new Map<EntityId, PhysicsBody>()
    const syncRemotes = (): void => {
      const seen = new Set<EntityId>()
      for (const e of interp.sample()) {
        if (e.id === id) continue
        seen.add(e.id)
        let mirror = remotes.get(e.id)
        if (mirror === undefined) {
          mirror = world.addKinematicBody({
            position: worldFromBase(e, false).position,
            shape: { kind: 'capsule', halfHeight: CHAR_HALF_HEIGHT, radius: CHAR_RADIUS },
            // A body, so corpses pass through it: a dead peer's mirror stands invisibly at their death
            // point and their own parts were landing on it.
            layers: BODY_LAYERS,
          })
          remotes.set(e.id, mirror)
        }
        mirror.setNextKinematicTranslation(worldFromBase(e, false).position)
      }
      for (const [rid, mirror] of remotes)
        if (!seen.has(rid)) {
          mirror.remove()
          remotes.delete(rid)
        }
    }

    startFixedLoop({
      tickRateHz: TICK_RATE_HZ,
      onTick: () => {
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
        controller!.step(move.x, move.z, !dead && (input.keys.has('Space') || touch.jump() || keyTap || touchTap))
        // Landing, for the camera's dip below. Taken from the vertical speed *before* the step, since
        // `stepCharacter` zeroes it the moment footing is found. Scaled by the speed a plain jump lands at,
        // so a normal landing is 1 and a long drop is more.
        if (!groundedBefore && char.grounded && vyBefore < 0) {
          const ref = Math.sqrt(2 * tuning.gravity * tuning.jumpHeight)
          orbit.land(-vyBefore / ref)
        }
        // After the world has stepped: a ragdoll's bodies only move on a tick, so this is where their new
        // pose is taken. The render loop interpolates between the last two. Peers' corpses are bodies in
        // this same world, so they are captured on the same tick.
        ragdoll?.capture()
        for (const corpse of peerRagdolls.values()) corpse.capture()

        const p = controller!.state().get(id)
        if (p) {
          // Position plus everything about us a viewer cannot derive from it (v8/v9): vertical velocity
          // passes through zero at every jump apex, so "grounded" has to be told, not inferred; facing
          // follows the input rather than the movement; and locomotion speed is what is left after a
          // platform's carry is taken out. These are exactly the values our own rig is animated from,
          // just below — a peer's rig should be given the same numbers, not a guess at them.
          const flags =
            (char.grounded ? STATE_GROUNDED : 0) | (char.vy > 0 ? STATE_RISING : 0) | (dead ? STATE_DEAD : 0)
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
          room?.sendBytes(
            NET_CHANNEL,
            new Uint8Array(
              encodeState({
                position: basePose === undefined ? p : char.base!.localPos,
                flags,
                yaw: basePose === undefined ? ownFacing : ownFacing - yawOf(basePose.rotation),
                speed: Math.hypot(char.vx, char.vz),
                base: basePose === undefined ? 0 : base,
              }),
            ),
          )
          // Real contact: the colliders the capsule pushed against this tick. Handed straight to the
          // components on whatever nodes own them — a corpse triggers nothing, which is why this is gated.
          // Solids the capsule pushed against, plus the triggers it is standing inside (ADR 0054) 2014 a sensor
          // resolves no movement, so it never appears in `collisions` and has to be asked for.
          if (!dead) components.contact([...char.body.collisions(), ...char.body.overlaps()])
          // A rule killed us — a hazard pad, or the hazard plane under the level (ADR 0053). One question,
          // asked of the rules, which also consumes the flag. Gated on `dead`, because a corpse still resting
          // on the plane keeps generating contacts.
          if (rules.takeDeath() && !dead) die()
        }
      },
    })
  }

  const onNet = (m: Uint8Array): void => {
    const buf = toArrayBuffer(m)
    switch (readMessageType(buf)) {
      case MSG_WELCOME:
        myId = decodeWelcome(buf).playerId
        void initLocalSim(myId)
        break
      case MSG_SNAPSHOT:
        // Peers only (the server never relays our own body back to us); interpolate.
        interp.ingest(reassembler.apply(decodeSnapshot(buf)))
        break
      case MSG_ROSTER:
        names.clear()
        for (const e of decodeRoster(buf)) names.set(e.id, e.name)
        break
      case MSG_PONG: {
        const pong = decodePong(buf)
        clock.recordSample(pong.clientTimeMs, pong.serverTimeMs, performance.now())
        break
      }
    }
  }

  // Colyseus matchmaking: joinOrCreate fills the most-full non-full room, else spins up a
  // new one (auto-join, no matchmaking UI — ADR 0013). A raw WebSocket won't do; the SDK
  // performs the HTTP seat reservation then upgrades.
  const connect = async (): Promise<void> => {
    try {
      // `game` and `level` are matchmaking filters (server: `.filterBy(['game', 'level'])`), so a room only ever
      // holds players in the same game on the same level. One room type serves every game on the platform; which
      // game it is is a filter, not a room name (ADR 0052) — see the note on `levelName`.
      room = await new Client(SERVER_URL).joinOrCreate('game', { name: myName, game: mode.name, level: levelName })
    } catch {
      setStatus('status.offline')
      return
    }
    setStatus('status.room', { room: room.roomId })
    room.onMessage(NET_CHANNEL, onNet)
    room.onLeave(() => {
      setStatus('status.offline')
    })
    setInterval(() => room?.sendBytes(NET_CHANNEL, new Uint8Array(encodePing({ clientTimeMs: performance.now() }))), 250)
  }
  void connect()

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
    // Clock-driven pieces advance in the fixed sim loop; here we only render-interpolate
    // their meshes between the last two ticks (same timeline as the player), then sync.
    const tickAlpha = clamp((performance.now() - lastSimTickAt) / (1000 / TICK_RATE_HZ), 0, 1)
    if (loaded !== null) {
      loaded.render(tickAlpha)
      levelView?.sync()
      levelLights?.sync()
    }

    // Own character: our authoritative local sim, render-smoothed. Peers: interpolated.
    const seen = new Set<EntityId>()
    if (myId !== null && controller) {
      seen.add(myId)
      ownPos = controller.renderPositions().get(myId) ?? ownPos
      // Dead: the rig is hidden and the ragdoll's bodies own the picture. Still counted as `seen`, so the
      // hidden rig is not pruned and can simply be shown again on respawn.
      if (dead) ragdoll?.sync(tickAlpha)
      // Our own inputs are exact — we own the sim — so nothing is derived for us.
      else
        views.upsert(
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
            name: myName,
          },
          frameDt,
        )
      // Assembling: the animator still runs above (the parts fall toward the pose it produces, so a player
      // already walking has their body arrive around them), but the rig itself stays hidden until the last
      // part lands. The hiding is the camera block's job at the end of the frame — one writer for it.
      if (!dead && assembly !== null) {
        assembledFor += frameDt
        const pose = views.poseOf(myId)
        if (pose === null || assembly.draw(partTransforms(pose, ownPos), assembledFor, assembleTiming)) {
          assembly.dispose()
          assembly = null
        }
      }
    }
    for (const e of interp.sample())
      if (e.id !== myId) {
        seen.add(e.id)
        // Out of the base's frame and into the world, against the pose the deck was *drawn* at — which is
        // what pins a rider to a moving platform instead of leaving them 100 ms behind it (ADR 0021).
        // Everything below uses this, not `e.position`: the rig, the corpse it is seeded from, the spawn
        // assembly's targets.
        const at = worldFromBase(e, true)
        // A peer's death is one flag; the corpse is ours to build and ours alone (ADR 0019). It is seeded
        // from the pose *this* client last drew them in, so it starts exactly where the rig was.
        const peerDead = (e.flags & STATE_DEAD) !== 0
        let corpse = peerRagdolls.get(e.id)
        if (corpse !== undefined && !peerDead) {
          // They respawned. The corpse goes and the body drops back in, exactly as it does for us — the rig
          // stays hidden until the last part lands.
          corpse.dispose()
          peerRagdolls.delete(e.id)
          corpse = undefined
          // Their position just jumped to a checkpoint. Differenced, that teleport reads as a sprint, and
          // the assembly falls toward whatever pose the animator is in.
          views.resetMotion(e.id, at.position)
          peerAssemblies.get(e.id)?.assembly.dispose()
          peerAssemblies.set(e.id, {
            assembly: createAssembly({ scene: stage.scene, look: { colors: PEER_COLORS } }),
            elapsed: 0,
          })
        }
        if (corpse === undefined && peerDead && physicsWorld !== null) {
          const pose = views.poseOf(e.id)
          // No pose means their rig has never been drawn — a peer who was already dead when we joined.
          // Let them draw standing for one frame; the ragdoll goes up on the next.
          if (pose !== null) {
            corpse = createRagdoll({
              world: physicsWorld,
              scene: stage.scene,
              transforms: partTransforms(pose, at.position),
              velocity: views.velocityOf(e.id) ?? vec3(),
              look: { colors: PEER_COLORS },
            })
            peerRagdolls.set(e.id, corpse)
            views.setVisible(e.id, false)
            // Killed again mid-assembly: the corpse owns the picture from here.
            const spawning = peerAssemblies.get(e.id)
            if (spawning !== undefined) {
              spawning.assembly.dispose()
              peerAssemblies.delete(e.id)
            }
          }
        }
        // Dead: the corpse owns the picture, and the rig is left hidden and un-animated behind it.
        if (corpse !== undefined) corpse.sync(tickAlpha)
        // Peers: facing, locomotion speed and grounded/rising all come off the wire (v8/v9) — a position
        // curve cannot tell facing from heading, nor walking from being carried. Only the vertical is
        // still derived, and it is the one place where carry riding along in it does no harm: the joint
        // lag wants total vertical motion, whatever caused it.
        else
          views.upsert(
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
              base: e.base,
              name: names.get(e.id) ?? '…',
            },
            frameDt,
          )
        // Assembling: the animator above has run, so the falling parts have a live pose to arrive at — a
        // peer already walking when they respawn has their body land around them, same as for us.
        const spawning = corpse === undefined ? peerAssemblies.get(e.id) : undefined
        if (spawning !== undefined) {
          views.setVisible(e.id, false)
          spawning.elapsed += frameDt
          const pose = views.poseOf(e.id)
          if (pose === null || spawning.assembly.draw(partTransforms(pose, at.position), spawning.elapsed, assembleTiming)) {
            spawning.assembly.dispose()
            peerAssemblies.delete(e.id)
            views.setVisible(e.id, true)
          }
        }
      }
    views.prune(seen) // drop players who left the room (no longer relayed)
    // A player who leaves mid-death or mid-respawn takes both with them; `views.prune` only knows rigs.
    for (const [pid, corpse] of peerRagdolls)
      if (!seen.has(pid)) {
        corpse.dispose()
        peerRagdolls.delete(pid)
      }
    for (const [pid, spawning] of peerAssemblies)
      if (!seen.has(pid)) {
        spawning.assembly.dispose()
        peerAssemblies.delete(pid)
      }

    // Touch: one drain per frame, applied exactly where the mouse and wheel handlers apply theirs. Drained
    // rather than read, so a frame never consumes the same drag twice (ADR 0022).
    if (touch.active()) {
      // The menu owns the screen while it is open: no routing, no camera swing, nothing held.
      touch.setEnabled(!menuOpen())
      const t = touch.drainLook()
      orbit.lookTouch(t.dx, t.dy)
      if (t.pinch !== 0) orbit.zoomPinch(t.pinch)
      // Tap in the look region = the mobile respawn, matching desktop's left click.
      if (t.tapped && dead && !menuOpen()) requestRespawn?.()
      if (touchHud !== null) {
        touchHud.setVisible(!menuOpen())
        touchHud.draw(touch.joystick(), touch.jumpButton())
      }
    }


    /**
     * The camera, and with it the see-through hole and the visibility of your own rig. One call, because all
     * of it is `@mp/camera`'s now (ADR 0056) — what it needs from here is the character's capsule centre and
     * somewhere to report the surfaces it wants holed.
     */
    const placed = orbit.update(frameDt, ownPos, (handles: readonly number[]) => levelView?.setOccluders(handles))
    /**
     * Three things want a say in whether your rig is drawn, and the third needs the camera placed first:
     * death (the ragdoll has the floor), the spawn assembly (the body has not landed yet), and the camera
     * being inside you. Peers are unaffected — they always see you.
     */
    if (myId !== null) views.setVisible(myId, !dead && assembly === null && placed.rigVisible)
  })
  // --- pause screen (Pixi UI, ADR 0015) ---
  // A transparent Pixi canvas stacked over the Three canvas. The pause screen composition
  // lives in pauseMenu.ts; this wires it to the game (params, roster, respawn) and manages the
  // pointer-lock handoff.
  /**
   * Sized from the **canvas**, not from `window.innerWidth/innerHeight`. The canvas is `dvh`-sized, so on
   * mobile it is shorter than the layout viewport; taking the overlay's size from the window instead would
   * put the drawn controls a browser-bar's height away from the touch zones, which come from the canvas rect.
   * One source for both means they cannot drift.
   */
  const viewSize = (): { width: number; height: number } => ({
    width: canvas.clientWidth || window.innerWidth,
    height: canvas.clientHeight || window.innerHeight,
  })
  const ui = await createUiOverlay(viewSize())
  ui.canvas.style.position = 'fixed'
  ui.canvas.style.inset = '0'
  ui.canvas.style.zIndex = '10'
  document.body.appendChild(ui.canvas)

  const SENS_MIN = 0.0005
  const SENS_MAX = 0.006

  const pause = createPauseMenu(ui, {
    onResume: () => resumePlay(),
    onRestart: () => {
      requestRespawn?.()
      resumePlay()
    },
    sensitivity: {
      get: () => (orbit.params.sensitivity - SENS_MIN) / (SENS_MAX - SENS_MIN),
      set: (t) => {
        orbit.params.sensitivity = SENS_MIN + t * (SENS_MAX - SENS_MIN)
      },
    },
    players: () => {
      const items: ListItem[] = [{ text: t('pause.self', { name: myName }), highlight: true }]
      for (const [pid, name] of names) if (pid !== myId) items.push({ text: name })
      return items
    },
  })

  touchHud = createTouchHud(ui.root)
  menuOpen = () => pause.isOpen()

  const resumePlay = (): void => {
    pause.close()
    // Touch has no lock to take, and requesting one on mobile either throws or does nothing (ADR 0022).
    if (!touch.active()) void canvas.requestPointerLock()
  }

  // On a mouse, pointer lock *is* the pause state: releasing it (Esc / focus loss) opens the menu and
  // re-locking closes it. Touch has no lock at all, so there the pause button is the only way in and out —
  // hence the guard, without which the first touch would open the menu and never let it close.
  document.addEventListener('pointerlockchange', () => {
    if (touch.active()) return
    if (document.pointerLockElement === canvas) pause.close()
    else pause.open()
  })
  ui.setBackgroundTap(() => {
    if (!touch.active() && !pause.isOpen()) void canvas.requestPointerLock()
  })

  // Top-left pause button (placeholder glyph until skinned). During locked play the cursor is
  // hidden, so this is clickable when free; Esc is the primary open while playing.
  const pauseBtn = uiButton({
    label: 'II',
    width: 44,
    height: 40,
    color: 0x475569,
    onClick: () => {
      if (touch.active()) pause.open()
      else if (document.pointerLockElement === canvas) document.exitPointerLock()
      else pause.open()
    },
  })
  pauseBtn.view.position.set(16, 16)
  ui.root.addChild(pauseBtn.view)

  window.addEventListener('resize', () => {
    const v = viewSize()
    ui.resize(v.width, v.height)
    pauseBtn.view.position.set(16, 16)
    pause.layout()
  })

}

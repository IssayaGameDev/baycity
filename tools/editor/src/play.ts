import { createOrbitCamera } from '@mp/camera'
import { createLocalController, type LocalController, type LocalWorld } from '@mp/client'
import { characterAccess, createComponentRuntime, type ComponentRuntime, type Registry } from '@mp/components'
import type { LoadedLevel } from '@mp/content'
import { createSimClock, startFixedLoop, TICK_DT, TICK_RATE_HZ, type EntityId, type LoopHandle, type Vec3 } from '@mp/core'
import { addCharacter, CHAR_HALF_HEIGHT, CHAR_RADIUS, type CharacterState } from '@mp/humanoid'
import { actionsHeld, PLAYER_NODE_ID, type ModeDescriptor } from '@mp/mode'
import type { PhysicsWorld } from '@mp/physics'
import { addLevel, addLights, createThreeStage, OrbitControls, THREE, type ContentLights, type LevelView } from '@mp/render-three'

import type { Doc } from './editorDoc'

/**
 * Play-testing a level from the editor (ADR 0086, ADR 0052).
 *
 * Two of them behind one switch. A level whose game the server hosts a page for plays in the **real game**, in
 * an iframe — HUD, progression, other players. Anything else plays **in place**: the editor's own scene, the
 * game's own rules, its own locomotion and its own player components, driven by the same fixed-tick controller
 * the game uses.
 *
 * Its own module because it owns a cluster of state nothing else may touch — the character, the controller,
 * the loop, the play view and lights, the component runtime, the frame — and needs only a named handful of
 * things from the editor around it. Inside `main.ts` those nine variables sat beside seventy others, and
 * `playing` was read from twenty places with nothing saying who was allowed to write it.
 *
 * **Nothing here reads the editor's state directly.** `PlayHost` is the whole contract, in the getter-bag
 * style every panel already uses, so a play session cannot see a stale copy of the document.
 */

/** What play needs from the editor around it. Getters, so nothing here can hold a stale copy. */
export interface PlayHost {
  stage: ReturnType<typeof createThreeStage>
  canvas: HTMLCanvasElement
  /** The editor's orbit controls, switched off while playing so the player camera has the mouse. */
  controls: OrbitControls
  /** The authored item groups, hidden during play in favour of `addLevel`'s own view. */
  instanceRoot: THREE.Group
  doc: () => Doc | null
  /** Re-read per tick rather than captured: the editor may rebuild either between sessions. */
  loaded: () => LoadedLevel | null
  world: () => PhysicsWorld | null
  mode: () => ModeDescriptor | undefined
  registry: () => Registry
  /** Where the open level's game plays, or `null`: not a level, no game, or the server knows no page for it. */
  gamePageUrl: () => string | null
  /** The open file's qualified name, for the status line. */
  fileName: () => string
  /** Its bare name, for the game page's `?level=` (ADR 0108). */
  levelName: () => string
  live: () => boolean
  /** Push pending live edits, so the game page reads a current file. */
  flush: () => Promise<void>
  dirty: () => boolean
  saveNow: () => Promise<boolean>
  setPreviewing: (on: boolean) => void
  rebuildLoaded: () => void
  deselect: () => void
  setStatus: (message: string) => void
  /** Blank the status line, which stopping does rather than leaving a message about a session that ended. */
  clearStatus: () => void
  uiChanged: () => void
  /** Repaint remote ops held back while the world was the play session's (ADR 0120's sibling fix). */
  drainDeferred: () => void
  setProjection: (isometric: boolean) => void
}

export interface Play {
  /** A session is running, in a frame or in place. Editing is suspended while it is. */
  active: () => boolean
  start: () => void
  stop: () => void
  /**
   * One rendered frame. `true` when a session took it, so the caller runs the edit branch only when it did
   * not — the same either/or the render loop always had.
   */
  frame: (dt: number) => boolean
}

const PLAYER_ID = 0 as EntityId

export const createPlay = (host: PlayHost): Play => {
  const { stage, canvas, controls, instanceRoot } = host

  let active = false
  let char: CharacterState | null = null
  let controller: LocalController | null = null
  let playLoop: LoopHandle | null = null
  let playView: LevelView | null = null
  // Play hides `instanceRoot`, which hides the authored lights with it, so it needs its own (ADR 0047).
  let playLights: ContentLights | null = null
  let playComponents: ComponentRuntime | null = null
  /** The frame showing the game while a level is being play-tested; `null` when playing in place. */
  let gameFrame: HTMLIFrameElement | null = null
  let ownPos: Vec3 = { x: 0, y: 1, z: 0 }

  const keys = new Set<string>()
  window.addEventListener('keydown', (e) => {
    keys.add(e.code)
    if (active && (e.code === 'Space' || e.code.startsWith('Arrow'))) e.preventDefault()
  })
  window.addEventListener('keyup', (e) => keys.delete(e.code))

  const charMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(CHAR_RADIUS, CHAR_HALF_HEIGHT * 2, 8, 20),
    new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.6 }),
  )
  charMesh.castShadow = true
  charMesh.visible = false
  stage.scene.add(charMesh)

  /**
   * The game's third-person camera — `@mp/camera`, the same object the game builds (ADR 0059).
   *
   * This was a **third** hand-written third-person camera: its own yaw and pitch, a fixed distance, `lookAt`
   * instead of a boom, and no occlusion at all. So every camera fix since ADR 0055 — the see-through hole, the
   * below-the-feet rule, the three sightlines down the body — was invisible in the editor, which is the one
   * place you would go to check whether a level plays well. ADR 0056 recorded this file as using
   * `OrbitControls` for it; that was wrong, and the duplicate is why.
   *
   * Built once rather than per play, so zoom and pitch survive stopping and starting — and because the cutout
   * mask it owns clones a material per occluder, which is not worth rebuilding on every play.
   */
  const playCamera = createOrbitCamera(stage.camera)
  window.addEventListener('mousemove', (e) => {
    if (!active || document.pointerLockElement !== canvas) return
    playCamera.lookMouse(e.movementX, e.movementY)
  })
  // Wheel zoom, which the hand-written camera simply did not have.
  window.addEventListener(
    'wheel',
    (e) => {
      if (!active || document.pointerLockElement !== canvas) return
      e.preventDefault()
      playCamera.zoomNotch(Math.sign(e.deltaY))
    },
    { passive: false },
  )
  canvas.addEventListener('click', () => {
    if (active && document.pointerLockElement !== canvas) void canvas.requestPointerLock()
  })

  // WASD/arrows relative to the camera yaw (identical to the game).
  const worldMove = (): { x: number; z: number } => {
    let rx = 0
    let rz = 0
    if (keys.has('KeyW') || keys.has('ArrowUp')) rz -= 1
    if (keys.has('KeyS') || keys.has('ArrowDown')) rz += 1
    if (keys.has('KeyA') || keys.has('ArrowLeft')) rx -= 1
    if (keys.has('KeyD') || keys.has('ArrowRight')) rx += 1
    if (rx === 0 && rz === 0) return { x: 0, z: 0 }
    const facing = playCamera.yaw()
    const fwdX = -Math.sin(facing)
    const fwdZ = -Math.cos(facing)
    let x = fwdX * -rz + -fwdZ * rx
    let z = fwdZ * -rz + fwdX * rx
    const l = Math.hypot(x, z)
    if (l > 1) {
      x /= l
      z /= l
    }
    return { x, z }
  }

  /**
   * The active game's own actions that are held right now, by name (ADR 0061).
   *
   * Read off the host per tick rather than flattened once, because the game can change while the editor is
   * open. `actionsHeld` is shared with the game client on purpose: two copies of this mapping is how the
   * editor and the game came to disagree about post-FX (ADR 0057).
   */
  const heldActions = (): ReadonlySet<string> => actionsHeld(host.mode()?.actions, keys)

  /**
   * Play a level in the **real game** — HUD, progression, other players — rather than the editor's own loop.
   * The game page reads the saved file, so unsaved edits are saved first; a save that fails (read-only,
   * locked) means no play. Stop is the toolbar button: Esc inside the frame is the game's pause, not ours.
   */
  const startFramePlay = async (url: string): Promise<void> => {
    if (host.live()) await host.flush() // the game reads the file: make it current first
    else if (host.dirty() && !(await host.saveNow())) return
    const frame = document.createElement('iframe')
    frame.id = 'game-frame'
    // Bare: the game page resolves it inside its own folder (ADR 0108), so the game must not be in the param.
    frame.src = `${url}?level=${encodeURIComponent(host.levelName())}`
    frame.allow = 'fullscreen; pointer-lock'
    document.getElementById('centre')?.append(frame)
    gameFrame = frame
    active = true
    controls.enabled = false
    host.setStatus(`playing ${host.fileName()} in the game — Stop to come back`)
    host.uiChanged()
  }

  const start = (): void => {
    if (host.doc() === null || active) return
    const url = host.gamePageUrl()
    if (url !== null) {
      void startFramePlay(url)
      return
    }
    // Two clocks running at once would be two answers to "where is this platform". Play wins: it is the real
    // one, and the track helper hides itself while playing anyway.
    host.setPreviewing(false)
    host.rebuildLoaded() // fresh world + loaded from the current data
    const level = host.loaded()
    const physics = host.world()
    if (level === null || physics === null) return
    host.deselect()
    /**
     * Play-in-place runs **the game's own rules**, not a copy of them (ADR 0052).
     *
     * `mode.session` is the same function the game's client calls, so spawn, progress and death cannot drift
     * from it. They had: this used to die on any fall, ignoring `fallBehavior`, so a `physical-fall` tower
     * killed you here and let you fall in the game. The only difference left is what a client *does* about a
     * death — no ragdoll, no persistence, just a teleport back.
     *
     * With no game (an unassigned level, or one whose game is missing) there are no rules to run: you get the
     * character and the geometry, which is still the useful half of a play-test.
     */
    const mode = host.mode()
    const spawn: Vec3 = mode?.spawn(level) ?? { x: 0, y: 3, z: 0 }
    char = addCharacter(physics, spawn)
    const rules = mode?.session(level)
    playComponents =
      rules === undefined
        ? null
        : createComponentRuntime(level, host.registry(), {
            character: characterAccess(char),
            effects: rules.effects,
            // The game's player components too, so a play-test has the abilities the game has (ADR 0059) —
            // the same reason it runs the game's own `tuning` and rules rather than a default. Their
            // definitions come from the game as well (ADR 0061), which is what gives a play-test the game's
            // *locomotion* and not the stack's.
            ...(mode?.player === undefined
              ? {}
              : {
                  player: {
                    id: PLAYER_NODE_ID,
                    components: mode.player,
                    ...(mode.playerDefs === undefined
                      ? {}
                      : {
                          defs: mode.playerDefs({
                            character: () => char,
                            tuning: () => mode.tuning,
                            platforms: () => host.loaded()?.basePose,
                            // The play-test has a real world and a real level, so a game's component gets the
                            // same two handles here as it does in the game (ADR 0066). Anything it draws will
                            // not appear — the editor has no frame hook of its own to offer — which is the
                            // known limit of play-in-place.
                            world: () => host.world(),
                            level: () => host.loaded(),
                          }),
                        }),
                  },
                }),
          })
    let playTick = 0
    playComponents?.attach(playTick, 0, TICK_DT)

    // One fixed step of platform time per fixed step — see @mp/core simClock (reading the wall
    // clock inside the tick stalls the platforms during a multi-tick wake and jitters carry).
    const simClock = createSimClock({ tickMs: TICK_DT * 1000, reference: () => performance.now() })

    const local: LocalWorld = {
      applyInput: (cmd) => {
        const world = host.world()
        const loaded = host.loaded()
        if (world === null || loaded === null || char === null) return
        const nowMs = simClock.tick()
        // Components first, then the frame tree — the same order as the game (ADR 0058), because a component
        // that moves its node writes an offset the frame tree reads, and posing first lands it a tick late.
        playComponents?.fixedUpdate(++playTick, nowMs, TICK_DT)
        loaded.update(nowMs, char.base?.colliderHandle) // only the ridden piece is frozen
        world.step(TICK_DT) // (A) platforms move
        /**
         * The movement slot (ADR 0061), same as the game's. A game whose locomotion is its own component
         * feels like itself here, where before this ran `stepCharacter` with the game's *numbers* and the
         * stack's mechanics.
         *
         * A level with no game, or a game with no locomotion component, does not move — which is honest:
         * there is nothing to ask. It used to fall back to `DEFAULT_TUNING`, quietly play-testing parkour.
         */
        playComponents?.locomote(playTick, nowMs, TICK_DT, cmd)
        world.step(TICK_DT) // (B) character resolves against the moved platforms
      },
      readState: () => new Map<EntityId, Vec3>([[PLAYER_ID, char!.body.translation()]]),
    }
    controller = createLocalController({ world: local, tickRateHz: TICK_RATE_HZ })

    instanceRoot.visible = false
    // The cutout mask, so an obstruction dithers away here exactly as it does in the game (ADR 0055). The
    // edit view deliberately does not get one — it would clone a material per occluder for a camera nobody
    // is playing through.
    playView = addLevel(stage.scene, level.visuals, { cutout: playCamera.cutout })
    /**
     * The two queries the camera needs, over the play world (ADR 0056: the camera imports no physics, it is
     * handed the casts). Self-exclusion is the character's own capsule; there is no ragdoll here to skip.
     */
    playCamera.observe({
      cast: (origin, direction, maxDistance, skip) => {
        const hit = host.world()?.castSphere({
          origin,
          direction,
          maxDistance,
          radius: playCamera.probeRadius,
          exclude: [...(char === null ? [] : [char.body.colliderHandle]), ...(skip ?? [])],
        })
        return hit === undefined ? undefined : { distance: hit.distance, colliderHandle: hit.colliderHandle }
      },
      occupied: (point) =>
        host.world()?.sphereOverlaps({
          center: point,
          radius: playCamera.probeRadius,
          exclude: char === null ? [] : [char.body.colliderHandle],
        }) === true,
    })
    playLights = addLights(stage.scene, level.lights)
    charMesh.visible = true
    // The player camera is `stage.camera` and tunes its fov (`createOrbitCamera`), so play is perspective.
    host.setProjection(false)
    active = true
    controls.enabled = false // editor orbit off; the player camera takes over
    void canvas.requestPointerLock()
    host.setStatus('playing — WASD + Space · mouse to look · Esc to stop')
    host.uiChanged()

    playLoop = startFixedLoop({
      tickRateHz: TICK_RATE_HZ,
      onTick: () => {
        if (char === null || controller === null) return
        const m = worldMove()
        // The game's own actions too (ADR 0061), so a play-test has the controls the game has — the same
        // reason it runs the game's `tuning`, its rules and its player components rather than defaults.
        controller.step({ moveX: m.x, moveZ: m.z, jump: keys.has('Space'), actions: heldActions() })
        // Solids and triggers both: a sensor resolves no movement, so it is not in `collisions` (ADR 0054).
        playComponents?.contact([...char.body.collisions(), ...char.body.overlaps()])
        // One question, asked of the game's rules, which also consume the flag. A level with no game never
        // dies.
        if (rules?.takeDeath() === true) {
          char.body.setPosition(rules.respawnAt())
          char.vx = 0
          char.vy = 0
          char.vz = 0
          char.grounded = false
        }
        // A rule that relocates without killing (ADR 0073) — a play-test cashes out the way the game does.
        const teleport = rules?.takeTeleport?.() ?? null
        if (teleport !== null) {
          char.body.setPosition(teleport)
          char.vx = 0
          char.vy = 0
          char.vz = 0
          char.grounded = false
        }
      },
    })
  }

  const stop = (): void => {
    if (!active) return
    if (gameFrame !== null) {
      gameFrame.remove()
      gameFrame = null
      active = false
      controls.enabled = true
      host.clearStatus()
      host.uiChanged()
      host.drainDeferred() // what the room did while the frame was up
      return
    }
    playLoop?.stop()
    playLoop = null
    playComponents?.detach()
    playComponents = null
    char?.body.remove()
    char = null
    controller = null
    playView?.dispose()
    playView = null
    playLights?.dispose()
    playLights = null
    charMesh.visible = false
    instanceRoot.visible = true
    active = false
    if (document.pointerLockElement === canvas) document.exitPointerLock()
    controls.target.set(ownPos.x, ownPos.y + 1, ownPos.z) // resume orbit around where you stopped
    controls.enabled = true
    host.clearStatus()
    host.uiChanged()
    host.rebuildLoaded() // restore the edit world + markers
    host.drainDeferred() // what the room did while the play-test held the world
  }

  document.addEventListener('pointerlockchange', () => {
    // Esc or a lost lock exits play — but only the in-place kind. Esc inside the frame is the game's pause.
    if (active && gameFrame === null && document.pointerLockElement !== canvas) stop()
  })

  return {
    active: () => active,
    start,
    stop,
    frame: (dt) => {
      const loaded = host.loaded()
      if (!active || controller === null || loaded === null) return false
      // Due ticks first, then clock-driven pieces and the character drawn at one fraction of the way into the
      // next tick, off the loop's own schedule (ADR 0140) — the game's timeline. Then the camera.
      playLoop?.pump()
      const alpha = playLoop === null ? 1 : playLoop.alpha()
      loaded.render(alpha)
      playView?.sync()
      playLights?.sync()
      ownPos = controller.renderPositions(alpha).get(PLAYER_ID) ?? ownPos
      charMesh.position.set(ownPos.x, ownPos.y, ownPos.z)
      // The camera places itself around the capsule's centre and reports whether we are inside our own rig;
      // `setOccluders` is what puts the hole in whatever is in the way.
      const { rigVisible } = playCamera.update(dt, ownPos, (handles) => playView?.setOccluders(handles))
      charMesh.visible = rigVisible
      return true
    },
  }
}

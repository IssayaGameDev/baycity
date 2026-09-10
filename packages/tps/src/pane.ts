import { CAMERA_TUNABLES, type OrbitCamera } from '@mp/camera'
import type { CharacterTuning, GaitTuning } from '@mp/humanoid'
import type { TouchLayout } from '@mp/client/dom'
import type { GreyboxEnvironment, PostFX, Sky, ThreeStage } from '@mp/render-three'
import Stats from 'stats.js'
import { Pane } from 'tweakpane'

import type { AssemblyTiming } from './assemble'

/**
 * Everything live-tunable, in one Tweakpane.
 *
 * Pure wiring: every folder binds an object somebody else owns and mutates it in place, and the owners read
 * their values fresh each frame. That is why this came out of the composition root whole while the rest of it
 * did not — there is no state here at all.
 *
 * Client-authoritative (ADR 0011/0012), so all of this is local: turning a knob changes nothing for anyone
 * else, which is the only reason a slider for gravity is a reasonable thing to ship.
 *
 * **A game chooses which folders it gets** (ADR 0075). Every folder here tunes something the *platform* owns,
 * and a game deep in its own loop wants its own three folders and none of the platform's twelve. The list is
 * the game's; unlisted folders are not built. The frame meter is always there — it is the one control that is
 * about the frame rather than about any tunable.
 */

/** The platform's folders, by key, in the order they appear. */
export const DEBUG_FOLDERS = [
  'camera',
  'sky',
  'touch',
  'movement',
  'render',
  'gait',
  'idle',
  'inertia',
  'head',
  'jointLag',
  'air',
  'death',
] as const

export type DebugFolder = (typeof DEBUG_FOLDERS)[number]

export interface DebugPaneOptions {
  camera: OrbitCamera
  stage: ThreeStage
  /** The equirect backdrop, if one loaded — it adds a source toggle to the Sky folder. */
  photoSky: Sky | null
  /** The sun-shadow switch — see the Camera folder for why it exists. */
  debug: { sunShadows: boolean }
  env: GreyboxEnvironment
  postfx: PostFX
  tuning: CharacterTuning
  gait: GaitTuning
  touchLayout: TouchLayout
  assembleTiming: AssemblyTiming
  /** Hand the pane's host element to whatever owns touch routing, so a slider drag is not also a camera swing. */
  onTouchIgnore: (el: HTMLElement) => void
  /** The Death folder's button. Reaching a real hazard costs a run. */
  onDeath: () => void
  /** Which of the platform's folders to build. Absent means all of them. */
  folders?: readonly DebugFolder[]
}

/**
 * What the pane hands back.
 *
 * `frame` drives the frame-time meter and is the one thing here that has to be **called**, once per rendered
 * frame, rather than bound (ADR 0070).
 *
 * `pane` is the tweakpane root, so **a game can add its own folder** (ADR 0067). Every value in here is
 * something the platform happens to own; a game's own feel — a rope's stiffness, a dash's length — is owned by
 * the game, and tuning by eye is the only way anybody sets those numbers (ADR 0018). Handing over the root is
 * the same move as handing over the scene: no concept per idea, and the pane never learns what a rope is.
 */
export interface DebugPane {
  readonly pane: Pane
  /**
   * Advance the frame-time meter. Call once per **rendered** frame (ADR 0070).
   *
   * A no-op while the meter is off, which is how it ships: an always-on overlay is one more thing between you
   * and the game, and `stats.js` costs a DOM write per frame whether anybody is reading it or not.
   */
  frame: () => void
  dispose: () => void
}

export const installDebugPane = (opts: DebugPaneOptions): DebugPane => {
  const { camera: orbit, debug, env, postfx, stage, photoSky, tuning, gait, touchLayout, assembleTiming } = opts
  const requestDeath = opts.onDeath
  // Own host element with an explicit stacking order: the Pixi UI canvas is at z-index 10, and
  // with tweakpane's default wrapper the pause screen covered the pane — i.e. it was unreachable
  // exactly when the mouse is free (during play the game holds pointer lock). Dev tooling stays
  // on top of the game UI.
  const paneHost = document.createElement('div')
  paneHost.style.cssText = 'position:fixed;top:8px;right:8px;width:256px;z-index:100'
  document.body.appendChild(paneHost)
  opts.onTouchIgnore(paneHost)
  /**
   * **Collapsed, and so is everything in it.**
   *
   * There are fifty-odd tunables across a dozen folders, and an open pane covers a quarter of the screen with
   * numbers nobody is currently looking at. Opening the one folder you want is a click; closing eleven you did
   * not is eleven.
   */
  const pane = new Pane({ title: 'Debug', container: paneHost, expanded: false })

  /** One builder per platform folder. Built in `DEBUG_FOLDERS` order, only for the keys the game listed. */
  const builders: Record<DebugFolder, () => void> = {
    camera: () => {
      const cam = pane.addFolder({ title: 'Camera', expanded: false })
      /**
       * The camera describes its own knobs (`CAMERA_TUNABLES`) and this builds them, so a camera parameter is
       * added in one place instead of two and cannot ship without a slider. No entry for the zoom itself — the
       * wheel owns it, and tweakpane does not track a value changed from outside.
       */
      for (const t of CAMERA_TUNABLES)
        cam.addBinding(orbit.params, t.key, { min: t.min, max: t.max, step: t.step, label: t.label })
      /**
       * Two switches for telling shading apart from geometry. A hole in a surface leaves the *shading* it was
       * responsible for behind — the sun shadow it casts on whatever it covered, and the ambient occlusion the
       * AO pass reads from a depth buffer that never heard about the discard — and both read as the surface
       * having failed to disappear. Guessing which one is which from a screenshot does not work; toggling does.
       */
      cam.addBinding(debug, 'sunShadows', { label: 'sun shadows' }).on('change', (e) => {
        env.sun.castShadow = e.value
      })
      // Through `params`, not straight onto the pass: AO is level data now (`config.environment.postfx`), and
      // writing the pass behind the live object would leave the two disagreeing the moment a level is applied.
      cam.addBinding(postfx.params, 'ao', { label: 'ambient occl.' }).on('change', () => postfx.refresh())
    },

    sky: () => {
      // Sky + sun (ADR 0046). Every one of these needs an eye rather than a value, so they all live here. The
      // sun angles drive the key light, its shadow frustum and the sky bake together, which is why there is no
      // separate light direction to set. The sky is a designed gradient rather than atmospheric scattering,
      // because the shape wanted here (light at the top, darkening all the way down) is the inverse of what
      // scattering produces.
      const skyFolder = pane.addFolder({ title: 'Sky', expanded: false })
      const skyView = { source: 'procedural' as 'procedural' | 'photo', fill: 0.4, sunIntensity: 2.4 }
      if (env.sky === null) return
      const rebake = (): void => env.refresh()
      skyFolder.addBinding(env.sunAngles, 'elevationDeg', { min: 1, max: 89, step: 1, label: 'sun elev °' }).on('change', rebake)
      skyFolder.addBinding(env.sunAngles, 'azimuthDeg', { min: -180, max: 180, step: 1, label: 'sun azim °' }).on('change', rebake)
      // The gradient. Two ends and a curve, so it is monotonic whatever you set: light at the top falling to
      // dark at the bottom, with no way to produce a bright band in the middle.
      skyFolder.addBinding(env.skyParams, 'topColor', { label: 'top' }).on('change', rebake)
      skyFolder.addBinding(env.skyParams, 'bottomColor', { label: 'bottom' }).on('change', rebake)
      skyFolder.addBinding(env.skyParams, 'gradientBias', { min: 0.3, max: 3, step: 0.05, label: 'ramp bias' }).on('change', rebake)
      skyFolder.addBinding(env.skyParams, 'gain', { min: 0.1, max: 6, step: 0.05, label: 'sky gain' }).on('change', rebake)
      // The sun. Push `glow` and the white patch comes back, which is why it starts low.
      skyFolder.addBinding(env.skyParams, 'glowColor', { label: 'sun tint' }).on('change', rebake)
      skyFolder.addBinding(env.skyParams, 'glowStrength', { min: 0, max: 2, step: 0.01, label: 'glow' }).on('change', rebake)
      skyFolder.addBinding(env.skyParams, 'glowSharpness', { min: 4, max: 600, step: 4, label: 'glow tight' }).on('change', rebake)
      skyFolder.addBinding(env.skyParams, 'sunDiskIntensity', { min: 0, max: 2000, step: 10, label: 'sun disc' }).on('change', rebake)
      skyFolder.addBinding(skyView, 'sunIntensity', { min: 0, max: 5, step: 0.05, label: 'sun W' }).on('change', () => {
        env.sun.intensity = skyView.sunIntensity
      })
      // How hard the sky lights the level, and the neutral counterweight to its colour cast. At full strength
      // the sky's ambient measures blue twenty-one times red and beats the key light, which washes everything
      // blue and flattens the shadows. `env light` is `scene.environmentIntensity`, which is independent of
      // `backgroundIntensity` — turning it down does not dim the sky you look at.
      skyFolder.addBinding(stage.scene, 'environmentIntensity', { min: 0, max: 1.5, step: 0.01, label: 'env light' })
      skyFolder.addBinding(skyView, 'fill', { min: 0, max: 2, step: 0.01, label: 'neutral fill' }).on('change', () => {
        env.fill.intensity = skyView.fill
      })
      if (photoSky !== null) {
        skyFolder.addBinding(skyView, 'source', { options: { procedural: 'procedural', photo: 'photo' }, label: 'backdrop' }).on('change', () => {
          stage.scene.background = skyView.source === 'photo' ? photoSky.texture : env.sky?.background ?? null
        })
      }
    },

    touch: () => {
      // Touch controls (ADR 0022). Kodjo keeps the pane on phones, and these are the numbers that need a thumb
      // to judge. `anchor` is the one to try first: `recentre` moves the stick's centre to wherever the zone
      // was touched and starts from a standstill, `fixed` keeps it at the drawn home and deflects on contact.
      const tc = pane.addFolder({ title: 'Touch', expanded: false })
      tc.addBinding(touchLayout, 'anchor', { options: { recentre: 'recentre', fixed: 'fixed' } })
      tc.addBinding(touchLayout, 'stickRadius', { min: 30, max: 140, step: 2, label: 'stick r px' })
      tc.addBinding(touchLayout.stickZone, 'width', { min: 0.2, max: 0.6, step: 0.01, label: 'zone w' })
      tc.addBinding(touchLayout.stickZone, 'height', { min: 0.2, max: 1, step: 0.01, label: 'zone h' })
      tc.addBinding(touchLayout, 'deadZone', { min: 0, max: 0.4, step: 0.01, label: 'dead zone' })
      tc.addBinding(touchLayout, 'jumpRadius', { min: 24, max: 96, step: 2, label: 'jump r px' })
      tc.addBinding(touchLayout, 'topStrip', { min: 0, max: 140, step: 4, label: 'top strip px' })
      tc.addBinding(touchLayout, 'tapSlop', { min: 2, max: 40, step: 1, label: 'tap slop px' })
      tc.addBinding(orbit.params, 'touchSensitivity', { min: 0.001, max: 0.02, step: 0.0005, label: 'look rad/px' })
      tc.addBinding(orbit.params, 'pinchZoom', { min: 0, max: 0.08, step: 0.002, label: 'pinch m/px' })
    },

    movement: () => {
      // Live locomotion feel (client-authoritative, so tuning is purely local — ADR 0011/0012).
      const mv = pane.addFolder({ title: 'Movement (Roblox-like)', expanded: false })
      mv.addBinding(tuning, 'moveSpeed', { min: 1, max: 12, step: 0.1, label: 'speed m/s' })
      mv.addBinding(tuning, 'jumpHeight', { min: 0.5, max: 5, step: 0.1, label: 'jump apex m' })
      mv.addBinding(tuning, 'gravity', { min: 10, max: 100, step: 1, label: 'gravity m/s²' })
      mv.addBinding(tuning, 'groundAccelTime', { min: 0, max: 0.5, step: 0.01, label: 'accel s' })
      mv.addBinding(tuning, 'groundStopTime', { min: 0, max: 0.5, step: 0.01, label: 'stop s' })
      mv.addBinding(tuning, 'airControl', { min: 0, max: 1, step: 0.05, label: 'air control' })
      mv.addBinding(tuning, 'maxFallSpeed', { min: 10, max: 100, step: 1, label: 'max fall m/s' })
      mv.addBinding(tuning, 'coyoteTime', { min: 0, max: 0.4, step: 0.01, label: 'coyote s' })
      mv.addBinding(tuning, 'jumpBufferTime', { min: 0, max: 0.4, step: 0.01, label: 'jump buffer s' })
      mv.addBinding(tuning, 'liftStoreTime', { min: 0, max: 0.4, step: 0.01, label: 'lift store s' })
      // Arc shape: fall bias, apex float and release-cut, all live. Each reverts on its own — fall and apex to
      // 1, cut to 1 — so any one can be switched off without disturbing the rest. See DEFAULT_TUNING.
      const arc = mv.addFolder({ title: 'arc', expanded: false })
      arc.addBinding(tuning, 'fallGravityScale', { min: 1, max: 3, step: 0.05, label: 'fall gravity x' })
      arc.addBinding(tuning, 'apexGravityScale', { min: 0, max: 1, step: 0.05, label: 'apex gravity x' })
      arc.addBinding(tuning, 'apexSpeed', { min: 0, max: 10, step: 0.5, label: 'apex window m/s' })
      arc.addBinding(tuning, 'jumpCutScale', { min: 0, max: 1, step: 0.05, label: 'release cut x' })
    },

    render: () => {
      /**
       * Live render tuning (content C3).
       *
       * Bloom is bound to `postfx.params` — the object the level writes into — rather than to a copy, so
       * loading a level that pins its bloom moves these sliders instead of leaving them showing numbers nothing
       * reads. Same reason the sky block binds `env.skyParams` (ADR 0048).
       *
       * Exposure keeps a local value because it is the renderer's, not the level's: it is not in
       * `config.environment` yet, and inventing that here would be a schema decision made in a debug pane.
       */
      const renderParams = { exposure: 1.0 }
      const rp = pane.addFolder({ title: 'Render (greybox C3)', expanded: false })
      rp.addBinding(renderParams, 'exposure', { min: 0.4, max: 2, step: 0.05 }).on('change', (e) => {
        stage.renderer.toneMappingExposure = e.value
      })
      rp.addBinding(postfx.params, 'bloom').on('change', () => postfx.refresh())
      rp.addBinding(postfx.params, 'bloomStrength', { min: 0, max: 1.5, step: 0.05, label: 'bloom str' }).on('change', () => postfx.refresh())
    },

    gait: () => {
      // Gait feel (ADR 0018). Read fresh every frame by every character's animator, so these are live.
      const gf = pane.addFolder({ title: 'Gait (procedural)', expanded: false })
      gf.addBinding(gait, 'bob', { min: 0, max: 0.3, step: 0.005, label: 'body bob m' })
      gf.addBinding(gait, 'lean', { min: 0, max: 0.6, step: 0.01, label: 'lean rad' })
      gf.addBinding(gait, 'torsoTwist', { min: 0, max: 0.5, step: 0.01, label: 'torso twist' })
      // Where the torso bends. The shoulders go the same place at any value — this decides how much the hips
      // join in. 0 is the old single-box torso (hips turn with the shoulders, so no counter-rotation at all);
      // 1 keeps the hips square and puts the whole twist and lean at the waist.
      gf.addBinding(gait, 'spineChestShare', { min: 0, max: 1, step: 0.05, label: 'waist share' })
      gf.addBinding(gait, 'armSwing', { min: 0, max: 2.5, step: 0.05, label: 'arm swing' })
      gf.addBinding(gait, 'armOutward', { min: 0, max: 0.6, step: 0.01, label: 'arm splay' })
      gf.addBinding(gait, 'elbowBase', { min: 0, max: 1.5, step: 0.05, label: 'elbow rest' })
      gf.addBinding(gait, 'elbowFold', { min: 0, max: 2.5, step: 0.05, label: 'elbow fold' })
      gf.addBinding(gait, 'footLift', { min: 0, max: 0.6, step: 0.01, label: 'foot lift m' })
      gf.addBinding(gait, 'strideWalk', { min: 0.3, max: 2, step: 0.05, label: 'stride walk m' })
      gf.addBinding(gait, 'strideRun', { min: 0.5, max: 3, step: 0.05, label: 'stride run m' })
      gf.addBinding(gait, 'landCrouch', { min: 0, max: 1.5, step: 0.05, label: 'land crouch' })
      gf.addBinding(gait, 'yawHalfLife', { min: 0.01, max: 0.4, step: 0.01, label: 'turn smooth s' })
      // Runs past 1 (the life-like amount) on purpose: the per-quantity spreads are only ±14–30%, so
      // exaggeration is the only way to see what is varying while tuning it.
      gf.addBinding(gait, 'variation', { min: 0, max: 10, step: 0.1, label: 'variation' })
    },

    idle: () => {
      // Idle. Its own layer on a time clock, since the gait scales everything by speed and contributes
      // nothing at a standstill. `settle` is load-bearing, not cosmetic: standing legs are at full
      // extension, so without it nothing else here can move without lifting a foot.
      const idf = pane.addFolder({ title: 'Idle', expanded: false })
      idf.addBinding(gait, 'idleSettle', { min: 0, max: 0.12, step: 0.005, label: 'settle m' })
      idf.addBinding(gait, 'breathPeriod', { min: 1, max: 10, step: 0.1, label: 'breath period s' })
      idf.addBinding(gait, 'breathDepth', { min: 0, max: 0.06, step: 0.002, label: 'breath depth m' })
      idf.addBinding(gait, 'idleShiftPeriod', { min: 0.5, max: 10, step: 0.1, label: 'shift every s' })
      idf.addBinding(gait, 'idleSway', { min: 0, max: 0.12, step: 0.005, label: 'hip sway m' })
      idf.addBinding(gait, 'idleRoll', { min: 0, max: 0.2, step: 0.005, label: 'torso tilt rad' })
    },

    inertia: () => {
      // Inertia (ADR 0018). Fed the character's *total* world velocity — its own locomotion plus anything
      // carrying it — and responds to the derivative, so constant speed of any kind shows nothing while every
      // start, stop and corner shows. Each weight is that part's own lag; parts inherit their parent's, so a
      // forearm ends up lagging most. These are rotations only — the translation is the Joint lag folder.
      const inf = pane.addFolder({ title: 'Inertia', expanded: false })
      inf.addBinding(gait, 'inertiaStrength', { min: 0, max: 3, step: 0.05, label: 'strength' })
      inf.addBinding(gait, 'inertiaHalfLife', { min: 0.02, max: 0.5, step: 0.01, label: 'looseness s' })
      inf.addBinding(gait, 'inertiaBody', { min: 0, max: 2, step: 0.05, label: 'w torso' })
      inf.addBinding(gait, 'inertiaHead', { min: 0, max: 2, step: 0.05, label: 'w head' })
      inf.addBinding(gait, 'inertiaUpperArm', { min: 0, max: 3, step: 0.05, label: 'w upper arm' })
      inf.addBinding(gait, 'inertiaUpperArmLateral', { min: 0, max: 3, step: 0.05, label: 'w arm sideways' })
      inf.addBinding(gait, 'inertiaLowerArm', { min: 0, max: 3, step: 0.05, label: 'w forearm' })
      inf.addBinding(gait, 'inertiaHip', { min: 0, max: 0.15, step: 0.005, label: 'hip lag m' })
      inf.addBinding(gait, 'inertiaVertical', { min: 0, max: 0.8, step: 0.01, label: 'compress m' })
      inf.addBinding(gait, 'inertiaFloat', { min: 0, max: 4, step: 0.05, label: 'arm float rad' })
    },

    head: () => {
      // Head (ADR 0018). Every head term used to be a torso term times a constant, so it read as welded.
      // `stabilize` is the base: 1 holds the head level in the world with the torso turning under it.
      // The rest are signals no other part has. From a camera behind the character, yaw and pitch here are
      // heavily foreshortened — `counter-bob` is the one that reads.
      const hf = pane.addFolder({ title: 'Head', expanded: false })
      hf.addBinding(gait, 'headStabilize', { min: 0, max: 1, step: 0.05, label: 'stabilize' })
      // Below `yawHalfLife` (0.06) the head leads into a turn; above it, the head trails.
      hf.addBinding(gait, 'headYawHalfLife', { min: 0.01, max: 0.4, step: 0.01, label: 'turn smooth s' })
      hf.addBinding(gait, 'headYawMax', { min: 0, max: 1.5, step: 0.05, label: 'turn cap rad' })
      hf.addBinding(gait, 'headRise', { min: 0, max: 0.8, step: 0.02, label: 'chin up ↑' })
      hf.addBinding(gait, 'headFall', { min: 0, max: 0.8, step: 0.02, label: 'look down ↓' })
      hf.addBinding(gait, 'headLand', { min: 0, max: 1, step: 0.02, label: 'land nod' })
      hf.addBinding(gait, 'headSprint', { min: 0, max: 0.5, step: 0.02, label: 'sprint pitch' })
    },

    jointLag: () => {
      // Joint lag (ADR 0018). One mechanism for the neck and both shoulders: each interpolates toward the
      // **world** position of the point it attaches to, so it is simply late to wherever the body went. Zero
      // welds it. Raise it and the joint trails further behind everything the character does, saturating at
      // its max. At 5.5 m/s the trail is about 0.005 → 40 mm, 0.01 → 79 mm, 0.03 → the stop. Crank a lag and
      // its max to maximum to confirm it is working, then tune down.
      const lf = pane.addFolder({ title: 'Joint lag', expanded: false })
      lf.addBinding(gait, 'headLagHalfLife', { min: 0, max: 0.06, step: 0.001, label: 'head lag s' })
      lf.addBinding(gait, 'headLagMax', { min: 0, max: 0.4, step: 0.01, label: 'head max m' })
      lf.addBinding(gait, 'armLagHalfLife', { min: 0, max: 0.06, step: 0.001, label: 'arm lag s' })
      lf.addBinding(gait, 'armLagMax', { min: 0, max: 0.4, step: 0.01, label: 'arm max m' })
    },

    air: () => {
      // Air pose. Rising and falling are separate shapes (ADR 0018) — the outward rolls are what make a
      // jump visible at all from a camera sitting behind the character.
      const af = pane.addFolder({ title: 'Jump / air pose', expanded: false })
      af.addBinding(gait, 'airArmRise', { min: -1, max: 3, step: 0.05, label: 'arm pitch ↑' })
      af.addBinding(gait, 'airArmOutRise', { min: 0, max: 1.6, step: 0.05, label: 'arm splay ↑' })
      af.addBinding(gait, 'airElbowRise', { min: 0, max: 2.5, step: 0.05, label: 'elbow ↑' })
      af.addBinding(gait, 'airTuckRise', { min: 0, max: 0.6, step: 0.01, label: 'knee tuck ↑ m' })
      af.addBinding(gait, 'airArmFall', { min: -1, max: 3, step: 0.05, label: 'arm pitch ↓' })
      af.addBinding(gait, 'airArmOutFall', { min: 0, max: 1.6, step: 0.05, label: 'arm splay ↓' })
      af.addBinding(gait, 'airElbowFall', { min: 0, max: 2.5, step: 0.05, label: 'elbow ↓' })
      af.addBinding(gait, 'airTuckFall', { min: 0, max: 0.6, step: 0.01, label: 'knee tuck ↓ m' })
      // Lead/trail asymmetry, alternating side per jump and contralateral (arm opposite the lead knee).
      // Unitless amounts; 0 gives a symmetric jump. The arm one is worth more from a camera behind.
      af.addBinding(gait, 'airAsymArm', { min: 0, max: 2, step: 0.05, label: 'asym arm' })
      af.addBinding(gait, 'airAsymLeg', { min: 0, max: 2, step: 0.05, label: 'asym leg' })
    },

    death: () => {
      // Death, on demand. The real triggers are hazard contact and the level's fall plane, but reaching either
      // costs a run — and the ragdoll is the kind of thing that wants looking at twenty times in a row.
      const df = pane.addFolder({ title: 'Death', expanded: false })
      df.addButton({ title: 'Ragdoll now' }).on('click', () => requestDeath?.())
      // Spawn assembly. Total length is 6 x stagger + fall, so the defaults run in 0.48 s.
      df.addBinding(assembleTiming, 'stagger', { min: 0, max: 0.4, step: 0.01, label: 'pair gap s' })
      df.addBinding(assembleTiming, 'fall', { min: 0.02, max: 1, step: 0.01, label: 'fall s' })
      df.addBinding(assembleTiming, 'height', { min: 0.2, max: 8, step: 0.1, label: 'drop from m' })
    },
  }

  const wanted = new Set<DebugFolder>(opts.folders ?? DEBUG_FOLDERS)
  for (const key of DEBUG_FOLDERS) if (wanted.has(key)) builders[key]()

  /**
   * Frame time, off by default (ADR 0070). Always built: it is about the frame, not about any tunable.
   *
   * `stats.js` rather than a number on the pane, because what matters when a frame is slow is the **shape** of
   * the graph — an even 40 ms is a budget problem and one 40 ms spike in a run of 8 ms is a hitch, and those
   * want different fixes. Tweakpane would show you the same number for both.
   *
   * Its own element, positioned under the pane rather than at the top-left where `stats.js` puts itself: that
   * corner is the pause button's (ADR 0015). Above the Pixi overlay's z-index 10, or the UI canvas covers it.
   */
  const stats = new Stats()
  stats.showPanel(0) // frames per second; click the panel itself for ms and memory
  const meter = stats.dom
  meter.style.position = 'fixed'
  meter.style.left = 'auto'
  meter.style.top = '8px'
  meter.style.right = '272px'
  meter.style.zIndex = '100'
  meter.style.display = 'none'
  document.body.appendChild(meter)
  opts.onTouchIgnore(meter)

  const meterOn = { fps: false }
  pane.addBinding(meterOn, 'fps', { label: 'frame meter' }).on('change', (e) => {
    meter.style.display = e.value ? 'block' : 'none'
  })

  return {
    pane,
    frame: () => {
      // Gated, so an off meter costs one boolean rather than two DOM writes a frame.
      if (meterOn.fps) stats.update()
    },
    dispose: () => {
      // Tweakpane's own teardown, then the host element it was given. Both, because `pane.dispose()` leaves
      // the div behind and the div is what carries the fixed position and z-index.
      pane.dispose()
      paneHost.remove()
      meter.remove()
    },
  }
}

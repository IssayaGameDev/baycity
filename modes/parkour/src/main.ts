import {
  createClockSync,
  createLocalController,
  createSnapshotClient,
  createSnapshotReassembler,
  keysToMovement,
  type LocalController,
  type LocalWorld,
} from '@mp/client'
import { clamp, createSimClock, startFixedLoop, vec3, type EntityId, type Vec3 } from '@mp/core'
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
  STATE_GROUNDED,
  STATE_RISING,
} from '@mp/net'
import { createPhysicsWorld, initPhysics, type PhysicsBody } from '@mp/physics'
import { createThreeStage, applyGreyboxEnvironment, createPostFX, addLevel, type LevelView } from '@mp/render-three'
import {
  addCharacter,
  CHAR_HALF_HEIGHT,
  CHAR_RADIUS,
  DEFAULT_TUNING,
  playerSpawn,
  stepCharacter,
  TICK_DT,
  TICK_RATE_HZ,
  type CharacterState,
  type CharacterTuning,
  DEFAULT_GAIT,
  partTransforms,
  type GaitTuning,
} from '@mp/character'
import { instantiateLevel, validateLevel, type LoadedLevel } from '@mp/content'
import { getLocale, matchLocale, onLocaleChange, setLocale, t, type TranslationKey } from '@mp/i18n'
import { createUiOverlay, uiButton, type ListItem } from '@mp/render-pixi'
import { Client, type Room } from 'colyseus.js'
import { Pane } from 'tweakpane'

import { createAssembly, type Assembly, type AssemblyTiming } from './assemble'
import { createCharacterViews, SELF_COLORS } from './characterView'
import { OVERLAY_LAYER } from './nametag'
import { createPauseMenu } from './pauseMenu'
import { createRagdoll, type Ragdoll } from './ragdoll'
import { localParkourPersistence } from './persistence'
import { showcase } from './showcase'

// Relay endpoint. Defaults to the dev host on :9200. `?server=wss://host` overrides it, so a
// tunnelled page (served from a different origin than the relay) can point at its own relay URL.
const SERVER_URL = new URLSearchParams(location.search).get('server') ?? `ws://${location.hostname}:9200`

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!
const canvas = $<HTMLCanvasElement>('#view')
const statusEl = $<HTMLDivElement>('#status')
const hintEl = $<HTMLDivElement>('#hint')

// --- localization (ADR 0016) ---
// All player-facing text routes through i18n. The status line is state-driven, so re-render it
// (and the hint) on locale change. Detect the locale up front (stored override, else browser),
// and persist changes.
const LOCALE_KEY = 'mp.locale'
let statusMsg: { key: TranslationKey; params?: Record<string, string | number> } = { key: 'status.connecting' }
const renderStatus = (): void => {
  statusEl.textContent = t(statusMsg.key, statusMsg.params)
}
const setStatus = (key: TranslationKey, params?: Record<string, string | number>): void => {
  statusMsg = params !== undefined ? { key, params } : { key }
  renderStatus()
}
const renderHint = (): void => {
  hintEl.textContent = t('hint.controls')
}
try {
  setLocale(localStorage.getItem(LOCALE_KEY) ?? matchLocale(navigator.language))
} catch {
  setLocale(matchLocale(navigator.language))
}
onLocaleChange(() => {
  try {
    localStorage.setItem(LOCALE_KEY, getLocale())
  } catch {
    // best-effort persistence
  }
  renderStatus()
  renderHint()
})
renderStatus()
renderHint()

// --- scene ---
const stage = createThreeStage({ canvas, cameraPosition: [0, 6, 10], lookAt: [0, 1, 0] })
// Polished greybox pipeline (content pipeline C3): IBL + ACES + soft shadows, with GTAO +
// SMAA post-FX. Level meshes, materials (the "High-contrast dev" palette) and markers are
// realized by the shared @mp/render-three renderer — same code the viewer uses.
applyGreyboxEnvironment(stage.renderer, stage.scene, { shadowRadius: 30, sunIntensity: 2.4 })
const postfx = createPostFX(stage.renderer, stage.scene, stage.camera, { ao: true, bloom: true, bloomStrength: 0.3 })

// Nametags live on an overlay layer drawn AFTER post-FX. GTAO renders the scene into its
// own depth/normal buffer to compute occlusion; a sprite left in the world pipeline shows
// up there as a hard dark AO ghost (the tilted black quad). Keeping the sprites on a layer
// the world camera never sees during post-FX excludes them from GTAO entirely; we then draw
// them on top, free of AO and tone mapping (OVERLAY_LAYER — see nametag.ts).
stage.setRenderStep(() => {
  postfx.render() // world + AO + bloom to screen (camera sees layer 0 only)
  const r = stage.renderer
  r.setRenderTarget(null)
  // A solid-colour scene.background forces a buffer clear on render() even with
  // autoClear off — which would wipe the composer output. Null it for the overlay only.
  const bg = stage.scene.background
  stage.scene.background = null
  r.autoClear = false
  stage.camera.layers.set(OVERLAY_LAYER) // render only the overlay (nametags), on top
  r.clearDepth()
  r.render(stage.scene, stage.camera)
  stage.camera.layers.set(0) // restore the world layer for the next frame
  stage.scene.background = bg
  r.autoClear = true
})

// Player views (own + peers): the blocky rig, procedurally animated, + billboard nametag.
// One shared gait object so the debug pane retunes every character live (ADR 0018).
const gait: GaitTuning = { ...DEFAULT_GAIT }
const views = createCharacterViews(stage.scene, gait)
// Spawn assembly timing. Declared up here so the debug pane below can bind it.
const assembleTiming: AssemblyTiming = { stagger: 0.05, fall: 0.18, height: 2.5 }

// --- camera orbit (mouselook via pointer lock) ---
const camera = stage.camera
let camYaw = 0
let camPitch = 0.35
/**
 * Top pitch limit (rad, positive = camera above the character looking down): 90°, straight over the
 * head. Exactly 90° is fine because the orientation is built from the angles — with `lookAt` it was
 * not, since there the view direction goes parallel to `camera.up` and the roll becomes undefined.
 * The bottom limit is a tunable (`params.pitchMinDeg`): nothing structural stops the camera going
 * under the character now that the ground pulls it in.
 */
const PITCH_MAX = Math.PI / 2
const DEG = Math.PI / 180
/**
 * Radius of the sphere swept from the character to the camera to find obstructions. It is the
 * clearance the camera keeps from whatever stopped it, and it has to beat the near plane (0.1 m at
 * 60° vertical FOV = 0.12 m to the near plane's corner) or the wall it stopped at cuts through the
 * frame anyway.
 */
const CAM_PROBE_RADIUS = 0.25
/** Boom height above the orbit sphere — the camera looks slightly down at the target. */
const CAM_RISE = 0.5
/**
 * Half-life (s) for the turn and travel rates that drive the lookahead probe. Mouse movement arrives
 * in bursts, so the raw per-frame rate is spiky; this is short enough to answer a flick and long
 * enough that the predicted boom does not jitter. Move it before touching `camLookahead` if the soft
 * limit ever looks nervous.
 */
const CAM_RATE_HALFLIFE = 0.05
/** The orbit distance the boom has room for, chasing the soft limit. `null` until the first frame. */
let camBoom: number | null = null
let camYawPrev = 0
let camPitchPrev = 0.35
let camYawRate = 0
let camPitchRate = 0
let camTargetPrev: Vec3 = { x: 0, y: 1, z: 0 }
let camVel: Vec3 = vec3()
/** Frame-rate-independent chase toward `to`: `halfLife` is the time to close half the gap. 0 snaps. */
const chase = (from: number, to: number, dt: number, halfLife: number): number =>
  halfLife > 0 ? from + (to - from) * (1 - Math.pow(2, -dt / halfLife)) : to
/**
 * How far the camera may sit along a given boom before it hits the world, in metres. Set once the
 * local sim exists, since that owns the physics world; until then the camera just uses its zoom.
 */
let camClearance: ((target: Vec3, boom: Vec3, want: number) => number) | null = null
const params = {
  /** Zoom goal (m) — what the wheel sets. What renders is `camDistance`, which chases this. */
  camZoom: 7,
  camZoomMin: 3,
  camZoomMax: 14,
  /** Metres one notch moves at zero zoom. It grows with the current zoom — see the wheel handler. */
  camZoomStep: 0.5,
  camZoomGrowth: 0.04,
  /** Half-life (s) of the rendered distance chasing the goal. 0 snaps. */
  camZoomSmooth: 0.08,
  /** Lowest pitch (degrees below the eyeline). The ground no longer stops the camera, it pulls it in. */
  pitchMinDeg: -80,
  /**
   * Lookahead (s) for the soft limit — how far into the future the second probe is aimed. Longer gives
   * the camera more warning and so a smoother move in, at the cost of reacting to obstructions it may
   * never actually reach. 0 turns the soft limit off, leaving the hard clamp: instant pull-in.
   */
  camLookahead: 0.15,
  /** Half-life (s) of the camera moving in toward the soft limit. */
  camPushInSmooth: 0.06,
  /** Half-life (s) of the camera easing back out once an obstruction clears. */
  camReturnSmooth: 0.18,
  /**
   * Clearance (m) the camera must keep from your own capsule before your rig is hidden. Below it you
   * would be looking at the inside of your own head. 0.12 m is the near plane's corner at a 60° FOV,
   * so anything under that is already cutting into the frame.
   */
  camHideMargin: 0.15,
  sensitivity: 0.0025,
}
/** The orbit distance actually rendered: `camZoom` smoothed, so a notch glides instead of jumping. */
let camDistance = params.camZoom
canvas.addEventListener('click', () => {
  if (document.pointerLockElement !== canvas) void canvas.requestPointerLock()
})
// Left click respawns while dead — but only during locked play, so the click that *re-captures* the mouse
// after the pause menu does not also cut a death short.
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0 && dead && document.pointerLockElement === canvas) requestRespawn?.()
})
window.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return
  camYaw -= e.movementX * params.sensitivity
  camPitch = clamp(camPitch + e.movementY * params.sensitivity, params.pitchMinDeg * DEG, PITCH_MAX)
})
// Wheel zoom. One notch per event whatever the device reports — `deltaY` is ±100 on one mouse, ±3 on
// another and a page height on a third, so only the sign is portable. The step grows with the current
// distance, as Roblox's does, so the far end of the range is not thirty notches away. Gated on pointer
// lock: scrolling the debug pane with the mouse free must not move the camera.
window.addEventListener(
  'wheel',
  (e) => {
    if (document.pointerLockElement !== canvas) return
    e.preventDefault()
    const dir = Math.sign(e.deltaY)
    if (dir === 0) return
    params.camZoom = clamp(
      params.camZoom + dir * params.camZoomStep * (1 + params.camZoom * params.camZoomGrowth),
      params.camZoomMin,
      params.camZoomMax,
    )
  },
  { passive: false },
)

// --- input --- (physical key codes: layout-independent)
const keys = new Set<string>()
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault()
  keys.add(e.code)
})
window.addEventListener('keyup', (e) => keys.delete(e.code))
// Camera-relative world-space move direction from WASD/arrows (+ current camera yaw).
const worldMove = (): { x: number; z: number } => {
  const { x: rawX, z: rawZ } = keysToMovement(keys)
  if (rawX === 0 && rawZ === 0) return { x: 0, z: 0 }
  const fwdX = -Math.sin(camYaw)
  const fwdZ = -Math.cos(camYaw)
  const rightX = -fwdZ
  const rightZ = fwdX
  let x = fwdX * -rawZ + rightX * rawX
  let z = fwdZ * -rawZ + rightZ * rawX
  const len = Math.hypot(x, z)
  if (len > 1) {
    x /= len
    z /= len
  }
  return { x, z }
}

// --- debug pane ---
// Own host element with an explicit stacking order: the Pixi UI canvas is at z-index 10, and
// with tweakpane's default wrapper the pause screen covered the pane — i.e. it was unreachable
// exactly when the mouse is free (during play the game holds pointer lock). Dev tooling stays
// on top of the game UI.
const paneHost = document.createElement('div')
paneHost.style.cssText = 'position:fixed;top:8px;right:8px;width:256px;z-index:100'
document.body.appendChild(paneHost)
const pane = new Pane({ title: 'Debug', container: paneHost })
const cam = pane.addFolder({ title: 'Camera' })
// No slider for the zoom itself — the wheel owns it, and tweakpane does not track a value changed
// from outside. These are its bounds and its feel instead.
cam.addBinding(params, 'camZoomMin', { min: 0.5, max: 10, step: 0.5, label: 'zoom min m' })
cam.addBinding(params, 'camZoomMax', { min: 4, max: 40, step: 0.5, label: 'zoom max m' })
cam.addBinding(params, 'camZoomStep', { min: 0.1, max: 3, step: 0.1, label: 'notch m' })
cam.addBinding(params, 'camZoomGrowth', { min: 0, max: 0.2, step: 0.005, label: 'notch growth' })
cam.addBinding(params, 'camZoomSmooth', { min: 0, max: 0.4, step: 0.01, label: 'zoom smooth s' })
cam.addBinding(params, 'pitchMinDeg', { min: -89, max: 0, step: 1, label: 'pitch floor °' })
cam.addBinding(params, 'camLookahead', { min: 0, max: 0.5, step: 0.01, label: 'lookahead s' })
cam.addBinding(params, 'camPushInSmooth', { min: 0, max: 0.5, step: 0.01, label: 'push-in s' })
cam.addBinding(params, 'camReturnSmooth', { min: 0, max: 1, step: 0.01, label: 'pull-out s' })
cam.addBinding(params, 'camHideMargin', { min: 0, max: 1, step: 0.01, label: 'rig hide m' })
cam.addBinding(params, 'sensitivity', { min: 0.0005, max: 0.006, step: 0.0005, label: 'sensitivity' })

// Live locomotion feel (client-authoritative, so tuning is purely local — ADR 0011/0012).
const tuning: CharacterTuning = { ...DEFAULT_TUNING }
const mv = pane.addFolder({ title: 'Movement (Roblox-like)' })
mv.addBinding(tuning, 'moveSpeed', { min: 1, max: 12, step: 0.1, label: 'speed m/s' })
mv.addBinding(tuning, 'jumpHeight', { min: 0.5, max: 5, step: 0.1, label: 'jump apex m' })
mv.addBinding(tuning, 'gravity', { min: 10, max: 100, step: 1, label: 'gravity m/s²' })
mv.addBinding(tuning, 'groundAccelTime', { min: 0, max: 0.5, step: 0.01, label: 'accel s' })
mv.addBinding(tuning, 'groundStopTime', { min: 0, max: 0.5, step: 0.01, label: 'stop s' })
mv.addBinding(tuning, 'airControl', { min: 0, max: 1, step: 0.05, label: 'air control' })

// Live render tuning (content C3) — the greybox polish is data, so you can dial it here.
const renderParams = { exposure: 1.0, bloom: true, bloomStrength: 0.3 }
const rp = pane.addFolder({ title: 'Render (greybox C3)' })
rp.addBinding(renderParams, 'exposure', { min: 0.4, max: 2, step: 0.05 }).on('change', (e) => {
  stage.renderer.toneMappingExposure = e.value
})
rp.addBinding(renderParams, 'bloom').on('change', (e) => {
  postfx.bloom.enabled = e.value
})
rp.addBinding(renderParams, 'bloomStrength', { min: 0, max: 1.5, step: 0.05, label: 'bloom str' }).on('change', (e) => {
  postfx.bloom.strength = e.value
})

// Gait feel (ADR 0018). Read fresh every frame by every character's animator, so these are live.
const gf = pane.addFolder({ title: 'Gait (procedural)', expanded: false })
gf.addBinding(gait, 'bob', { min: 0, max: 0.3, step: 0.005, label: 'body bob m' })
gf.addBinding(gait, 'lean', { min: 0, max: 0.6, step: 0.01, label: 'lean rad' })
gf.addBinding(gait, 'torsoTwist', { min: 0, max: 0.5, step: 0.01, label: 'torso twist' })
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
inf.addBinding(gait, 'inertiaLowerArm', { min: 0, max: 3, step: 0.05, label: 'w forearm' })
inf.addBinding(gait, 'inertiaHip', { min: 0, max: 0.15, step: 0.005, label: 'hip lag m' })
inf.addBinding(gait, 'inertiaVertical', { min: 0, max: 0.8, step: 0.01, label: 'compress m' })
inf.addBinding(gait, 'inertiaFloat', { min: 0, max: 4, step: 0.05, label: 'arm float rad' })

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

// Joint lag (ADR 0018). One mechanism for the neck and both shoulders: each interpolates toward the
// **world** position of the point it attaches to, so it is simply late to wherever the body went. Zero
// welds it. Raise it and the joint trails further behind everything the character does, saturating at its
// max. At 5.5 m/s the trail is about 0.005 → 40 mm, 0.01 → 79 mm, 0.03 → the stop. Crank a lag and its max
// to maximum to confirm it is working, then tune down.
const lf = pane.addFolder({ title: 'Joint lag', expanded: false })
lf.addBinding(gait, 'headLagHalfLife', { min: 0, max: 0.06, step: 0.001, label: 'head lag s' })
lf.addBinding(gait, 'headLagMax', { min: 0, max: 0.4, step: 0.01, label: 'head max m' })
lf.addBinding(gait, 'armLagHalfLife', { min: 0, max: 0.06, step: 0.001, label: 'arm lag s' })
lf.addBinding(gait, 'armLagMax', { min: 0, max: 0.4, step: 0.01, label: 'arm max m' })

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

// Death, on demand. The real triggers are hazard contact and the level's fall plane, but reaching either
// costs a run — and the ragdoll is the kind of thing that wants looking at twenty times in a row.
const df = pane.addFolder({ title: 'Death', expanded: false })
df.addButton({ title: 'Ragdoll now' }).on('click', () => requestDeath?.())
// Spawn assembly. Total length is 5 x stagger + fall, so the defaults run in 0.43 s.
df.addBinding(assembleTiming, 'stagger', { min: 0, max: 0.4, step: 0.01, label: 'pair gap s' })
df.addBinding(assembleTiming, 'fall', { min: 0.02, max: 1, step: 0.01, label: 'fall s' })
df.addBinding(assembleTiming, 'height', { min: 0.2, max: 8, step: 0.1, label: 'drop from m' })


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
let lastSimTickAt = 0 // wall-clock of the last fixed tick, for render-interpolating clock-driven pieces
let requestRespawn: (() => void) | null = null // set once the local sim exists; used by the pause menu's Restart
let requestDeath: (() => void) | null = null // set once the local sim exists; the death path, for the ragdoll
// Death state. `dead` gates input and the kill checks; `ragdoll` is the ten loose bodies, synced per frame
// and thrown away on respawn. Local and visual only — nothing about a death goes on the wire.
let dead = false
let ragdoll: Ragdoll | null = null
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
const persistence = localParkourPersistence()

const initLocalSim = async (id: EntityId): Promise<void> => {
  await initPhysics()
  // Client-owned world (ADR 0011). The character is kinematic and integrates its own gravity, so Rapier's
  // gravity never touches it — but the ragdoll's parts are *dynamic* and it is the only thing that pulls
  // them down. It was zero here, which left a corpse coasting off in a straight line for ever.
  const world = createPhysicsWorld({ gravity: { x: 0, y: -tuning.gravity, z: 0 } })
  loaded = instantiateLevel(world, validateLevel(showcase))

  // Build the level's greybox meshes via the shared renderer (content C3). Marker pads are
  // just their (colour-coded) box here; radius/overlay visualization belongs in the viewer.
  levelView = addLevel(stage.scene, loaded.visuals)
  // Gameplay triggers are the pads' own colliders (content C5 seam): the engine reports
  // real contact via char.body.collisions() — no distance heuristics.
  const checkpointTriggers = loaded.triggers.filter((t) => t.kind === 'checkpoint')
  const hazardHandles = new Set(loaded.triggers.filter((t) => t.kind === 'hazard').map((t) => t.colliderHandle))
  const { fallBehavior, fallY } = loaded.config

  // Markers sit on a surface; the capsule's *centre* must clear it by its stand height so
  // the player rests on top rather than sinking in.
  const STAND_OFFSET = CHAR_HALF_HEIGHT + CHAR_RADIUS

  // Spawn: last checkpoint touched (persisted), else the level's spawn marker (spread a
  // little by id so players don't stack), else a fallback.
  const spawnMarker = loaded.markers.find((m) => m.kind === 'spawn')?.position
  const playerState = persistence.load()
  const a = id * 2.399963
  const cp =
    playerState.checkpoint >= 0 && playerState.checkpoint < checkpointTriggers.length
      ? checkpointTriggers[playerState.checkpoint]!.position
      : undefined
  const spawn =
    cp !== undefined
      ? { x: cp.x, y: cp.y + STAND_OFFSET, z: cp.z }
      : spawnMarker !== undefined
        ? { x: spawnMarker.x + Math.cos(a) * 2, y: spawnMarker.y + STAND_OFFSET, z: spawnMarker.z + Math.sin(a) * 2 }
        : playerSpawn(id)
  const char: CharacterState = addCharacter(world, spawn)
  ownState = char // the render loop reads velocity/grounded straight off the sim for our own rig

  /**
   * Camera occlusion: sweep a sphere from the character's head out along the boom and report how far it
   * got. Everything in the level is a collider already — including the hazard and checkpoint pads, which
   * are solid pieces you stand on, so the camera treating them as geometry is right.
   *
   * Excluded: ourselves. The boom starts at the capsule's crown, so the probe overlaps the capsule every
   * single frame and would report zero clearance; and while dead the ragdoll's parts are our own body too,
   * not scenery to be shoved away from.
   */
  camClearance = (origin, direction, want) => {
    const own = ragdoll === null ? [char.body.colliderHandle] : [char.body.colliderHandle, ...ragdoll.colliders]
    return world.castSphere({ origin, direction, maxDistance: want, radius: CAM_PROBE_RADIUS, exclude: own })?.distance ?? want
  }

  // Respawn: teleport to the last checkpoint (or spawn) and kill momentum. Triggered by
  // touching a hazard pad or falling below the level's kill plane (mode config).
  let respawnPos: Vec3 = { ...spawn }
  const respawn = (): void => {
    clearRagdoll()
    char.body.setPosition(respawnPos)
    char.vx = 0
    char.vy = 0
    char.vz = 0
    char.grounded = false
    startAssembly()
  }
  requestRespawn = respawn // let the pause menu's Restart reach it

  /**
   * Death: the animated rig is replaced by ten dynamic bodies in exactly the pose it was in, and the
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
      loaded?.update(simClock.tick(), char.base?.colliderHandle)
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
          position: e.position,
          shape: { kind: 'capsule', halfHeight: CHAR_HALF_HEIGHT, radius: CHAR_RADIUS },
        })
        remotes.set(e.id, mirror)
      }
      mirror.setNextKinematicTranslation(e.position)
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
      const move = dead ? { x: 0, z: 0 } : worldMove()
      if (move.x !== 0 || move.z !== 0) ownFacing = Math.atan2(move.x, move.z)
      controller!.step(move.x, move.z, !dead && keys.has('Space'))
      // After the world has stepped: the ragdoll's bodies only move on a tick, so this is where their new
      // pose is taken. The render loop interpolates between the last two.
      ragdoll?.capture()

      const p = controller!.state().get(id)
      if (p) {
        // Position plus the animation bits a viewer cannot derive from it (v8): vertical velocity
        // passes through zero at every jump apex, so "grounded" has to be told, not inferred.
        const flags = (char.grounded ? STATE_GROUNDED : 0) | (char.vy > 0 ? STATE_RISING : 0)
        room?.sendBytes(NET_CHANNEL, new Uint8Array(encodeState({ position: p, flags })))
        // Real contact: the colliders the capsule pushed against this tick.
        const hits = new Set(char.body.collisions())
        // Checkpoint touched → it becomes the respawn point (persisted). Progress only
        // advances: touching an earlier checkpoint never lowers your saved index.
        for (let i = 0; i < checkpointTriggers.length; i++) {
          const t = checkpointTriggers[i]!
          if (hits.has(t.colliderHandle) && i > playerState.checkpoint) {
            playerState.checkpoint = i
            persistence.save(playerState)
            respawnPos = { x: t.position.x, y: t.position.y + STAND_OFFSET, z: t.position.z }
            break
          }
        }
        // Hazard touched (any side), or fell below the kill plane → die. Gated on `dead`, or a corpse
        // still falling past the plane would re-trigger every tick.
        const hitHazard = [...hits].some((h) => hazardHandles.has(h))
        if (!dead && (hitHazard || (fallBehavior === 'respawn-checkpoint' && p.y < fallY))) die()
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
    room = await new Client(SERVER_URL).joinOrCreate('parkour', { name: myName })
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
      // Peers: facing and speed derived from the interpolated position; grounded/rising off the
      // wire, because vertical velocity cannot tell standing from a jump apex.
      views.upsert(
        e.id,
        {
          isSelf: false,
          position: e.position,
          yaw: null,
          speed: null,
          vy: null,
          grounded: (e.flags & STATE_GROUNDED) !== 0,
          rising: (e.flags & STATE_RISING) !== 0,
          carry: null, // not derivable from position alone — see CharacterPlacement.carry
          name: names.get(e.id) ?? '…',
        },
        frameDt,
      )
    }
  views.prune(seen) // drop players who left the room (no longer relayed)

  // orbit camera around the own character
  const target = { x: ownPos.x, y: ownPos.y + 1, z: ownPos.z }
  // Re-clamped every frame, because the range itself is tunable in the pane while playing.
  params.camZoom = clamp(params.camZoom, params.camZoomMin, params.camZoomMax)
  camDistance = chase(camDistance, params.camZoom, frameDt, params.camZoomSmooth)

  // Rates, for the lookahead probe below: how fast the mouse is turning the boom and how fast the
  // character is carrying it. Both are differenced per frame and smoothed — mouse deltas arrive in
  // bursts, and an unsmoothed rate makes the predicted boom jitter, which the soft limit then chases.
  if (frameDt > 0) {
    camYawRate = chase(camYawRate, (camYaw - camYawPrev) / frameDt, frameDt, CAM_RATE_HALFLIFE)
    camPitchRate = chase(camPitchRate, (camPitch - camPitchPrev) / frameDt, frameDt, CAM_RATE_HALFLIFE)
    camVel = vec3(
      chase(camVel.x, (target.x - camTargetPrev.x) / frameDt, frameDt, CAM_RATE_HALFLIFE),
      chase(camVel.y, (target.y - camTargetPrev.y) / frameDt, frameDt, CAM_RATE_HALFLIFE),
      chase(camVel.z, (target.z - camTargetPrev.z) / frameDt, frameDt, CAM_RATE_HALFLIFE),
    )
  }
  camYawPrev = camYaw
  camPitchPrev = camPitch
  camTargetPrev = target

  // The boom: where the camera would sit with the world empty. Everything below moves it along this
  // line, never off it, so what the probe cleared is where the camera lands.
  const boomX = Math.sin(camYaw) * Math.cos(camPitch) * camDistance
  const boomY = Math.sin(camPitch) * camDistance + CAM_RISE
  const boomZ = Math.cos(camYaw) * Math.cos(camPitch) * camDistance
  const boom = Math.hypot(boomX, boomY, boomZ)
  // Hard limit: how far the boom has room for *now*. The camera is clamped to it unconditionally, and
  // that clamp is the whole no-clipping guarantee.
  const hard = camClearance?.(target, vec3(boomX, boomY, boomZ), boom) ?? boom
  // Soft limit: the same probe, of the same radius, run where the boom *will* be `lookahead` from now —
  // the character has moved on and the mouse has kept turning. An obstruction about to cross the sight
  // line shows up there before it shows up here, which is the head start the ease needs to arrive
  // before the clamp has to bite. Widening the probe instead would also see it early, and would collapse
  // the camera every time a surface merely runs alongside the boom (ADR 0020).
  let soft = hard
  if (params.camLookahead > 0 && camClearance !== null) {
    const t = params.camLookahead
    const yaw = camYaw + camYawRate * t
    const pitch = clamp(camPitch + camPitchRate * t, params.pitchMinDeg * DEG, PITCH_MAX)
    const aheadBoom = vec3(
      Math.sin(yaw) * Math.cos(pitch) * camDistance,
      Math.sin(pitch) * camDistance + CAM_RISE,
      Math.cos(yaw) * Math.cos(pitch) * camDistance,
    )
    const aheadTarget = vec3(target.x + camVel.x * t, target.y + camVel.y * t, target.z + camVel.z * t)
    const aheadLen = Math.hypot(aheadBoom.x, aheadBoom.y, aheadBoom.z)
    soft = Math.min(hard, camClearance(aheadTarget, aheadBoom, aheadLen))
  }
  // Move toward the soft limit on a half-life — in on one, back out on another — then clamp to the hard
  // limit. `null` on the first frame only, where there is nothing to interpolate from.
  camBoom =
    camBoom === null
      ? soft
      : chase(camBoom, soft, frameDt, soft < camBoom ? params.camPushInSmooth : params.camReturnSmooth)
  const reach = Math.min(camBoom, hard) / boom
  camera.position.set(target.x + boomX * reach, target.y + boomY * reach, target.z + boomZ * reach)
  // Orientation from the boom's *direction*, not from `lookAt`. A fully squeezed boom puts the camera
  // exactly on its target, and lookAt then has a zero-length direction to build a basis from: three
  // falls back to looking along world -Z, which is a fixed heading that ignores the mouse entirely.
  // The direction is known whatever the length is. YXZ order — yaw about Y, then pitch about X — is the
  // one that keeps the horizon level, and it stays defined at straight-up, where lookAt does not.
  camera.rotation.set(-Math.atan2(boomY, Math.hypot(boomX, boomZ)), camYaw, 0, 'YXZ')

  // Your own rig's visibility, decided here because three things want a say and the third needs the
  // camera placed first: death (the ragdoll has the floor), the spawn assembly (the body has not landed
  // yet), and the camera being inside you.
  //
  // The probe deliberately ignores your own body, so nothing stops a low ceiling squeezing the camera
  // into your head — a minimum boom length would instead push the camera *through* the ceiling, which
  // trades your body for the whole world. So the body goes rather than the collision (ADR 0020).
  // Measured against the capsule, whose height and width the rig is built from, so it hides only when
  // the camera is genuinely inside the mesh and not on every close pass: distance from the camera to
  // the capsule's spine, less its radius. Peers are unaffected — they always see you.
  if (myId !== null) {
    const spineY = clamp(camera.position.y - ownPos.y, -CHAR_HALF_HEIGHT, CHAR_HALF_HEIGHT)
    const gap =
      Math.hypot(camera.position.x - ownPos.x, camera.position.y - ownPos.y - spineY, camera.position.z - ownPos.z) -
      CHAR_RADIUS
    views.setVisible(myId, !dead && assembly === null && gap >= params.camHideMargin)
  }
})

// --- pause screen (Pixi UI, ADR 0015) ---
// A transparent Pixi canvas stacked over the Three canvas. The pause screen composition
// lives in pauseMenu.ts; this wires it to the game (params, roster, respawn) and manages the
// pointer-lock handoff.
const ui = await createUiOverlay({ width: window.innerWidth, height: window.innerHeight })
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
    get: () => (params.sensitivity - SENS_MIN) / (SENS_MAX - SENS_MIN),
    set: (t) => {
      params.sensitivity = SENS_MIN + t * (SENS_MAX - SENS_MIN)
    },
  },
  players: () => {
    const items: ListItem[] = [{ text: t('pause.self', { name: myName }), highlight: true }]
    for (const [pid, name] of names) if (pid !== myId) items.push({ text: name })
    return items
  },
})

const resumePlay = (): void => {
  pause.close()
  void canvas.requestPointerLock()
}

// Pointer-lock drives pause state: releasing it (Esc / focus loss) opens the menu; re-locking
// closes it. Tapping empty overlay space (menu closed) re-captures the mouse for look control.
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas) pause.close()
  else pause.open()
})
ui.setBackgroundTap(() => {
  if (!pause.isOpen()) void canvas.requestPointerLock()
})

// Top-left pause button (placeholder glyph until skinned). During locked play the cursor is
// hidden, so this is clickable when free; Esc is the primary open while playing.
const pauseBtn = uiButton({
  label: 'II',
  width: 44,
  height: 40,
  color: 0x475569,
  onClick: () => {
    if (document.pointerLockElement === canvas) document.exitPointerLock()
    else pause.open()
  },
})
pauseBtn.view.position.set(16, 16)
ui.root.addChild(pauseBtn.view)

window.addEventListener('resize', () => {
  ui.resize(window.innerWidth, window.innerHeight)
  pauseBtn.view.position.set(16, 16)
  pause.layout()
})

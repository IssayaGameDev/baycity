import {
  createClockSync,
  createLocalController,
  createSnapshotClient,
  createSnapshotReassembler,
  keysToMovement,
  type LocalController,
  type LocalWorld,
} from '@mp/client'
import { createTouchJoystick, DEFAULT_TOUCH_LAYOUT } from '@mp/client/dom'
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
import {
  addLevel,
  addLights,
  applyGreyboxEnvironment,
  assetIdsIn,
  createAssetRuntime,
  createPostFX,
  createThreeStage,
  loadSky,
  type ContentLights,
  type LevelView,
} from '@mp/render-three'
import {
  addCharacter,
  CHAR_HALF_HEIGHT,
  CHAR_RADIUS,
  DEFAULT_TUNING,
  stepCharacter,
  TICK_DT,
  TICK_RATE_HZ,
  type CharacterState,
  type CharacterTuning,
  DEFAULT_GAIT,
  partTransforms,
  type GaitTuning,
} from '@mp/character'
import { CAMERA_TUNABLES, createOrbitCamera, type OcclusionQueries } from '@mp/camera'
import { instantiateLevel, type LoadedLevel } from '@mp/content'
import { characterAccess, createComponentRuntime, type ComponentRuntime } from '@mp/components'
import { getLocale, matchLocale, onLocaleChange, setLocale, t, type TranslationKey } from '@mp/i18n'
import { createTouchHud, createUiOverlay, uiButton, type ListItem, type TouchHud } from '@mp/render-pixi'
import { Client, type Room } from 'colyseus.js'
import { Pane } from 'tweakpane'

import { createAssembly, type Assembly, type AssemblyTiming } from './assemble'
import { createCharacterViews, PEER_COLORS, SELF_COLORS } from './characterView'
import { BODY_LAYERS } from './layers'
import { OVERLAY_LAYER } from './nametag'
import { createPauseMenu } from './pauseMenu'
import { createRagdoll, type Ragdoll } from './ragdoll'
import { ASSET_DB, CLIP_SOURCE, assetUrlOf, materialOf } from './assets'
import { DEFAULT_NAME, levelByName } from './levels'
import { localParkourPersistence } from './persistence'
import { PARKOUR_MODE } from './editorMode'
import { PARKOUR_REGISTRY, parkourSession, spawnFor } from './rules'

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
const levelName = ((): string => {
  const requested = new URLSearchParams(location.search).get('level')
  if (requested === null) return DEFAULT_NAME
  try {
    levelByName(requested)
    return requested
  } catch (e) {
    console.error(`${String(e)} — falling back to ${DEFAULT_NAME}`)
    return DEFAULT_NAME
  }
})()
const levelData = levelByName(levelName)

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!
const canvas = $<HTMLCanvasElement>('#view')
const statusEl = $<HTMLDivElement>('#status')

// --- localization (ADR 0016) ---
// All player-facing text routes through i18n. The status line is state-driven, so re-render it on locale
// change. Detect the locale up front (stored override, else browser), and persist changes.
const LOCALE_KEY = 'mp.locale'
let statusMsg: { key: TranslationKey; params?: Record<string, string | number> } = { key: 'status.connecting' }
const renderStatus = (): void => {
  statusEl.textContent = t(statusMsg.key, statusMsg.params)
}
const setStatus = (key: TranslationKey, params?: Record<string, string | number>): void => {
  statusMsg = params !== undefined ? { key, params } : { key }
  renderStatus()
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
})
renderStatus()

// --- scene ---
const stage = createThreeStage({ canvas, cameraPosition: [0, 6, 10], lookAt: [0, 1, 0] })
// Polished greybox pipeline (content pipeline C3): IBL + ACES + soft shadows, with GTAO +
// SMAA post-FX. Level meshes, materials (the "High-contrast dev" palette) and markers are
// realized by the shared @mp/render-three renderer — same code the viewer uses.
const env = applyGreyboxEnvironment(stage.renderer, stage.scene, { shadowRadius: 30, sunIntensity: 2.4 })
// The photographic sky stays loaded as the control to judge the procedural one against (ADR 0046). It swaps
// the **background only** — the lighting keeps coming from the procedural bake either way, so flipping the
// toggle compares two backdrops rather than two whole looks. Deleted once the comparison is settled.
const photoSky = await loadSky(stage.scene, assetUrlOf('textures/sky_110_2k.webp'))
if (photoSky !== null && env.sky !== null) stage.scene.background = env.sky.background
const postfx = createPostFX(stage.renderer, stage.scene, stage.camera, {
  ao: true,
  bloom: true,
  bloomStrength: 0.1,
  /**
   * A surface wearing a hole must be absent from the AO prepass, or the character seen through it comes out
   * shaded by occlusion cast by something the player cannot see — which was the one artifact that survived
   * every other fix, and was measured by toggling AO rather than guessed at (ADR 0055).
   */
  aoIgnores: () => levelView?.occluding() ?? [],
})

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
/**
 * Touch controls (ADR 0022): stick bottom-left, jump bottom-right, look everywhere else. Bound to the
 * canvas, so its rect is the coordinate frame the HUD draws in. `active()` stays false until a real touch
 * arrives, which is what keeps a mouse user from ever seeing a joystick.
 */
// Deep-copied, not spread: `stickInset`/`jumpInset` are objects, and a shallow copy would share them with
// the exported default — mutating one here would then move every future mode's controls. Mutable and read
// fresh by the controls, like `gait`, so the pane and the safe-area pass both take effect live.
const touchLayout = {
  ...DEFAULT_TOUCH_LAYOUT,
  stickInset: { ...DEFAULT_TOUCH_LAYOUT.stickInset },
  jumpInset: { ...DEFAULT_TOUCH_LAYOUT.jumpInset },
  stickZone: { ...DEFAULT_TOUCH_LAYOUT.stickZone },
}
/**
 * UI that owns its own pointers. Filled with the debug pane's host further down — it is DOM, it sits inside
 * the look region, and dragging one of its sliders must not also swing the camera. Read per event, so
 * pushing to it after the fact is enough and the pane can stay where it belongs in this file.
 */
const touchIgnore: HTMLElement[] = []
const touch = createTouchJoystick(canvas, touchLayout, { ignore: touchIgnore })

/**
 * Push the controls clear of a notch and the home indicator. `viewport-fit=cover` lets the canvas reach
 * under both, so the insets have to come back here — in landscape, which is how this is held, the big ones
 * are left and right. Re-read on resize because an orientation change changes which edge they are on.
 */
const px = (name: string): number => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0
const applySafeArea = (): void => {
  touchLayout.stickInset.x = DEFAULT_TOUCH_LAYOUT.stickInset.x + px('--safe-left')
  touchLayout.jumpInset.x = DEFAULT_TOUCH_LAYOUT.jumpInset.x + px('--safe-right')
  const bottom = px('--safe-bottom')
  touchLayout.stickInset.y = DEFAULT_TOUCH_LAYOUT.stickInset.y + bottom
  touchLayout.jumpInset.y = DEFAULT_TOUCH_LAYOUT.jumpInset.y + bottom
}
applySafeArea()
window.addEventListener('resize', applySafeArea)
/** True once the player has touched the screen — the mode then stops asking for pointer lock. */
const onTouch = (): boolean => touch.active()
/**
 * The on-screen controls, and whether the pause menu is up. Both live on the Pixi overlay, which is built
 * with an `await` **after** the render loop starts — so a frame can run before they exist and the loop has
 * to cope with that rather than reference them eagerly.
 */
let touchHud: TouchHud | null = null
let menuOpen: () => boolean = () => false

canvas.addEventListener('click', () => {
  // Never on touch: there is no pointer lock on mobile, and asking for it on every tap throws.
  if (!onTouch() && document.pointerLockElement !== canvas) void canvas.requestPointerLock()
})
// Left click respawns while dead — but only during locked play, so the click that *re-captures* the mouse
// after the pause menu does not also cut a death short. The touch equivalent is a tap in the look region,
// drained in the render loop (ADR 0022); a placeholder in both cases until the dev menu has its own button.
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0 && dead && document.pointerLockElement === canvas) requestRespawn?.()
})
window.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return
  orbit.lookMouse(e.movementX, e.movementY)
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
    orbit.zoomNotch(Math.sign(e.deltaY))
  },
  { passive: false },
)

// --- input --- (physical key codes: layout-independent)
const keys = new Set<string>()
/**
 * A jump keypress seen since the last tick, latched and drained once per tick. `keys.has('Space')` is a
 * *level* read at tick time, and at 30 Hz a tap pressed and released inside one 33 ms tick never appears
 * in it at all — the press was silently thrown away. `e.repeat` is excluded so auto-repeat while the key
 * is held adds nothing: holding is already covered by the level read.
 */
let jumpLatch = false
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault()
  if (e.code === 'Space' && !e.repeat) jumpLatch = true
  keys.add(e.code)
})
window.addEventListener('keyup', (e) => keys.delete(e.code))
// Camera-relative world-space move direction from WASD/arrows (+ current camera yaw).
const worldMove = (): { x: number; z: number } => {
  // Keyboard first, stick otherwise: on a hybrid device the two must never fight, and releasing the key
  // hands control straight back. Both produce the same `{x, z}` in −1..1, so the camera-relative rotation
  // below is shared — a stick pushed left strafes left and the character turns to face it, exactly like A.
  const k = keysToMovement(keys)
  const stick = touch.movement()
  const { x: rawX, z: rawZ } = k.x !== 0 || k.z !== 0 ? k : stick
  if (rawX === 0 && rawZ === 0) return { x: 0, z: 0 }
  const facing = orbit.yaw()
  const fwdX = -Math.sin(facing)
  const fwdZ = -Math.cos(facing)
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
touchIgnore.push(paneHost) // see `touchIgnore`
const pane = new Pane({ title: 'Debug', container: paneHost })
const cam = pane.addFolder({ title: 'Camera' })
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
cam.addBinding(debug, 'ambientOcclusion', { label: 'ambient occl.' }).on('change', (e) => {
  if (postfx.ao !== null) postfx.ao.enabled = e.value
})
// Sky + sun (ADR 0046). Every one of these needs an eye rather than a value, so they all live here. The sun
// angles drive the key light, its shadow frustum and the sky bake together, which is why there is no separate
// light direction to set. The sky is a designed gradient rather than atmospheric scattering, because the shape
// wanted here (light at the top, darkening all the way down) is the inverse of what scattering produces.
const skyFolder = pane.addFolder({ title: 'Sky' })
const skyView = { source: 'procedural' as 'procedural' | 'photo', fill: 0.4, sunIntensity: 2.4 }
if (env.sky !== null) {
  const rebake = (): void => env.refresh()
  skyFolder.addBinding(env.sunAngles, 'elevationDeg', { min: 1, max: 89, step: 1, label: 'sun elev °' }).on('change', rebake)
  skyFolder.addBinding(env.sunAngles, 'azimuthDeg', { min: -180, max: 180, step: 1, label: 'sun azim °' }).on('change', rebake)
  // The gradient. Two ends and a curve, so it is monotonic whatever you set: light at the top falling to dark
  // at the bottom, with no way to produce a bright band in the middle.
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
  // How hard the sky lights the level, and the neutral counterweight to its colour cast. At full strength the
  // sky's ambient measures blue twenty-one times red and beats the key light, which washes everything blue and
  // flattens the shadows. `env light` is `scene.environmentIntensity`, which is independent of
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
}

// Touch controls (ADR 0022). Kodjo keeps the pane on phones, and these are the numbers that need a thumb
// to judge. `anchor` is the one to try first: `recentre` moves the stick's centre to wherever the zone was
// touched and starts from a standstill, `fixed` keeps it at the drawn home and deflects on contact.
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

// Live locomotion feel (client-authoritative, so tuning is purely local — ADR 0011/0012).
const tuning: CharacterTuning = { ...DEFAULT_TUNING }
const mv = pane.addFolder({ title: 'Movement (Roblox-like)' })
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

// Live render tuning (content C3) — the greybox polish is data, so you can dial it here.
const renderParams = { exposure: 1.0, bloom: true, bloomStrength: 0.1 }
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
// Spawn assembly. Total length is 6 x stagger + fall, so the defaults run in 0.48 s.
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
const persistence = localParkourPersistence()

const initLocalSim = async (id: EntityId): Promise<void> => {
  await initPhysics()
  // Client-owned world (ADR 0011). The character is kinematic and integrates its own gravity, so Rapier's
  // gravity never touches it — but the ragdoll's parts are *dynamic* and it is the only thing that pulls
  // them down. It was zero here, which left a corpse coasting off in a straight line for ever.
  const world = createPhysicsWorld({ gravity: { x: 0, y: -tuning.gravity, z: 0 } })
  physicsWorld = world // the render loop builds peers' corpses in it
  loaded = instantiateLevel(world, levelData, PARKOUR_REGISTRY, CLIP_SOURCE)

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
  const rules = parkourSession(loaded, {
    from: playerState.checkpoint,
    onProgress: (progress) => {
      playerState.checkpoint = progress
      persistence.save(playerState)
    },
  })

  // Spawn: wherever the rules resumed to (a persisted checkpoint), else this game's spawn rule, which
  // spreads arrivals around the marker by id so two players do not stack.
  const spawn = playerState.checkpoint >= 0 ? rules.respawnAt() : spawnFor(loaded, id)
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
  const components: ComponentRuntime = createComponentRuntime(loaded, PARKOUR_REGISTRY, {
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
      const move = dead ? { x: 0, z: 0 } : worldMove()
      if (move.x !== 0 || move.z !== 0) ownFacing = Math.atan2(move.x, move.z)
      // Held *or* tapped. The two level reads (`keys.has`, `touch.jump`) are what make holding either one
      // re-jump the instant you land (ADR 0022); the two latches are what make a tap shorter than a tick
      // register at all. Both latches are drained every tick, dead or alive and menu or no menu, so a
      // press made during a pause cannot surface as a jump later. `stepCharacter` holds the press for
      // `jumpBufferTime` from here, which is what lets it land slightly before the ground does.
      const keyTap = jumpLatch
      jumpLatch = false
      const touchTap = touch.drainJumpPress()
      const vyBefore = char.vy
      const groundedBefore = char.grounded
      controller!.step(move.x, move.z, !dead && (keys.has('Space') || touch.jump() || keyTap || touchTap))
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
    room = await new Client(SERVER_URL).joinOrCreate('game', { name: myName, game: PARKOUR_MODE.name, level: levelName })
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
  if (!onTouch()) void canvas.requestPointerLock()
}

// On a mouse, pointer lock *is* the pause state: releasing it (Esc / focus loss) opens the menu and
// re-locking closes it. Touch has no lock at all, so there the pause button is the only way in and out —
// hence the guard, without which the first touch would open the menu and never let it close.
document.addEventListener('pointerlockchange', () => {
  if (onTouch()) return
  if (document.pointerLockElement === canvas) pause.close()
  else pause.open()
})
ui.setBackgroundTap(() => {
  if (!onTouch() && !pause.isOpen()) void canvas.requestPointerLock()
})

// Top-left pause button (placeholder glyph until skinned). During locked play the cursor is
// hidden, so this is clickable when free; Esc is the primary open while playing.
const pauseBtn = uiButton({
  label: 'II',
  width: 44,
  height: 40,
  color: 0x475569,
  onClick: () => {
    if (onTouch()) pause.open()
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

import { CHAR_HALF_HEIGHT, CHAR_RADIUS } from '@mp/character'
import { clamp, vec3, type Vec3 } from '@mp/core'
import { createCutoutMask, THREE, type CutoutMask } from '@mp/render-three'

import { occlusionFor, type Occlusion, type OcclusionQueries } from './occlusion'

/**
 * The third-person orbit camera (ADR 0020, amended by ADR 0055) — boom, zoom, occlusion, the see-through
 * hole, the landing dip, and whether the player's own rig is inside the lens.
 *
 * A package rather than a game's composition root, because none of it is one game's: it grew to several
 * hundred lines inside `modes/parkour/src/main.ts`, where a second game would have had to copy it and every
 * fix would have had to be made twice.
 *
 * **No DOM here.** The host owns pointer lock, wheel events and touch, and calls `lookMouse`, `zoomNotch`
 * and friends. That is what keeps this testable and what stops the camera growing an opinion about input
 * devices beyond the sensitivities, which are feel and belong with the rest of the feel.
 *
 * **No physics dependency either**, only the two queries `observe` is handed. The world does not exist when
 * the camera is built — the local sim arrives with the first snapshot — and injecting the queries is what
 * lets `occlusion.ts` be tested against slabs on a number line.
 */
export interface CameraParams {
  /**
   * Vertical field of view, degrees.
   *
   * A camera parameter and not a renderer constant: FOV is feel, and it trades framing against distortion
   * the same way the zoom range does. It was hardcoded at 60 in `createThreeStage`, where no game and no
   * level could reach it.
   *
   * Two other numbers were derived from 60 by hand and do **not** follow it: `camHideMargin`'s default and
   * `PROBE_RADIUS` are both sized against the near plane's corner at 60°. Widening the lens moves that
   * corner outward, so a very wide FOV wants a larger hide margin — which is a slider, so it can have one.
   */
  fov: number
  /** Zoom goal (m) — what the wheel sets. What renders is a distance that chases this. */
  camZoom: number
  camZoomMin: number
  camZoomMax: number
  /** Metres one notch moves at zero zoom. It grows with the current zoom — see `zoomNotch`. */
  camZoomStep: number
  camZoomGrowth: number
  /** Half-life (s) of the rendered distance chasing the goal. 0 snaps. */
  camZoomSmooth: number
  /** Lowest pitch (degrees below the eyeline). The ground does not stop the camera, it pulls it in. */
  pitchMinDeg: number
  /**
   * Lookahead (s) for the soft limit — how far into the future the second probe is aimed. Longer gives the
   * camera more warning and so a smoother move in, at the cost of reacting to obstructions it may never
   * reach. 0 turns the soft limit off, leaving the hard clamp: instant pull-in.
   */
  camLookahead: number
  /** Half-life (s) of the camera moving in toward the soft limit. */
  camPushInSmooth: number
  /** Half-life (s) of the camera easing back out once an obstruction clears. */
  camReturnSmooth: number
  /**
   * Camera dip on landing (m at an impact of 1, i.e. landing your own jump). The one piece of jump feel
   * that lives in the view rather than the controller: the character stops dead on contact and the camera
   * carrying on down for a moment is what sells the weight. 0 turns it off.
   */
  landKick: number
  /** Ceiling on the impact multiplier, so a fall from the skybox does not throw the camera through the floor. */
  landKickMax: number
  /** Half-life (s) of the dip easing back out. Short enough to read as an impact, not a bob. */
  landKickRecovery: number
  /**
   * Clearance (m) the camera must keep from the character's own capsule before the rig is hidden. Below it
   * you would be looking at the inside of your own head. 0.12 m is the near plane's corner at a 60° FOV, so
   * anything under that is already cutting into the frame.
   */
  camHideMargin: number
  /** Hole radius (m) at the character. The capsule is 0.8 m wide and 2 m tall, so 1.3 clears it. */
  camMaskRadius: number
  /** Soft edge of the hole, as a fraction of its radius. The dither ramps out across it. */
  camMaskFeather: number
  /** Half-life (s) of the aperture opening and closing. Keeps a passing beam from popping. */
  camMaskSmooth: number
  /**
   * Half-life (s) of moving into an authored eye position and back out again — see `shot`.
   *
   * Its own number rather than reusing the zoom or push-in smoothing, because it is a different kind of
   * move: those slide the camera **along** the boom, and this one travels off it to somewhere else entirely.
   * 0 snaps, which is a cut rather than a move and is occasionally what you want.
   */
  shotSmooth: number
  /** Mouse look, radians per unit of `movementX` (a raw device delta). */
  sensitivity: number
  /**
   * Look sensitivity for a **finger** (rad per CSS pixel). Its own number, and far larger than the mouse
   * one: `movementX` is a raw device delta, while a thumb crosses a few hundred CSS pixels for a whole turn
   * (ADR 0022).
   */
  touchSensitivity: number
  /** Pinch: metres of zoom per CSS pixel of finger separation. A pinch is ~300 px for the whole range. */
  pinchZoom: number
}

export const DEFAULT_CAMERA_PARAMS: CameraParams = {
  // The value the stage hardcoded, so this change moves nothing until somebody drags the slider.
  fov: 60,
  camZoom: 7,
  camZoomMin: 3,
  camZoomMax: 14,
  camZoomStep: 0.5,
  camZoomGrowth: 0.04,
  camZoomSmooth: 0.08,
  pitchMinDeg: -80,
  camLookahead: 0.15,
  camPushInSmooth: 0.06,
  camReturnSmooth: 0.18,
  landKick: 0.12,
  landKickMax: 2.5,
  landKickRecovery: 0.12,
  camHideMargin: 0.15,
  camMaskRadius: 1.3,
  camMaskFeather: 0.5,
  camMaskSmooth: 0.03,
  // Long enough to read as a camera move rather than a teleport, short enough not to feel sluggish.
  shotSmooth: 0.25,
  sensitivity: 0.0025,
  touchSensitivity: 0.006,
  pinchZoom: 0.02,
}

/**
 * One tunable, as data. The camera describes its own knobs and the host builds whatever UI it has, so this
 * package never learns what a Tweakpane is — and the list cannot drift from the parameters, because a test
 * checks every key against `DEFAULT_CAMERA_PARAMS`.
 */
export interface Tunable {
  key: keyof CameraParams
  label: string
  min: number
  max: number
  step: number
}

export const CAMERA_TUNABLES: readonly Tunable[] = [
  { key: 'fov', label: 'fov °', min: 30, max: 110, step: 1 },
  { key: 'camZoomMin', label: 'zoom min m', min: 0.5, max: 10, step: 0.5 },
  { key: 'camZoomMax', label: 'zoom max m', min: 4, max: 40, step: 0.5 },
  { key: 'camZoomStep', label: 'notch m', min: 0.1, max: 3, step: 0.1 },
  { key: 'camZoomGrowth', label: 'notch growth', min: 0, max: 0.2, step: 0.005 },
  { key: 'camZoomSmooth', label: 'zoom smooth s', min: 0, max: 0.4, step: 0.01 },
  { key: 'landKick', label: 'land dip m', min: 0, max: 0.4, step: 0.01 },
  { key: 'landKickRecovery', label: 'land dip s', min: 0.02, max: 0.5, step: 0.01 },
  { key: 'pitchMinDeg', label: 'pitch floor °', min: -89, max: 0, step: 1 },
  { key: 'camLookahead', label: 'lookahead s', min: 0, max: 0.5, step: 0.01 },
  { key: 'camPushInSmooth', label: 'push-in s', min: 0, max: 0.5, step: 0.01 },
  { key: 'camReturnSmooth', label: 'pull-out s', min: 0, max: 1, step: 0.01 },
  { key: 'camHideMargin', label: 'rig hide m', min: 0, max: 1, step: 0.01 },
  { key: 'camMaskRadius', label: 'hole m', min: 0.2, max: 4, step: 0.05 },
  { key: 'camMaskFeather', label: 'hole edge', min: 0, max: 2, step: 0.05 },
  { key: 'camMaskSmooth', label: 'hole open s', min: 0, max: 0.5, step: 0.01 },
  { key: 'shotSmooth', label: 'shot move s', min: 0, max: 1.5, step: 0.01 },
  { key: 'sensitivity', label: 'sensitivity', min: 0.0005, max: 0.006, step: 0.0005 },
]

export interface Placement {
  /** Whether the player's own rig should be drawn, or the camera is inside it. */
  rigVisible: boolean
}

export interface OrbitCamera {
  /** Live, mutable, and read fresh every frame — so a debug pane can drive the feel while playing. */
  params: CameraParams
  /** The see-through hole, for `addLevel`. */
  cutout: CutoutMask
  /**
   * The boom yaw, radians. The host needs it to make movement camera-relative — a stick pushed left has to
   * strafe left — and that is the only reason any of the orbit state is readable from outside.
   */
  yaw: () => number
  /**
   * Radius of the sphere the occlusion queries must sweep. The camera owns the number, because it is the
   * clearance the camera keeps from what stopped it, but the host builds the queries.
   */
  probeRadius: number
  /** Pointer-lock deltas, in whatever units `movementX`/`movementY` reported. */
  lookMouse: (dx: number, dy: number) => void
  /** Touch-drag deltas, in CSS pixels. */
  lookTouch: (dx: number, dy: number) => void
  /** One wheel notch. Only the sign is used — `deltaY` is ±100 on one mouse and a page height on another. */
  zoomNotch: (dir: number) => void
  /** Pinch, in CSS pixels of finger separation. */
  zoomPinch: (px: number) => void
  /**
   * A landing to dip for, as a multiple of the speed a plain jump lands at, so 1 is landing your own jump.
   * Clamped by `landKickMax` here rather than at the call site, which is a sim tick with no opinion on feel.
   */
  /**
   * Put the eye at an **authored world position** instead of on the boom, or `null` to go back to orbiting.
   *
   * The camera still looks at the character, and still holes whatever is in the way (ADR 0055) — what it stops
   * doing is orbiting. Mouse look is overridden while a shot is held, deliberately: a shot the player can
   * swing away from is not a shot.
   *
   * **The occlusion pull-in does not apply.** Somebody placed this eye; moving it because a wall is near
   * would be second-guessing them, and a shot inside a wall is a mistake that is obvious the moment you see
   * it. The see-through hole still runs, along the shot's own sightline rather than the boom's, which is the
   * same split ADR 0055 settled: hole the obstruction, do not move the camera.
   *
   * Blends in and out on `shotSmooth`, and hands back continuously — the orbit's yaw and pitch track the
   * blended direction throughout, so releasing a shot does not snap.
   */
  shot: (eye: Vec3 | null) => void
  land: (impact: number) => void
  /** The world's occlusion queries. Until this is called the camera simply uses its zoom. */
  observe: (queries: OcclusionQueries) => void
  /**
   * Place the camera for this frame around `body`, the character capsule's **centre**, and report what the
   * host has to do about the rig. `setOccluders` is the level view's, for the see-through hole.
   */
  update: (dt: number, body: Vec3, setOccluders: (handles: readonly number[]) => void) => Placement
}

/**
 * Straight up is exactly `π/2`, no epsilon: the orientation is built from the angles, so it stays defined
 * there. With `lookAt` it would not be — the view direction goes parallel to `camera.up` and the roll
 * becomes undefined.
 */
const PITCH_MAX = Math.PI / 2
const DEG = Math.PI / 180
/**
 * Radius of the sphere swept from the character to the camera to find obstructions. It is the clearance the
 * camera keeps from whatever stopped it, and it has to beat the near plane (0.1 m at 60° vertical FOV =
 * 0.12 m to the near plane's corner) or the wall it stopped at cuts through the frame anyway.
 */
const PROBE_RADIUS = 0.25
/** Boom height above the orbit sphere — the camera looks slightly down at the target. */
const RISE = 0.5
/**
 * How far above the capsule's centre the camera aims. The capsule is 2 m tall, so this is level with the top
 * of the head — the framing everyone expects, and the reason the occlusion probes exist: a sightline to
 * *this* point is not a sightline to the body.
 */
const AIM_RISE = 1
/**
 * Half-life (s) for the turn and travel rates that drive the lookahead probe. Mouse movement arrives in
 * bursts, so the raw per-frame rate is spiky; this is short enough to answer a flick and long enough that
 * the predicted boom does not jitter. Move it before touching `camLookahead` if the soft limit ever looks
 * nervous.
 */
const RATE_HALFLIFE = 0.05

/** Frame-rate-independent chase toward `to`: `halfLife` is the time to close half the gap. 0 snaps. */
export const chase = (from: number, to: number, dt: number, halfLife: number): number =>
  halfLife > 0 ? from + (to - from) * (1 - Math.pow(2, -dt / halfLife)) : to

/**
 * The points the camera checks are visible, given where it is aiming: the capsule's centre and the bottom of
 * its spine. Two sightlines down the body besides the aim point, because one to the head reports "clear"
 * with a platform lying across the chest (ADR 0055).
 *
 * The spine, not the capsule's ends: the probe sphere's own radius covers the caps.
 */
const bodyProbes = (aim: Vec3): readonly Vec3[] => [
  vec3(aim.x, aim.y - AIM_RISE, aim.z),
  vec3(aim.x, aim.y - AIM_RISE - CHAR_HALF_HEIGHT, aim.z),
]

export interface OrbitCameraOptions {
  /** Overrides on top of `DEFAULT_CAMERA_PARAMS`. */
  params?: Partial<CameraParams>
  /** Starting pitch, radians above the eyeline. */
  pitch?: number
}

export const createOrbitCamera = (camera: THREE.PerspectiveCamera, opts: OrbitCameraOptions = {}): OrbitCamera => {
  const params: CameraParams = { ...DEFAULT_CAMERA_PARAMS, ...opts.params }

  let yaw = 0
  let pitch = opts.pitch ?? 0.35
  /** The orbit distance actually rendered: `camZoom` smoothed, so a notch glides instead of jumping. */
  let distance = params.camZoom
  /** The orbit distance the boom has room for, chasing the soft limit. `null` until the first frame. */
  let boomHad: number | null = null
  let yawPrev = 0
  let pitchPrev = pitch
  let yawRate = 0
  let pitchRate = 0
  let targetPrev: Vec3 = vec3(0, 1, 0)
  let targetVel: Vec3 = vec3()
  /** Landing strength, in units of a plain jump's landing speed. Eased back to 0 every frame. */
  let landImpact = 0
  let queries: OcclusionQueries | null = null

  const cutout = createCutoutMask({
    camera: vec3(),
    target: vec3(),
    radius: params.camMaskRadius,
    feather: params.camMaskFeather,
    strength: 0,
  })
  /** How far open the aperture is, 0 to 1, chased so it grows and shrinks rather than popping. */
  let maskOpen = 0
  /** The authored eye, while one is held. `null` is "orbit normally". */
  let shotEye: Vec3 | null = null
  /** 0 fully orbiting, 1 fully at `shotEye`. Eased, so both directions are a move rather than a cut. */
  let shotMix = 0
  /**
   * The surfaces the hole is cut in, held while the aperture closes. Handing the level view an empty list
   * the frame the obstruction clears would put its plain material back at once, which is the hole snapping
   * shut and `camMaskSmooth` being a lie.
   */
  let maskOccluders: readonly number[] = []

  const turn = (dYaw: number, dPitch: number): void => {
    yaw -= dYaw
    pitch = clamp(pitch + dPitch, params.pitchMinDeg * DEG, PITCH_MAX)
  }

  const occlude = (target: Vec3, boom: Vec3, len: number, probes?: readonly Vec3[], feetY?: number): Occlusion =>
    queries === null
      ? { limit: len, seeThrough: false, occluders: [] }
      : occlusionFor(queries, target, boom, len, {
          ...(probes === undefined ? {} : { probes }),
          ...(feetY === undefined ? {} : { feetY }),
        })

  return {
    params,
    cutout,
    yaw: () => yaw,
    probeRadius: PROBE_RADIUS,
    lookMouse: (dx, dy) => turn(dx * params.sensitivity, dy * params.sensitivity),
    lookTouch: (dx, dy) => turn(dx * params.touchSensitivity, dy * params.touchSensitivity),
    zoomNotch: (dir) => {
      // The step grows with the current distance, as Roblox's does, so the far end of the range is not
      // thirty notches away.
      if (dir === 0) return
      params.camZoom = clamp(
        params.camZoom + Math.sign(dir) * params.camZoomStep * (1 + params.camZoom * params.camZoomGrowth),
        params.camZoomMin,
        params.camZoomMax,
      )
    },
    zoomPinch: (px) => {
      params.camZoom = clamp(params.camZoom - px * params.pinchZoom, params.camZoomMin, params.camZoomMax)
    },
    shot: (eye) => {
      shotEye = eye
    },
    land: (impact) => {
      landImpact = Math.min(impact, params.landKickMax)
    },
    observe: (q) => {
      queries = q
    },
    update: (dt, body, setOccluders) => {
      // The lens, before anything is measured against it. Guarded because `updateProjectionMatrix` rebuilds
      // the projection, and this is a slider that moves on maybe one frame in a session.
      if (camera.fov !== params.fov) {
        camera.fov = params.fov
        camera.updateProjectionMatrix()
      }
      // The aim point, dipped by whatever is left of the last landing.
      landImpact = chase(landImpact, 0, dt, params.landKickRecovery)
      const target = vec3(body.x, body.y + AIM_RISE - landImpact * params.landKick, body.z)
      // Re-clamped every frame, because the range itself is tunable while playing.
      params.camZoom = clamp(params.camZoom, params.camZoomMin, params.camZoomMax)
      distance = chase(distance, params.camZoom, dt, params.camZoomSmooth)

      // Rates, for the lookahead probe below: how fast the mouse is turning the boom and how fast the
      // character is carrying it. Both are differenced per frame and smoothed — mouse deltas arrive in
      // bursts, and an unsmoothed rate makes the predicted boom jitter, which the soft limit then chases.
      if (dt > 0) {
        yawRate = chase(yawRate, (yaw - yawPrev) / dt, dt, RATE_HALFLIFE)
        pitchRate = chase(pitchRate, (pitch - pitchPrev) / dt, dt, RATE_HALFLIFE)
        targetVel = vec3(
          chase(targetVel.x, (target.x - targetPrev.x) / dt, dt, RATE_HALFLIFE),
          chase(targetVel.y, (target.y - targetPrev.y) / dt, dt, RATE_HALFLIFE),
          chase(targetVel.z, (target.z - targetPrev.z) / dt, dt, RATE_HALFLIFE),
        )
      }
      yawPrev = yaw
      pitchPrev = pitch
      targetPrev = target

      // The boom: where the camera would sit with the world empty. Everything below moves it along this
      // line, never off it, so what the probe cleared is where the camera lands.
      const boomX = Math.sin(yaw) * Math.cos(pitch) * distance
      const boomY = Math.sin(pitch) * distance + RISE
      const boomZ = Math.cos(yaw) * Math.cos(pitch) * distance
      const boom = Math.hypot(boomX, boomY, boomZ)
      // Anything the boom meets below the feet is floor: it stops the camera as it always did, rather than
      // being holed, because a hole in the floor is a view of the level's underside (ADR 0055). Always, not
      // only while grounded — falling and looking down puts the camera under the ground just the same.
      const feetY = body.y - (CHAR_HALF_HEIGHT + CHAR_RADIUS)
      // Hard limit: how far the boom has room for *now*. The camera is clamped to it unconditionally, and
      // that clamp is the whole no-clipping guarantee. `seeThrough` is the case where there *is* something
      // in the way but the camera may stay out and let the shader dither it.
      const live = occlude(target, vec3(boomX, boomY, boomZ), boom, bodyProbes(target), feetY)
      const hard = live.limit
      // Soft limit: the same probe, of the same radius, run where the boom *will* be `lookahead` from now —
      // the character has moved on and the mouse has kept turning. An obstruction about to cross the sight
      // line shows up there before it shows up here, which is the head start the ease needs to arrive
      // before the clamp has to bite. Widening the probe instead would also see it early, and would
      // collapse the camera every time a surface merely runs alongside the boom (ADR 0020).
      let soft = hard
      if (params.camLookahead > 0 && queries !== null) {
        const t = params.camLookahead
        const aheadYaw = yaw + yawRate * t
        const aheadPitch = clamp(pitch + pitchRate * t, params.pitchMinDeg * DEG, PITCH_MAX)
        const aheadBoom = vec3(
          Math.sin(aheadYaw) * Math.cos(aheadPitch) * distance,
          Math.sin(aheadPitch) * distance + RISE,
          Math.cos(aheadYaw) * Math.cos(aheadPitch) * distance,
        )
        const aheadTarget = vec3(target.x + targetVel.x * t, target.y + targetVel.y * t, target.z + targetVel.z * t)
        const aheadLen = Math.hypot(aheadBoom.x, aheadBoom.y, aheadBoom.z)
        soft = Math.min(hard, occlude(aheadTarget, aheadBoom, aheadLen).limit)
      }
      // Move toward the soft limit on a half-life — in on one, back out on another — then clamp to the hard
      // limit. `null` on the first frame only, where there is nothing to interpolate from.
      boomHad =
        boomHad === null
          ? soft
          : chase(boomHad, soft, dt, soft < boomHad ? params.camPushInSmooth : params.camReturnSmooth)
      const reach = Math.min(boomHad, hard) / boom
      // Where the orbit alone would put the eye, as an offset from the target.
      let offX = boomX * reach
      let offY = boomY * reach
      let offZ = boomZ * reach

      /**
       * An authored eye, blended in (`shot`). The blend is on the *offset*, so it is a move relative to the
       * character rather than through world space — which is what keeps a shot from lurching when the
       * character is running while it eases in.
       *
       * The pull-in above is simply overridden at full mix: the author placed this eye, and clamping it to
       * what a probe cleared would be second-guessing them.
       */
      shotMix = chase(shotMix, shotEye === null ? 0 : 1, dt, params.shotSmooth)
      if (shotEye !== null || shotMix > 0.001) {
        const wanted = shotEye ?? { x: target.x + offX, y: target.y + offY, z: target.z + offZ }
        offX += (wanted.x - target.x - offX) * shotMix
        offY += (wanted.y - target.y - offY) * shotMix
        offZ += (wanted.z - target.z - offZ) * shotMix
      }

      camera.position.set(target.x + offX, target.y + offY, target.z + offZ)
      // Orientation from the eye's *direction*, not from `lookAt`. A fully squeezed boom puts the camera
      // exactly on its target, and lookAt then has a zero-length direction to build a basis from: three
      // falls back to looking along world -Z, which is a fixed heading that ignores the mouse entirely.
      // The direction is known whatever the length is. YXZ order — yaw about Y, then pitch about X — is the
      // one that keeps the horizon level, and it stays defined at straight-up, where lookAt does not.
      //
      // Taken from the offset rather than from `yaw` and the raw boom: for a pure orbit the two are the same
      // angle (`reach` scales all three components, which atan2 divides out), and during a shot the offset is
      // the only one that is true.
      const flat = Math.hypot(offX, offZ)
      const eyeYaw = flat < 1e-6 && Math.abs(offY) < 1e-6 ? yaw : Math.atan2(offX, offZ)
      camera.rotation.set(-Math.atan2(offY, flat), eyeYaw, 0, 'YXZ')

      // Hand the orbit its state back continuously, so releasing a shot resumes from where the shot was
      // looking instead of snapping to wherever the mouse had wandered. A no-op at zero mix, where these are
      // already the values the offset came from.
      if (shotMix > 0.001) {
        yaw = eyeYaw
        pitch = clamp(Math.atan2(offY - RISE, flat), params.pitchMinDeg * DEG, PITCH_MAX)
      }

      /**
       * The see-through hole (ADR 0055). Driven from the *live* probe, not the lookahead one: the hole has
       * to agree with what is actually in frame, and it has its own ease. Written every frame because the
       * shape is tunable while playing, and the eye and the target move every frame anyway.
       *
       * The ease drives the **radius**, not the dither's strength. Ramping the strength puts the whole disc
       * through a stipple on the way in and on the way out, which is a lot of crawling noise across a wide
       * surface; growing the radius keeps the interior fully cut from the first frame, so stipple only ever
       * lives in the thin feather ring and the hole reads as an aperture opening around the character.
       */
      /**
       * While a shot is held the boom is not where the eye is, so `live` describes a sightline nobody is
       * looking down. One more query along the *actual* offset answers the question that matters. Only while
       * blending or held — an ordinary orbit pays nothing.
       */
      const seen =
        shotMix > 0.001 ? occlude(target, vec3(offX, offY, offZ), Math.hypot(offX, offY, offZ), bodyProbes(target), feetY) : live
      maskOpen = chase(maskOpen, seen.seeThrough ? 1 : 0, dt, params.camMaskSmooth)
      if (seen.seeThrough) maskOccluders = seen.occluders
      else if (maskOpen < 0.004) maskOccluders = [] // shut: hand the plain materials back
      setOccluders(maskOccluders)
      cutout.set({
        camera: vec3(camera.position.x, camera.position.y, camera.position.z),
        // The capsule's centre, *not* the aim point: that one is a metre higher, at the top of the head, so
        // the hole would be centred there and the feet would fall outside it. It also carries the landing
        // dip, which the hole has no business following.
        target: vec3(body.x, body.y, body.z),
        radius: params.camMaskRadius * maskOpen,
        feather: params.camMaskFeather,
        // Full strength whenever there is any hole at all: the aperture is the animation.
        strength: maskOpen > 0 ? 1 : 0,
      })

      /**
       * Whether the player's own rig is drawable, which only the placed camera can answer.
       *
       * The probe deliberately ignores the character's own body, so nothing stops a low ceiling squeezing
       * the camera into the head — a minimum boom length would instead push the camera *through* the
       * ceiling, trading your body for the whole world. So the body goes rather than the collision
       * (ADR 0020). Measured against the capsule, whose height and width the rig is built from, so it hides
       * only when the camera is genuinely inside the mesh and not on every close pass: distance from the
       * camera to the capsule's spine, less its radius.
       */
      const spineY = clamp(camera.position.y - body.y, -CHAR_HALF_HEIGHT, CHAR_HALF_HEIGHT)
      const gap =
        Math.hypot(camera.position.x - body.x, camera.position.y - body.y - spineY, camera.position.z - body.z) -
        CHAR_RADIUS
      return { rigVisible: gap >= params.camHideMargin }
    },
  }
}

import type { CameraPresence, FollowPresence, MotionPresence } from './collab'

/**
 * Following someone's view (ADR 0155, ADR 0184): your camera, your selection and your Motion preview copy
 * theirs until you move the camera, select something or press Motion yourself.
 *
 * Both sides are here, because a tab can be each at once. **Following**: say so to the room, then glide the
 * camera to every pose the leader sends, take what the leader holds as your selection, and run your Motion
 * preview as theirs runs. **Leading**: while anyone follows this tab, send its camera ~5 Hz, and only when it
 * moved, and its Motion preview when it starts or stops — nobody following, nothing sent. The server relays
 * these like any presence and keeps none; a selection needs nothing sent, since the room already has everyone's
 * holds (ADR 0158).
 *
 * 5 Hz is a few dozen bytes a message; the follower's glide (`FOLLOW_RATE`) is what keeps that from reading as
 * a camera stepping five times a second.
 */

/** A camera as the room sends it: where it is, what it orbits, and the isometric half-height (`null`: perspective). */
export type CameraPose = Omit<CameraPresence, 'kind'>

/** How often a leader looks whether its camera moved. */
export const FOLLOW_SEND_MS = 200
/** How fast a follower's camera closes on the last pose, per second: most of the way in one send interval. */
export const FOLLOW_RATE = 12

/** Anything under a millimetre is the same pose: rounding noise is not worth a message. */
const EPS = 1e-3

/** To the millimetre, as the nearest double to that decimal, so it prints short on the wire. */
const round = (n: number): number => Math.round(n * 1000) / 1000
const roundPose = (p: CameraPose): CameraPose => ({
  position: { x: round(p.position.x), y: round(p.position.y), z: round(p.position.z) },
  target: { x: round(p.target.x), y: round(p.target.y), z: round(p.target.z) },
  ortho: p.ortho === null ? null : round(p.ortho),
})

/** Whether two poses are worth a message apart. */
export const posesDiffer = (a: CameraPose, b: CameraPose): boolean => {
  if ((a.ortho === null) !== (b.ortho === null)) return true
  const far = (x: number, y: number): boolean => Math.abs(x - y) > EPS
  return (
    far(a.position.x, b.position.x) ||
    far(a.position.y, b.position.y) ||
    far(a.position.z, b.position.z) ||
    far(a.target.x, b.target.x) ||
    far(a.target.y, b.target.y) ||
    far(a.target.z, b.target.z) ||
    (a.ortho !== null && b.ortho !== null && far(a.ortho, b.ortho))
  )
}

/** `t` of the way from one pose to another. A change of projection is not blended: it lands. */
export const approach = (from: CameraPose, to: CameraPose, t: number): CameraPose => {
  if ((from.ortho === null) !== (to.ortho === null)) return to
  const mix = (a: number, b: number): number => a + (b - a) * t
  return {
    position: { x: mix(from.position.x, to.position.x), y: mix(from.position.y, to.position.y), z: mix(from.position.z, to.position.z) },
    target: { x: mix(from.target.x, to.target.x), y: mix(from.target.y, to.target.y), z: mix(from.target.z, to.target.z) },
    ortho: from.ortho === null || to.ortho === null ? to.ortho : mix(from.ortho, to.ortho),
  }
}

/** What following needs from the editor around it. */
export interface FollowHost {
  /** This tab's camera now. */
  pose: () => CameraPose
  /** Put this tab's camera at a pose; the frame's `controls.update()` aims it. */
  setPose: (pose: CameraPose) => void
  /** To everyone else in the room. */
  send: (data: CameraPresence | FollowPresence | MotionPresence) => void
  /** A play session owns the camera: nothing is followed or sent then. */
  playing: () => boolean
  /** Make what `leader` holds this tab's selection. */
  selectLike: (leader: string) => void
  /** A drag or a field edit is under way: the selection is not swapped out from under it, but taken after. */
  busy: () => boolean
  /** This tab's Motion clock while it runs, `null` stopped. */
  motion: () => number | null
  /** Run this tab's Motion preview from a clock, or stop it (`null`). */
  setMotion: (ms: number | null) => void
  /** Whom this tab follows changed: the pill, the frame and the icons redraw. */
  changed: () => void
}

export interface Follow {
  /** Whose camera this tab copies, by connection, or `null`. */
  leader: () => string | null
  start: (connId: string) => void
  /** Stop following. `tell` is false when the room is already gone, so there is nobody to tell. */
  stop: (tell?: boolean) => void
  /** A pose arrived. Only the leader's is taken. */
  onCamera: (from: string, pose: CameraPose) => void
  /** Someone's Motion preview started or stopped. Only the leader's is taken. */
  onMotion: (from: string, ms: number | null) => void
  /** What anyone in the room holds changed: a follower takes the leader's at the next frame. */
  holdsChanged: () => void
  /** This tab's own Motion preview started or stopped: its followers are told. */
  motionChanged: () => void
  /** Someone started or stopped following; `me` is this tab's connection. */
  onFollow: (from: string, leader: string | null, me: string | null) => void
  /** Who is in the room now: followers who left are forgotten, and a leader who left ends the follow. */
  prune: (present: ReadonlySet<string>) => void
  /** Once a frame, before the orbit controls update. */
  frame: (dt: number) => void
  /** How many follow this tab. */
  followers: () => number
  /** The room was left: no leader, no followers, nothing to tell anyone. */
  reset: () => void
  /**
   * This tab reconnected under a new connection id. The leader knew the old one, and drops it when it leaves,
   * so the follow is said again for the new one.
   */
  announce: () => void
}

export const createFollow = (host: FollowHost): Follow => {
  let leader: string | null = null
  /** The leader's last pose, which the camera glides to. `null` until the first arrives. */
  let goal: CameraPose | null = null
  /** The leader's holds are to be taken: at most once a frame, and not in the middle of a drag. */
  let reselect = false

  const followers = new Set<string>()
  let timer: ReturnType<typeof setInterval> | null = null
  /** What was last sent, so a still camera sends nothing. `null` makes the next tick send. */
  let sent: CameraPose | null = null

  const tick = (): void => {
    if (host.playing()) return
    const pose = roundPose(host.pose())
    if (sent !== null && !posesDiffer(pose, sent)) return
    sent = pose
    host.send({ kind: 'camera', ...pose })
  }
  const sendMotion = (): void => {
    if (followers.size === 0 || host.playing()) return
    host.send({ kind: 'motion', ms: host.motion() })
  }
  const lead = (): void => {
    if (followers.size > 0 && timer === null) timer = setInterval(tick, FOLLOW_SEND_MS)
    if (followers.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  const stop = (tell = true): void => {
    if (leader === null) return
    leader = null
    goal = null
    reselect = false
    if (tell) host.send({ kind: 'follow', leader: null })
    host.changed()
  }

  return {
    leader: () => leader,
    start: (connId) => {
      if (leader === connId) return
      leader = connId
      goal = null
      reselect = true
      host.send({ kind: 'follow', leader: connId })
      host.changed()
    },
    stop,
    onCamera: (from, pose) => {
      if (from === leader) goal = pose
    },
    onMotion: (from, ms) => {
      if (from !== leader || host.playing()) return
      host.setMotion(ms)
      // Passed on to whoever follows this tab, as its camera and its selection are.
      sendMotion()
    },
    holdsChanged: () => {
      if (leader !== null) reselect = true
    },
    motionChanged: sendMotion,
    onFollow: (from, to, me) => {
      if (to !== null && to === me) {
        followers.add(from)
        // A new follower has nothing to glide to until the camera moves, nor a Motion preview to match: send both now.
        sent = null
        lead()
        tick()
        sendMotion()
      } else if (followers.delete(from)) lead()
    },
    prune: (present) => {
      let dropped = false
      for (const id of followers) if (!present.has(id)) dropped = followers.delete(id) || dropped
      if (dropped) lead()
      if (leader !== null && !present.has(leader)) stop(false)
    },
    frame: (dt) => {
      if (leader === null) return
      if (host.playing()) {
        stop()
        return
      }
      if (reselect && !host.busy()) {
        reselect = false
        host.selectLike(leader)
      }
      if (goal === null) return
      host.setPose(approach(host.pose(), goal, 1 - Math.exp(-dt * FOLLOW_RATE)))
    },
    followers: () => followers.size,
    reset: () => {
      stop(false)
      followers.clear()
      sent = null
      lead()
    },
    announce: () => {
      if (leader !== null) host.send({ kind: 'follow', leader })
    },
  }
}

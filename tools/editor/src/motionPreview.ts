import { vec3 } from '@mp/core'
import { eulerToQuat } from '@mp/core'
import type { THREE } from '@mp/render-three'

import type { Doc, LocalPose } from './editorDoc'

/**
 * The preview clock: the level's movers and spinners running in the viewport, without entering play
 * (ADR 0103, ADR 0121).
 *
 * Deliberately not the game clock. It poses the level's motion and nothing else — no physics, no character,
 * no rules — and it runs freely rather than wrapping, because every mover derives its own cycle from its
 * speed, so there is no single length to wrap to (and level time in the game does not wrap either).
 *
 * Its own module for the three variables it owns: the clock, whether it is running, and the frame it last
 * advanced on. `applyPreviewPoses` is the load-bearing call and it is used well beyond the preview — a
 * structural rebuild, a remote transform batch, a face pull — because **an authored transform is only where a
 * still item sits**. Anything with a mover belongs at its pose for the current clock, which at zero is where
 * the game starts it, so the two agree.
 */

/** What posing the level needs from the editor around it. */
export interface MotionPreviewHost {
  doc: () => Doc | null
  groupAt: (i: number) => THREE.Group | undefined
  /** The Inspector's own fields show the clock, so scrubbing refreshes them. */
  inspectorSync: () => void
  renderStatus: () => void
  /** The toolbar's Motion button reads `playing`. */
  toolbarRender: () => void
}

export interface MotionPreview {
  /** Where the clock is, in milliseconds. */
  timeMs: () => number
  playing: () => boolean
  /** Run or stop it. Stopping snaps everything back to its authored transform. */
  setPlaying: (on: boolean) => void
  /** Scrub: poses the level, refreshes the Inspector and the status line. */
  setTime: (ms: number) => void
  /**
   * Move the clock without re-reading the Inspector.
   *
   * Narrower than `setTime` on purpose: sixty times a second the Inspector's fields cannot have changed, and
   * re-reading them every frame would fight anything being typed into one.
   */
  advance: (ms: number) => void
  /** Pose every item from its motion at the current clock. Still items sit at their authored transform. */
  applyPoses: () => void
  /**
   * Run `read` with every group at its **authored** transform, then put the preview poses back (ADR 0126).
   *
   * For anything that derives a stored value from the scene graph. The groups normally hold authored *plus*
   * whatever the movers contribute, so reading a world matrix and writing it back bakes the animation in —
   * permanently, in the file. Every other write path subtracts the offset (`motionOffsetAt`); a caller that
   * reads a composed matrix cannot, because the offset is in the old parent's frame and the value it is
   * computing is in the new one.
   */
  withAuthoredPoses: <T>(read: () => T) => T
  /** One item's offset from its authored transform at a given time — what an offset track is (ADR 0050). */
  offsetAt: (index: number, timeMs: number) => LocalPose
  /** Advance by wall-clock time. `false` when the clock is not running, so the caller does nothing. */
  frame: () => boolean
}

export const createMotionPreview = (host: MotionPreviewHost): MotionPreview => {
  let previewMs = 0
  let playing = false
  let lastFrame = 0

  const applyPoses = (): void => {
    const open = host.doc()
    if (open === null) return
    /**
     * **One pass, not one `poseOf` per node** (ADR 0125).
     *
     * This runs sixty times a second while the clock is on. `poseOf` per index cost four full document walks
     * per node — `nodes()` is recomputed per call by design, and `poseOf` reaches it twice itself and twice
     * more through `motionFrameOf`, which also climbs each node's ancestors separately. Quadratic on a level
     * of hundreds of platforms, which is why Motion dropped the frame rate while play mode did not: play
     * poses the instantiated frame tree, which is flat arrays.
     */
    const poses = open.posesAt(previewMs)
    for (let i = 0; i < poses.length; i += 1) {
      const g = host.groupAt(i)
      const pose = poses[i]
      if (g === undefined || pose === undefined) continue
      g.position.set(pose.position.x, pose.position.y, pose.position.z)
      const q = eulerToQuat(pose.rotation)
      g.quaternion.set(q.x, q.y, q.z, q.w)
      // Scale is not animated: a track that resized a collider would rebuild physics every tick.
    }
  }

  /**
   * Pose every group at the document's authored transform — no motion, whatever the clock says.
   *
   * Not the same as posing at time zero: a mover with a phase `offset` is partway along its travel at zero,
   * which is where the game starts it and therefore what the preview should draw. Authored is where the
   * document says the object *is*.
   */
  const applyAuthored = (): void => {
    const open = host.doc()
    if (open === null) return
    for (let i = 0; i < open.count(); i += 1) {
      const g = host.groupAt(i)
      if (g === undefined) continue
      const t = open.transformOf(i)
      g.position.set(t.position.x, t.position.y, t.position.z)
      const q = eulerToQuat(t.rotation ?? vec3(0, 0, 0))
      g.quaternion.set(q.x, q.y, q.z, q.w)
    }
  }

  const setTime = (ms: number): void => {
    previewMs = Math.max(0, ms)
    applyPoses()
    host.inspectorSync()
    host.renderStatus()
  }

  const advance = (ms: number): void => {
    previewMs = Math.max(0, ms)
    applyPoses()
  }

  return {
    timeMs: () => previewMs,
    playing: () => playing,
    setPlaying: (on) => {
      playing = on
      lastFrame = 0
      if (!on) setTime(0)
      host.toolbarRender()
      host.renderStatus()
    },
    setTime,
    advance,
    applyPoses,
    withAuthoredPoses: (read) => {
      applyAuthored()
      try {
        return read()
      } finally {
        // Back to the preview even if the caller threw, or the viewport would silently stop animating.
        applyPoses()
      }
    },
    offsetAt: (index, timeMs) => {
      const open = host.doc()
      if (open === null) return { position: vec3(0, 0, 0), rotation: vec3(0, 0, 0) }
      const authored = open.transformOf(index)
      const rest = authored.rotation ?? vec3(0, 0, 0)
      const at = open.poseOf(index, timeMs)
      return {
        position: vec3(at.position.x - authored.position.x, at.position.y - authored.position.y, at.position.z - authored.position.z),
        rotation: vec3(at.rotation.x - rest.x, at.rotation.y - rest.y, at.rotation.z - rest.z),
      }
    },
    frame: () => {
      if (!playing) return false
      const now = performance.now()
      const dt = lastFrame === 0 ? 0 : now - lastFrame
      lastFrame = now
      advance(previewMs + dt)
      return true
    },
  }
}

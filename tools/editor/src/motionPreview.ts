import { eulerToQuat, mulQuat, quat, vec3, type Quat, type Vec3 } from '@mp/core'
import type { THREE } from '@mp/render-three'

import type { Doc } from './editorDoc'

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

/**
 * What the preview adds to one item's authored transform, each in the way it goes in (ADR 0141): `position` and
 * `rotation` added (a mover's travel and a spinner's euler), `turn` multiplied on the right of the rotation and
 * `scale` multiplied in (a sequence's). What a write-back takes out, the same way.
 */
export interface PreviewOffset {
  readonly position: Vec3
  readonly rotation: Vec3
  readonly turn: Quat
  readonly scale: Vec3
}

/** The material copies a fadeable item was given (`itemMeshes.ts`), and the opacity each started at. */
export interface FadeCopy {
  readonly mat: { opacity: number }
  readonly base: number
}

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
  /** One item's offset from its authored transform at a given time, as the preview draws it (ADR 0141). */
  offsetAt: (index: number, timeMs: number) => PreviewOffset
  /** Advance by wall-clock time. `false` when the clock is not running, so the caller does nothing. */
  frame: () => boolean
}

const ratio = (a: number, b: number): number => (Math.abs(b) < 1e-9 ? 1 : a / b)

/** An item's fade copies, if it has any: they hang off its mesh holder. */
const fadeCopiesOf = (g: THREE.Group): { holder: THREE.Object3D; copies: readonly FadeCopy[] } | null => {
  const holder = g.userData.meshes as THREE.Object3D | undefined
  const copies = holder?.userData.fading as readonly FadeCopy[] | undefined
  return holder === undefined || copies === undefined || copies.length === 0 ? null : { holder, copies }
}

const setOpacity = (g: THREE.Group, opacity: number): void => {
  const fading = fadeCopiesOf(g)
  if (fading === null) return
  for (const c of fading.copies) c.mat.opacity = c.base * opacity
  // Faded all the way out it draws nothing, as in the game (ADR 0141).
  fading.holder.visible = opacity > 0
}

export const createMotionPreview = (host: MotionPreviewHost): MotionPreview => {
  let previewMs = 0
  let playing = false
  let lastFrame = 0

  /**
   * Sequences show only while the clock runs. Stopped, an object is as it was set up (ADR 0137): a platform
   * whose sequence starts it invisible stays visible and solid in the viewport, where it has to be clicked.
   */
  const sequencesShown = (): boolean => playing

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
    const poses = open.posesAt(previewMs, { sequences: sequencesShown() })
    for (let i = 0; i < poses.length; i += 1) {
      const g = host.groupAt(i)
      const pose = poses[i]
      if (g === undefined || pose === undefined) continue
      g.position.set(pose.position.x, pose.position.y, pose.position.z)
      const q = mulQuat(eulerToQuat(pose.rotation), pose.turn)
      g.quaternion.set(q.x, q.y, q.z, q.w)
      // A group's meshes are built at their world size inside a holder that undoes the scale they were built at,
      // so scaling the group stretches them — and everything under it — exactly as the game's `drawScale` does.
      g.scale.set(pose.scale.x, pose.scale.y, pose.scale.z)
      // Disabling takes the whole branch, which a hidden group does.
      g.visible = pose.shown
      setOpacity(g, pose.opacity)
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
      const s = t.scale ?? vec3(1, 1, 1)
      g.scale.set(s.x, s.y, s.z)
      g.visible = true
      setOpacity(g, 1)
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
      if (open === null) return { position: vec3(0, 0, 0), rotation: vec3(0, 0, 0), turn: quat(), scale: vec3(1, 1, 1) }
      const authored = open.transformOf(index)
      const rest = authored.rotation ?? vec3(0, 0, 0)
      const size = authored.scale ?? vec3(1, 1, 1)
      const at = open.poseOf(index, timeMs, { sequences: sequencesShown() })
      return {
        position: vec3(at.position.x - authored.position.x, at.position.y - authored.position.y, at.position.z - authored.position.z),
        rotation: vec3(at.rotation.x - rest.x, at.rotation.y - rest.y, at.rotation.z - rest.z),
        turn: at.turn,
        scale: vec3(ratio(at.scale.x, size.x), ratio(at.scale.y, size.y), ratio(at.scale.z, size.z)),
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

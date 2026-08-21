import type { Vec3 } from '@mp/core'

/**
 * What the camera does about something between it and the character (ADR 0055).
 *
 * ADR 0020's answer was one sphere cast and one rule: whatever the sweep cleared is where the camera goes.
 * That kept the character visible *and* kept the camera out of geometry, and it is the second job that
 * cannot be given up — a camera inside a wall puts its near plane in solid and shows you the backfaces of
 * the level, which is worse than any occlusion.
 *
 * The first job is the shader's now. So there is exactly one thing left to ask, and it is the second job:
 *
 * 1. Forward, each probe → camera: is anything in the way at all.
 * 2. Would the camera itself be inside solid. A cast cannot answer this — a sweep that starts penetrating
 *    and heads out of the overlap ignores it by design, so from inside a wall it reports clear air — which
 *    is why there is a separate overlap query for it.
 *
 * **Several probes, not one.** One sightline to the point the camera aims at is not the character: it aims
 * near the head, so a platform can sit across the whole body with the head clear above it and the cast
 * reports nothing in the way. Casting to a few points down the capsule is what most third-person cameras
 * do, and it is the cheap end of the options — frustum-corner casts (Roblox's Popper) sample a fan
 * spreading *away* from the character, so they cost more and still miss a narrow beam that falls between
 * the rays. They answer a different question: what is clipping the frame's edges (ADR 0020's known limit).
 *
 * Inside solid, the camera moves in as it always did. Otherwise it holds its distance and the obstruction
 * dithers, and **how thick that obstruction is does not enter into it**. There was a thickness test here,
 * on the theory that a hole through a large solid is a window into nothing; the case that killed it is the
 * ordinary one — standing under a wide platform with the camera clearly above it. The camera is in open
 * air, which query 2 has already proved, so there is nothing left for a thickness to protect against, and
 * gating on it only made the camera flip between moving and seeing through as the platform's chord along
 * the boom changed with the angle.
 *
 * Then, once it has decided to see through, forward again a few times to list **every** surface in the way,
 * because the shader masks the meshes named here and nothing else.
 */
export interface OcclusionQueries {
  /**
   * Sweep the camera probe and report what it hit and how far it got, or `undefined` if it cleared
   * `maxDistance`. `skip` is handles to ignore on top of whatever the caller always ignores — used to walk
   * past a surface already found and see what is behind it.
   */
  cast: (origin: Vec3, direction: Vec3, maxDistance: number, skip?: readonly number[]) => Hit | undefined
  /** Is the camera probe, placed here, inside solid geometry. */
  occupied: (point: Vec3) => boolean
}

export interface Hit {
  distance: number
  colliderHandle: number
}

/**
 * How many surfaces to list in total, across every probe. A bound on the pathological case rather than a
 * budget: each one costs a cast, and a hole through seven stacked slabs looks like a hole through six.
 * Shared across the probes, so it also caps the whole call's cast count.
 */
const MAX_OCCLUDERS = 6

export interface Occlusion {
  /** How far along the boom the camera may sit, in metres. */
  limit: number
  /** Keep the distance and dither the obstruction instead. */
  seeThrough: boolean
  /**
   * The colliders in the way, nearest first — **which surfaces** to mask, not merely that there are some.
   *
   * This is the difference between a hole in the thing in the way and a hole in whatever happens to lie in
   * a volume. Nothing about a fragment's position separates the platform overhead from the floor beside the
   * character's feet: from a high camera the floor is nearer to the eye than they are and right beside the
   * sight line. The sightline is the only thing that knows, and the sightline is this cast.
   *
   * Empty unless `seeThrough`.
   */
  occluders: readonly number[]
}

const CLEAR: Occlusion = { limit: 0, seeThrough: false, occluders: [] }

export interface OcclusionView {
  /** Other points on the character that have to be visible. `target` is always probed; these are extra. */
  probes?: readonly Vec3[]
  /**
   * The height of the character's feet. **The camera does not see through anything to get below it** — down
   * there it stops at whatever is in the way, exactly as ADR 0020 always made it stop.
   *
   * Nothing in a level says which collider is the ground, and nothing should: the ground is a platform. What
   * separates them is where the camera ends up. A hole in the thing under your feet is a view of the level's
   * underside, so the rule is about the camera's own height and not about the surface at all — not its
   * identity (the collider you happen to be standing on also holds you up from the side) and not its normal
   * (a platform's top face points up whether it is beneath you or over your head, which is the case the hole
   * exists for).
   *
   * Omitted means the camera may go anywhere.
   */
  feetY?: number
}

/**
 * `boom` is the offset from `target` to where the camera wants to be, and `len` its length — passed in
 * because every caller already has it.
 */
export const occlusionFor = (
  q: OcclusionQueries,
  target: Vec3,
  boom: Vec3,
  len: number,
  view: OcclusionView = {},
): Occlusion => {
  const camera = { x: target.x + boom.x, y: target.y + boom.y, z: target.z + boom.z }
  const occluders: number[] = []
  const skip: number[] = []

  // Every surface between a point and the camera, not only the first: two railings a hand's width apart
  // both sit over the character, and masking one leaves the other there. Excluding what is already found is
  // what walks the sweep past it.
  const walk = (from: Vec3, towards: Vec3, reach: number): void => {
    while (occluders.length < MAX_OCCLUDERS) {
      const hit = q.cast(from, towards, reach, skip)
      if (hit === undefined) break
      occluders.push(hit.colliderHandle)
      skip.push(hit.colliderHandle)
    }
  }

  // The boom first, and its own first hit kept: the camera slides along *this* line, so this is the only
  // clearance that means anything if it turns out it has to move after all.
  const main = q.cast(target, boom, len)
  /**
   * Below the feet nothing is see-through, so whatever is in the way stops the camera — the pull-in, kept
   * for the one case it is still the right answer to.
   *
   * Tested on the camera's own height rather than on the hit's, because a sphere sweep stops its **own
   * radius short** of what it meets: a hit on the floor at the character's feet reports a centre a quarter
   * of a metre above them, so a test on the hit never fires. Measured the hard way — the first version of
   * this read the hit and did nothing at all.
   */
  if (view.feetY !== undefined && camera.y < view.feetY) return { ...CLEAR, limit: main?.distance ?? len }
  if (main !== undefined) {
    occluders.push(main.colliderHandle)
    skip.push(main.colliderHandle)
    walk(target, boom, len)
  }

  for (const point of view.probes ?? []) {
    const towards = { x: camera.x - point.x, y: camera.y - point.y, z: camera.z - point.z }
    walk(point, towards, Math.hypot(towards.x, towards.y, towards.z))
  }

  if (occluders.length === 0) return { ...CLEAR, limit: len }
  if (q.occupied(camera)) return { ...CLEAR, limit: main?.distance ?? len }
  return { limit: len, seeThrough: true, occluders }
}


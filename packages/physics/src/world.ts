import RAPIER from '@dimforge/rapier3d-compat'
import { quat, vec3, type Quat, type Vec3 } from '@mp/core'

/**
 * Thin wrapper over Rapier3d (WASM, compat/SIMD build). 3D only (SEED §2).
 * Headless — runs in Node on the server and (later) in the browser for client
 * prediction, sharing one pinned Rapier version, timestep, and world config
 * (SEED §4). Not a dimension-agnostic 2D/3D surface.
 */

let ready = false

/** Load the Rapier WASM module. Idempotent; must complete before creating a world. */
export const initPhysics = async (): Promise<void> => {
  if (ready) return
  await RAPIER.init()
  ready = true
}

export type ShapeDesc =
  | { readonly kind: 'ball'; readonly radius: number }
  | { readonly kind: 'cuboid'; readonly halfExtents: Vec3 }
  | { readonly kind: 'capsule'; readonly halfHeight: number; readonly radius: number }
  /**
   * Convex polyhedron through `points` (its convex hull). For authored shapes a box cannot
   * represent — a segment swept along a curve has non-parallel end faces, so a chain of these
   * meets exactly where a chain of boxes leaves notches. Convex, so the character controller
   * depenetrates properly, unlike a trimesh which has no interior.
   */
  | { readonly kind: 'convex'; readonly points: readonly Vec3[] }

export interface BodyOptions {
  readonly position: Vec3
  readonly shape: ShapeDesc
  /** Initial orientation (unit quaternion). Omit for identity. Used for tilted colliders
   * (ramps) and the starting pose of a rotating body. */
  readonly rotation?: Quat
  readonly restitution?: number
  /** Linear velocity damping — higher makes a pushed body settle sooner. */
  readonly linearDamping?: number
}

export interface PhysicsBody {
  readonly handle: number
  /** Handle of this body's collider — matches the handles from `CharacterBody.collisions`. */
  readonly colliderHandle: number
  translation: () => Vec3
  /** Current orientation (unit quaternion). */
  rotation: () => Quat
  linvel: () => Vec3
  setLinvel: (v: Vec3) => void
  /** Move the body to `position` and zero its velocities (wakes it). */
  teleport: (position: Vec3) => void
  /** Move the body to `position` but keep its velocity — for reconciling a
   * predicted prop without killing its momentum (avoids a freeze/stutter). */
  setPosition: (position: Vec3) => void
  /** Set the orientation immediately (companion to `setPosition`). */
  setRotation: (rotation: Quat) => void
  /** Kinematic bodies only: set the target position for the next step (Rapier
   * moves it there and generates contacts, so it blocks/pushes dynamic bodies). */
  setNextKinematicTranslation: (position: Vec3) => void
  /** Kinematic bodies only: set the target orientation for the next step (spinning
   * obstacles — rotating bars). */
  setNextKinematicRotation: (rotation: Quat) => void
  /** Remove this body (and its colliders) from the world. */
  remove: () => void
}

type BodyKind = 'dynamic' | 'fixed' | 'kinematic'

export interface CharacterOptions {
  readonly position: Vec3
  readonly radius: number
  /** Half-height of the capsule's cylindrical section. */
  readonly halfHeight: number
  /** Gap the controller keeps between the capsule and its surroundings. Too small and the
   * capsule rests in penetration, from which the controller can resolve to no movement at all. */
  readonly offset?: number
  /** Distance below the feet the controller will stick to ground over; `false` disables. */
  readonly snapToGround?: number | false
  /** Ledge height the controller steps over automatically; `false` disables. */
  readonly autostep?: { maxHeight: number; minWidth: number } | false
}

/** The surface a capsule is resting on, found by casting straight down from it. */
export interface GroundContact {
  colliderHandle: number
  /** World-space point where the cast met the surface (under the capsule's centre). */
  point: Vec3
  /** World-space surface normal at that point. */
  normal: Vec3
}

/**
 * A kinematic-character-controller body (SEED §4-ready): crisp, non-bouncy
 * control that resolves against colliders (walls, steps, slopes). The caller owns
 * the vertical velocity / gravity / jump; `move` applies a desired translation
 * with collision and reports whether it ended grounded.
 */
export interface CharacterBody {
  translation: () => Vec3
  /** Reposition immediately (reconciliation restore). */
  setPosition: (position: Vec3) => void
  /** Apply a desired translation this step (collision-resolved); returns grounded plus the
   * translation the controller actually resolved to (`applied`), which differs from `desired`
   * wherever it was blocked, slid, snapped — or *added to*, e.g. by the surface underfoot
   * moving. Comparing the two is the only way to see what the controller did with a step. */
  move: (desired: Vec3) => { grounded: boolean; applied: Vec3 }
  /**
   * Cast straight down from the capsule's centre to find the surface it is standing on —
   * which collider, and where. Independent of `move`: the KCC only reports the contacts it
   * happened to resolve against (snap-to-ground and a resting capsule may report none), so
   * anything that must know its footing every tick — riding a moving platform — asks here.
   * `undefined` when nothing is within reach or the surface below is too steep to stand on.
   * Reaches slightly past the feet, so pair it with `move`'s `grounded` to mean *standing on*.
   */
  probeGround: () => GroundContact | undefined
  /** Collider handles the capsule actually collided with during the last `move` (walls,
   * ground, obstacles it pushed against). The basis for real contact-driven triggers —
   * match against `PhysicsBody.colliderHandle`. */
  collisions: () => number[]
  remove: () => void
}

export interface PhysicsWorldOptions {
  readonly gravity?: Vec3
}

export interface PhysicsWorld {
  addDynamicBody: (opts: BodyOptions) => PhysicsBody
  addFixedBody: (opts: BodyOptions) => PhysicsBody
  /** Kinematic (position-based) body — moved via `setNextKinematicTranslation`.
   * Used client-side to mirror server entities as collision obstacles. */
  addKinematicBody: (opts: BodyOptions) => PhysicsBody
  /** Kinematic character controller (capsule). */
  addCharacter: (opts: CharacterOptions) => CharacterBody
  /** Advance the simulation by one fixed step of `dtSeconds`. */
  step: (dtSeconds: number) => void
  /** Release the underlying WASM world. */
  free: () => void
}

// Steepest walkable incline. A surface at least this upright counts as floor; anything
// steeper is a wall, not something to stand on (or be carried by).
const MAX_SLOPE_CLIMB_RAD = (50 * Math.PI) / 180
const GROUND_NORMAL_MIN_Y = Math.cos(MAX_SLOPE_CLIMB_RAD)
// Fallback probe reach below the feet when snap-to-ground is disabled.
const GROUND_PROBE_FALLBACK = 0.05
// Default gap kept between the capsule and its surroundings.
const CHAR_OFFSET = 0.02
/**
 * Rapier's character controller intermittently resolves a perfectly valid step to nothing. With
 * the capsule resting at its offset above a flat surface, an identical request — same gap, same
 * floor normal, same desired translation — yields the full movement on most ticks and *exactly*
 * zero on a minority. Measured on a 4 m platform: 33 of 200 ticks, and worse the smaller the
 * collider. It is invisible on static ground (losing a step you did not need changes nothing) and
 * obvious on a moving platform, where the surface advances and the rider does not.
 *
 * Retrying once with the vertical nudged *away* from the surface recovers every one of those ticks
 * (0 of 200 at 3 and 9 m/s). Nudging by a smaller downward amount, or by zero, does not — the
 * start has to not be touching. This is not fabricated movement: the retry is a full collision
 * resolve, so a character genuinely blocked stays blocked, and the result is only taken when it
 * beats the first attempt.
 */
const CONTACT_NUDGE = 0.0005

const descFor = (shape: ShapeDesc): RAPIER.ColliderDesc => {
  switch (shape.kind) {
    case 'ball':
      return RAPIER.ColliderDesc.ball(shape.radius)
    case 'cuboid':
      return RAPIER.ColliderDesc.cuboid(shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z)
    case 'capsule':
      return RAPIER.ColliderDesc.capsule(shape.halfHeight, shape.radius)
    case 'convex': {
      const flat = new Float32Array(shape.points.length * 3)
      shape.points.forEach((p, i) => {
        flat[i * 3] = p.x
        flat[i * 3 + 1] = p.y
        flat[i * 3 + 2] = p.z
      })
      // Returns null when the points are degenerate (coplanar, coincident, fewer than four).
      const cd = RAPIER.ColliderDesc.convexHull(flat)
      if (cd === null) throw new Error(`convex collider: ${shape.points.length} points do not form a hull`)
      return cd
    }
  }
}

const makeCollider = (shape: ShapeDesc, restitution: number | undefined) => {
  let cd = descFor(shape)
  if (restitution !== undefined) cd = cd.setRestitution(restitution)
  return cd
}

export const createPhysicsWorld = (opts: PhysicsWorldOptions = {}): PhysicsWorld => {
  if (!ready) throw new Error('initPhysics() must resolve before createPhysicsWorld()')
  const world = new RAPIER.World(opts.gravity ?? { x: 0, y: -9.81, z: 0 })

  const bodyDescFor = (kind: BodyKind) => {
    if (kind === 'dynamic') return RAPIER.RigidBodyDesc.dynamic()
    if (kind === 'fixed') return RAPIER.RigidBodyDesc.fixed()
    return RAPIER.RigidBodyDesc.kinematicPositionBased()
  }

  const addBody = (o: BodyOptions, kind: BodyKind): PhysicsBody => {
    let desc = bodyDescFor(kind).setTranslation(o.position.x, o.position.y, o.position.z)
    if (o.rotation !== undefined) desc = desc.setRotation(o.rotation)
    if (o.linearDamping !== undefined) desc = desc.setLinearDamping(o.linearDamping)
    const body = world.createRigidBody(desc)
    const collider = world.createCollider(makeCollider(o.shape, o.restitution), body)
    return {
      handle: body.handle,
      colliderHandle: collider.handle,
      translation: () => {
        const t = body.translation()
        return vec3(t.x, t.y, t.z)
      },
      rotation: () => {
        const r = body.rotation()
        return quat(r.x, r.y, r.z, r.w)
      },
      linvel: () => {
        const v = body.linvel()
        return vec3(v.x, v.y, v.z)
      },
      setLinvel: (v) => body.setLinvel({ x: v.x, y: v.y, z: v.z }, true),
      teleport: (p) => {
        body.setTranslation({ x: p.x, y: p.y, z: p.z }, true)
        body.setLinvel({ x: 0, y: 0, z: 0 }, true)
        body.setAngvel({ x: 0, y: 0, z: 0 }, true)
      },
      setPosition: (p) => body.setTranslation({ x: p.x, y: p.y, z: p.z }, true),
      setRotation: (r) => body.setRotation({ x: r.x, y: r.y, z: r.z, w: r.w }, true),
      setNextKinematicTranslation: (p) => body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z }),
      setNextKinematicRotation: (r) => body.setNextKinematicRotation({ x: r.x, y: r.y, z: r.z, w: r.w }),
      remove: () => world.removeRigidBody(body),
    }
  }

  const addCharacter = (o: CharacterOptions): CharacterBody => {
    const controller = world.createCharacterController(o.offset ?? CHAR_OFFSET)
    const autostep = o.autostep ?? { maxHeight: 0.4, minWidth: 0.2 }
    if (autostep !== false) controller.enableAutostep(autostep.maxHeight, autostep.minWidth, true) // step over small ledges
    const snap = o.snapToGround ?? 0.4
    if (snap !== false) controller.enableSnapToGround(snap) // stick to the ground on slopes/steps
    controller.setMaxSlopeClimbAngle(MAX_SLOPE_CLIMB_RAD) // walk up inclines to ~50°
    controller.setMinSlopeSlideAngle((45 * Math.PI) / 180) // slide back down steeper ones
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(o.position.x, o.position.y, o.position.z),
    )
    const collider = world.createCollider(RAPIER.ColliderDesc.capsule(o.halfHeight, o.radius), body)
    const lastCollisions: number[] = []
    return {
      translation: () => {
        const t = body.translation()
        return vec3(t.x, t.y, t.z)
      },
      setPosition: (p) => {
        body.setTranslation({ x: p.x, y: p.y, z: p.z }, true)
        // Body→collider sync only happens inside world.step; sync now so a
        // computeColliderMovement right after a teleport (reconciliation replay)
        // doesn't run from the collider's stale position.
        collider.setTranslation({ x: p.x, y: p.y, z: p.z })
      },
      move: (desired) => {
        // `computedMovement` returns a view into WASM memory that the next call reuses — copy it.
        const resolve = (dy: number): Vec3 => {
          controller.computeColliderMovement(collider, { x: desired.x, y: dy, z: desired.z })
          const m = controller.computedMovement()
          return vec3(m.x, m.y, m.z)
        }

        // Is something actually in the way of where we asked to go? A contact whose outward normal
        // points back along our intended direction is an obstacle; the floor underfoot (normal up)
        // is not. This separates "the controller dropped the step" from "the step was blocked",
        // which otherwise look identical from the outside.
        const blockedAlong = (hx: number, hz: number): boolean => {
          const n = controller.numComputedCollisions()
          for (let i = 0; i < n; i++) {
            const hit = controller.computedCollision(i)
            if (hit !== null && hit.normal1.x * hx + hit.normal1.z * hz < -0.3) return true
          }
          return false
        }

        let c = resolve(desired.y)
        let grounded = controller.computedGrounded()
        const wantH = Math.hypot(desired.x, desired.z)
        // A whole step discarded while resting on a surface — see CONTACT_NUDGE. Gated on the
        // vertical being small (resting or walking, not falling), *not* on `computedGrounded`:
        // that flag goes false on exactly the ticks the step is dropped, so gating on it would skip
        // the retry precisely when it is needed. Skipped when genuinely blocked — otherwise the
        // upward nudge lets autostep climb the obstacle, e.g. walking up over another player.
        if (
          Math.abs(desired.y) < 0.15 &&
          wantH > 1e-6 &&
          Math.hypot(c.x, c.z) < wantH * 0.9 &&
          !blockedAlong(desired.x / wantH, desired.z / wantH)
        ) {
          const retry = resolve(CONTACT_NUDGE)
          if (Math.hypot(retry.x, retry.z) > Math.hypot(c.x, c.z)) {
            // Keep the nudge out of the result — it is there to un-stick the query, not to lift
            // the character, which over many ticks would float it off the surface.
            c = vec3(retry.x, Math.min(retry.y, 0), retry.z)
            grounded = controller.computedGrounded()
          }
        }

        const t = body.translation()
        body.setNextKinematicTranslation({ x: t.x + c.x, y: t.y + c.y, z: t.z + c.z })
        // Record what the capsule actually pushed against this step — the real contacts
        // that gameplay triggers key off (not a distance heuristic).
        lastCollisions.length = 0
        const n = controller.numComputedCollisions()
        for (let i = 0; i < n; i++) {
          const hit = controller.computedCollision(i)
          const h = hit?.collider?.handle
          if (h !== undefined && h !== null) lastCollisions.push(h)
        }
        return { grounded, applied: c }
      },
      probeGround: () => {
        const t = body.translation()
        // Reach below the feet is the snap-to-ground distance: the controller is willing to hold
        // the capsule to ground that far away, so ground that far away is its footing. It also has
        // to clear how far a surface can move in one tick — a platform descending at 3 m/s drops
        // 0.1 m per tick, so a tighter margin loses the floor underneath a moving platform and the
        // character bounce-falls after it.
        const reach = o.halfHeight + o.radius + (snap === false ? GROUND_PROBE_FALLBACK : snap)
        const hit = world.castRayAndGetNormal(
          new RAPIER.Ray({ x: t.x, y: t.y, z: t.z }, { x: 0, y: -1, z: 0 }),
          reach,
          true,
          undefined,
          undefined,
          collider, // never hit ourselves
        )
        if (hit === null || hit.normal.y < GROUND_NORMAL_MIN_Y) return undefined
        return {
          colliderHandle: hit.collider.handle,
          point: vec3(t.x, t.y - hit.timeOfImpact, t.z),
          normal: vec3(hit.normal.x, hit.normal.y, hit.normal.z),
        }
      },
      collisions: () => lastCollisions.slice(),
      remove: () => {
        world.removeRigidBody(body)
        world.removeCharacterController(controller)
      },
    }
  }

  return {
    addDynamicBody: (o) => addBody(o, 'dynamic'),
    addFixedBody: (o) => addBody(o, 'fixed'),
    addKinematicBody: (o) => addBody(o, 'kinematic'),
    addCharacter,
    step: (dtSeconds) => {
      world.timestep = dtSeconds
      world.step()
    },
    free: () => world.free(),
  }
}

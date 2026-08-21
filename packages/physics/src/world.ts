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

/**
 * Which layers a collider is *in*, and which layers it collides *with* — 16 bits each. Two colliders
 * interact only if each one's membership intersects the other's filter, so switching an interaction off
 * takes one side, not both. Omit for Rapier's default: in every layer, colliding with every layer.
 *
 * Prefer "everything except" over "only these" when writing a filter. A collider that lists the layers
 * it wants stops colliding with anything added later that forgot to claim one of them; a collider that
 * excludes the one layer it must ignore keeps working.
 */
export interface CollisionLayers {
  readonly belongsTo: number
  readonly collidesWith: number
}

export interface BodyOptions {
  readonly position: Vec3
  readonly shape: ShapeDesc
  /** Initial orientation (unit quaternion). Omit for identity. Used for tilted colliders
   * (ramps) and the starting pose of a rotating body. */
  readonly rotation?: Quat
  readonly restitution?: number
  /** Linear velocity damping — higher makes a pushed body settle sooner. */
  readonly linearDamping?: number
  readonly layers?: CollisionLayers
  /**
   * A **sensor**: detected on overlap, with no collision response at all (ADR 0054). Rapier's term for a
   * trigger volume.
   *
   * Deliberately invisible to everything that resolves movement. The character controller's
   * `computeColliderMovement` skips sensors, so one never pushes the capsule — which also means a sensor
   * never appears in `CharacterBody.collisions`, and `CharacterBody.overlaps` is how you find it.
   */
  readonly sensor?: boolean
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
  /** Angular velocity (rad/s about each world axis). Set at spawn so a ragdoll's parts tumble. */
  setAngvel: (v: Vec3) => void
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
  /**
   * Collision layers for the capsule. Unlike a dynamic body's, these also filter the controller's own
   * queries — `move` and `probeGround` — because Rapier's character controller does not read its
   * collider's layers for that, it takes them per call. So a capsule that ignores a layer is neither
   * blocked by it nor stands on it.
   */
  readonly layers?: CollisionLayers
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
  /** Handle of this capsule's collider — matches `PhysicsBody.colliderHandle` and the handles from
   * `collisions`. What a query casting *from* the character passes to `exclude` so it cannot hit itself. */
  readonly colliderHandle: number
  translation: () => Vec3
  /** Reposition immediately (reconciliation restore). */
  setPosition: (position: Vec3) => void
  /** Apply a desired translation this step (collision-resolved); returns grounded plus the
   * translation the controller actually resolved to (`applied`), which differs from `desired`
   * wherever it was blocked, slid, snapped — or *added to*, e.g. by the surface underfoot
   * moving. Comparing the two is the only way to see what the controller did with a step.
   *
   * `ceiling` is the vertical counterpart of `grounded`: the step asked to rise and something
   * overhead was in the way. Read off contact normals rather than by comparing `applied.y` to
   * `desired.y`, because autostep and snap-to-ground both move the capsule vertically on their
   * own and a shortfall alone cannot tell a roof from either of those. */
  move: (desired: Vec3) => { grounded: boolean; applied: Vec3; ceiling: boolean }
  /**
   * Cast straight down from the capsule's centre to find the surface it is standing on —
   * which collider, and where. Independent of `move`: the KCC only reports the contacts it
   * happened to resolve against (snap-to-ground and a resting capsule may report none), so
   * anything that must know its footing every tick — riding a moving platform — asks here.
   * `undefined` when nothing is within reach or the surface below is too steep to stand on.
   * Reaches slightly past the feet, so pair it with `move`'s `grounded` to mean *standing on*.
   *
   * `extraReach` (metres) lengthens the ray beyond the default snap distance. For a caller tracking a
   * surface that moves faster than the snap distance covers in one tick — a fast descending platform —
   * and which therefore knows how far that surface can have gone. Check the returned
   * `colliderHandle` against the one you expected: a longer ray can also reach a floor you are not
   * standing on, and reporting that as footing puts the character on ground a metre below its feet.
   */
  probeGround: (extraReach?: number) => GroundContact | undefined
  /** Collider handles the capsule actually collided with during the last `move` (walls,
   * ground, obstacles it pushed against). The basis for real contact-driven triggers —
   * match against `PhysicsBody.colliderHandle`. */
  collisions: () => number[]
  /**
   * Handles of the **sensors** the capsule is currently overlapping (ADR 0054) — trigger volumes, which by
   * definition do not resolve movement and so never appear in `collisions`.
   *
   * Disjoint from `collisions` by construction: that reports solids, this reports sensors. A caller that wants
   * every contact concatenates them.
   */
  overlaps: () => number[]
  remove: () => void
}

export interface PhysicsWorldOptions {
  readonly gravity?: Vec3
}

/** What a cast touched, and how far along it. */
export interface CastHit {
  /** Distance travelled from the origin before contact (m). 0 if it started already touching. */
  distance: number
  colliderHandle: number
}

export interface SphereCastOptions {
  readonly origin: Vec3
  /** Cast direction. Normalized internally, so any length will do. */
  readonly direction: Vec3
  /** Longest sweep considered (m). Beyond it the cast reports clear. */
  readonly maxDistance: number
  readonly radius: number
  /** Collider handles to ignore — what the caster considers part of itself. */
  readonly exclude?: readonly number[]
}

export interface PhysicsWorld {
  addDynamicBody: (opts: BodyOptions) => PhysicsBody
  addFixedBody: (opts: BodyOptions) => PhysicsBody
  /** Kinematic (position-based) body — moved via `setNextKinematicTranslation`.
   * Used client-side to mirror server entities as collision obstacles. */
  addKinematicBody: (opts: BodyOptions) => PhysicsBody
  /** Kinematic character controller (capsule). */
  addCharacter: (opts: CharacterOptions) => CharacterBody
  /**
   * Sweep a sphere from `origin` along `direction` and report the first collider it touches, or
   * `undefined` if it gets `maxDistance` clear. A sphere rather than a ray because the caller puts
   * something with volume where the result says — a camera stopped by a ray sits flush with the wall
   * and its near plane cuts through it, while a sphere leaves exactly its radius of clearance.
   * A sphere that starts overlapping something reports 0 only if it is heading further in; on a path
   * out of the overlap it ignores it and reports whatever it meets next.
   * Queries the world as it stands; no step needed.
   */
  castSphere: (opts: SphereCastOptions) => CastHit | undefined
  /** Advance the simulation by one fixed step of `dtSeconds`. */
  step: (dtSeconds: number) => void
  /** Release the underlying WASM world. */
  free: () => void
}

// Steepest walkable incline. A surface at least this upright counts as floor; anything
// steeper is a wall, not something to stand on (or be carried by).
const MAX_SLOPE_CLIMB_RAD = (50 * Math.PI) / 180
const GROUND_NORMAL_MIN_Y = Math.cos(MAX_SLOPE_CLIMB_RAD)
/**
 * A contact counts as a roof when the surface's outward face points down at least this steeply.
 * Anything shallower is a wall or a slope, and neither of those should stop a rise: a capsule
 * pressed against a wall on the way up is still going up.
 */
const CEILING_NORMAL_MAX_Y = -0.5
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

/** Rapier packs interaction groups into one u32: memberships in the high half, filter in the low half. */
const packLayers = (l: CollisionLayers): number => ((l.belongsTo & 0xffff) << 16) | (l.collidesWith & 0xffff)

const makeCollider = (shape: ShapeDesc, restitution: number | undefined, layers: CollisionLayers | undefined, sensor: boolean | undefined) => {
  let cd = descFor(shape)
  if (restitution !== undefined) cd = cd.setRestitution(restitution)
  if (layers !== undefined) cd = cd.setCollisionGroups(packLayers(layers))
  if (sensor === true) cd = cd.setSensor(true)
  return cd
}

export const createPhysicsWorld = (opts: PhysicsWorldOptions = {}): PhysicsWorld => {
  if (!ready) throw new Error('initPhysics() must resolve before createPhysicsWorld()')
  const world = new RAPIER.World(opts.gravity ?? { x: 0, y: -9.81, z: 0 })

  /**
   * Rapier's scene queries (ray and shape casts) read a spatial index that `step()` refreshes. Casting
   * between steps is fine — the render loop runs at up to 144 Hz over a 30 Hz sim — but a collider
   * created, removed or repositioned since the last step is simply not in that index, so the cast
   * reports geometry that has moved and misses geometry that has arrived. Refreshed on demand rather
   * than per cast: the refresh walks the collider set, and most frames change nothing.
   */
  let queriesStale = false
  const freshenQueries = (): void => {
    if (!queriesStale) return
    world.updateSceneQueries()
    queriesStale = false
  }

  // Reused by every character's `overlaps`, resized per call. Same reasoning as `castBall` below: the query
  // builds and frees its own raw WASM shape, so holding one JS wrapper costs nothing.
  const overlapCapsule = new RAPIER.Capsule(0.5, 0.5)

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
    const collider = world.createCollider(makeCollider(o.shape, o.restitution, o.layers, o.sensor), body)
    queriesStale = true
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
      setAngvel: (v) => body.setAngvel({ x: v.x, y: v.y, z: v.z }, true),
      teleport: (p) => {
        body.setTranslation({ x: p.x, y: p.y, z: p.z }, true)
        body.setLinvel({ x: 0, y: 0, z: 0 }, true)
        body.setAngvel({ x: 0, y: 0, z: 0 }, true)
        queriesStale = true
      },
      setPosition: (p) => {
        body.setTranslation({ x: p.x, y: p.y, z: p.z }, true)
        queriesStale = true
      },
      setRotation: (r) => {
        body.setRotation({ x: r.x, y: r.y, z: r.z, w: r.w }, true)
        queriesStale = true
      },
      setNextKinematicTranslation: (p) => body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z }),
      setNextKinematicRotation: (r) => body.setNextKinematicRotation({ x: r.x, y: r.y, z: r.z, w: r.w }),
      remove: () => {
        world.removeRigidBody(body)
        queriesStale = true
      },
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
    const collider = world.createCollider(
      makeCollider({ kind: 'capsule', halfHeight: o.halfHeight, radius: o.radius }, undefined, o.layers, undefined),
      body,
    )
    // The controller's queries take their groups per call rather than reading the collider's, so the
    // capsule's layers have to be handed to every one of them or `move` resolves against layers the
    // capsule cannot actually touch.
    const queryLayers = o.layers === undefined ? undefined : packLayers(o.layers)
    queriesStale = true
    const lastCollisions: number[] = []
    return {
      colliderHandle: collider.handle,
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
        queriesStale = true
      },
      move: (desired) => {
        // `computedMovement` returns a view into WASM memory that the next call reuses — copy it.
        const resolve = (dy: number): Vec3 => {
          // `EXCLUDE_SENSORS` is what makes a trigger a trigger (ADR 0054). Rapier's character controller
          // resolves against sensors like anything else unless told not to — measured, not assumed: without
          // this flag a sensor wall stopped the capsule at the same distance a solid one did.
          controller.computeColliderMovement(
            collider,
            { x: desired.x, y: dy, z: desired.z },
            RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
            queryLayers,
          )
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
        // that gameplay triggers key off (not a distance heuristic). The same pass answers whether
        // a rise was stopped from above, since that is the same contact list seen from another angle.
        lastCollisions.length = 0
        let ceiling = false
        const n = controller.numComputedCollisions()
        for (let i = 0; i < n; i++) {
          const hit = controller.computedCollision(i)
          const h = hit?.collider?.handle
          if (h !== undefined && h !== null) lastCollisions.push(h)
          // Only while rising: grazing an overhang on the way *down* is not a roof stopping us, and
          // reporting it as one would stop the fall.
          if (desired.y > 0 && hit !== null && hit.normal1.y < CEILING_NORMAL_MAX_Y) ceiling = true
        }
        return { grounded, applied: c, ceiling }
      },
      probeGround: (extraReach = 0) => {
        freshenQueries()
        const t = body.translation()
        // Reach below the feet is the snap-to-ground distance: the controller is willing to hold
        // the capsule to ground that far away, so ground that far away is its footing. It also has
        // to clear how far a surface can move in one tick — a platform descending at 3 m/s drops
        // 0.1 m per tick, so a tighter margin loses the floor underneath a moving platform and the
        // character bounce-falls after it.
        const reach = o.halfHeight + o.radius + (snap === false ? GROUND_PROBE_FALLBACK : snap) + extraReach
        const hit = world.castRayAndGetNormal(
          new RAPIER.Ray({ x: t.x, y: t.y, z: t.z }, { x: 0, y: -1, z: 0 }),
          reach,
          true,
          // A trigger is not a floor (ADR 0054). Without this a kill plane would read as footing, so you
          // would stand on the thing that is supposed to be empty space with a rule in it.
          RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
          queryLayers, // a layer the capsule cannot collide with is not footing either
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
      /**
       * The **sensors** the capsule is currently inside (ADR 0054).
       *
       * A separate pass because it has to be: sensors are skipped by `computeColliderMovement`, so they never
       * reach `lastCollisions`. That is the whole point of a trigger — it does not resolve movement — and it
       * means overlap has to be *asked for* rather than reported as a side effect of moving.
       *
       * An explicit shape query rather than Rapier's narrow-phase intersection pairs, for two reasons: it
       * needs no `step()` to have run since the capsule moved, and `EXCLUDE_SOLIDS` makes it return sensors
       * only, so a caller cannot accidentally re-handle a solid it already saw in `collisions`.
       */
      overlaps: () => {
        freshenQueries()
        const t = body.translation()
        const found: number[] = []
        overlapCapsule.radius = o.radius
        overlapCapsule.halfHeight = o.halfHeight
        world.intersectionsWithShape(
          t,
          body.rotation(),
          overlapCapsule,
          (c) => {
            found.push(c.handle)
            return true // keep going: standing in two triggers at once is ordinary
          },
          RAPIER.QueryFilterFlags.EXCLUDE_SOLIDS,
          queryLayers, // a layer the capsule cannot touch is not a trigger it can enter
          collider, // never ourselves
        )
        return found
      },
      remove: () => {
        world.removeRigidBody(body)
        world.removeCharacterController(controller)
        queriesStale = true
      },
    }
  }

  // Reused across calls: the only thing that varies is the radius, and `castShape` builds (and frees)
  // its own raw WASM shape per call, so holding one JS wrapper costs nothing.
  const castBall = new RAPIER.Ball(0.1)
  const NO_ROTATION = { x: 0, y: 0, z: 0, w: 1 }

  const castSphere = ({ origin, direction, maxDistance, radius, exclude }: SphereCastOptions): CastHit | undefined => {
    const len = Math.hypot(direction.x, direction.y, direction.z)
    if (len === 0 || maxDistance <= 0 || radius <= 0) return undefined
    freshenQueries()
    castBall.radius = radius
    const skip = exclude
    const hit = world.castShape(
      origin,
      NO_ROTATION,
      { x: direction.x / len, y: direction.y / len, z: direction.z / len },
      castBall,
      0, // contact at touching, no extra margin — the radius is the margin
      maxDistance,
      // `stopAtPenetration: false` — a sphere that starts already overlapping something, on a path that
      // takes it *out* of that overlap, ignores it and carries on. Otherwise every cast whose origin
      // grazes a surface reports 0 no matter which way it was heading: a camera under a low roof would
      // collapse onto the character even with its whole boom pointing down and away, clear of everything.
      // Heading *into* the thing it starts inside still reports 0.
      false,
      // A trigger does not block a camera either (ADR 0054): pulling the boom in for a volume you can walk
      // through would shove the view for no visible reason.
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      undefined,
      skip === undefined || skip.length === 0 ? undefined : (c) => !skip.includes(c.handle),
    )
    // `time_of_impact` is in units of the cast velocity, and that is a unit vector — so metres.
    return hit === null ? undefined : { distance: hit.time_of_impact, colliderHandle: hit.collider.handle }
  }

  return {
    addDynamicBody: (o) => addBody(o, 'dynamic'),
    addFixedBody: (o) => addBody(o, 'fixed'),
    addKinematicBody: (o) => addBody(o, 'kinematic'),
    addCharacter,
    castSphere,
    step: (dtSeconds) => {
      world.timestep = dtSeconds
      world.step()
      queriesStale = false // a step refreshes the query index itself
    },
    free: () => world.free(),
  }
}

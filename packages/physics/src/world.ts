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
  /** Apply a desired translation this step (collision-resolved); returns grounded. */
  move: (desired: Vec3) => { grounded: boolean }
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

const makeCollider = (shape: ShapeDesc, restitution: number | undefined) => {
  let cd =
    shape.kind === 'ball'
      ? RAPIER.ColliderDesc.ball(shape.radius)
      : shape.kind === 'cuboid'
        ? RAPIER.ColliderDesc.cuboid(shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z)
        : RAPIER.ColliderDesc.capsule(shape.halfHeight, shape.radius)
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
      setNextKinematicTranslation: (p) => body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z }),
      setNextKinematicRotation: (r) => body.setNextKinematicRotation({ x: r.x, y: r.y, z: r.z, w: r.w }),
      remove: () => world.removeRigidBody(body),
    }
  }

  const addCharacter = (o: CharacterOptions): CharacterBody => {
    const controller = world.createCharacterController(0.02)
    controller.enableAutostep(0.4, 0.2, true) // step over small ledges
    controller.enableSnapToGround(0.4) // stick to the ground on slopes/steps
    controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180) // walk up inclines to ~50°
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
        controller.computeColliderMovement(collider, { x: desired.x, y: desired.y, z: desired.z })
        const c = controller.computedMovement()
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
        return { grounded: controller.computedGrounded() }
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

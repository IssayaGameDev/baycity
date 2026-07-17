import RAPIER from '@dimforge/rapier3d-compat'
import { vec3, type Vec3 } from '@mp/core'

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

export interface BodyOptions {
  readonly position: Vec3
  readonly shape: ShapeDesc
  readonly restitution?: number
  /** Linear velocity damping — higher makes a pushed body settle sooner. */
  readonly linearDamping?: number
}

export interface PhysicsBody {
  readonly handle: number
  translation: () => Vec3
  linvel: () => Vec3
  setLinvel: (v: Vec3) => void
  /** Move the body to `position` and zero its velocities (wakes it). */
  teleport: (position: Vec3) => void
  /** Kinematic bodies only: set the target position for the next step (Rapier
   * moves it there and generates contacts, so it blocks/pushes dynamic bodies). */
  setNextKinematicTranslation: (position: Vec3) => void
  /** Remove this body (and its colliders) from the world. */
  remove: () => void
}

type BodyKind = 'dynamic' | 'fixed' | 'kinematic'

export interface PhysicsWorldOptions {
  readonly gravity?: Vec3
}

export interface PhysicsWorld {
  addDynamicBody: (opts: BodyOptions) => PhysicsBody
  addFixedBody: (opts: BodyOptions) => PhysicsBody
  /** Kinematic (position-based) body — moved via `setNextKinematicTranslation`.
   * Used client-side to mirror server entities as collision obstacles. */
  addKinematicBody: (opts: BodyOptions) => PhysicsBody
  /** Advance the simulation by one fixed step of `dtSeconds`. */
  step: (dtSeconds: number) => void
  /** Release the underlying WASM world. */
  free: () => void
}

const makeCollider = (shape: ShapeDesc, restitution: number | undefined) => {
  let cd =
    shape.kind === 'ball'
      ? RAPIER.ColliderDesc.ball(shape.radius)
      : RAPIER.ColliderDesc.cuboid(shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z)
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
    if (o.linearDamping !== undefined) desc = desc.setLinearDamping(o.linearDamping)
    const body = world.createRigidBody(desc)
    world.createCollider(makeCollider(o.shape, o.restitution), body)
    return {
      handle: body.handle,
      translation: () => {
        const t = body.translation()
        return vec3(t.x, t.y, t.z)
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
      setNextKinematicTranslation: (p) => body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z }),
      remove: () => world.removeRigidBody(body),
    }
  }

  return {
    addDynamicBody: (o) => addBody(o, 'dynamic'),
    addFixedBody: (o) => addBody(o, 'fixed'),
    addKinematicBody: (o) => addBody(o, 'kinematic'),
    step: (dtSeconds) => {
      world.timestep = dtSeconds
      world.step()
    },
    free: () => world.free(),
  }
}

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
}

export interface PhysicsBody {
  readonly handle: number
  translation: () => Vec3
  /** Move the body to `position` and zero its velocities (wakes it). */
  teleport: (position: Vec3) => void
}

export interface PhysicsWorldOptions {
  readonly gravity?: Vec3
}

export interface PhysicsWorld {
  addDynamicBody: (opts: BodyOptions) => PhysicsBody
  addFixedBody: (opts: BodyOptions) => PhysicsBody
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

  const addBody = (o: BodyOptions, dynamic: boolean): PhysicsBody => {
    const desc = (dynamic ? RAPIER.RigidBodyDesc.dynamic() : RAPIER.RigidBodyDesc.fixed()).setTranslation(
      o.position.x,
      o.position.y,
      o.position.z,
    )
    const body = world.createRigidBody(desc)
    world.createCollider(makeCollider(o.shape, o.restitution), body)
    return {
      handle: body.handle,
      translation: () => {
        const t = body.translation()
        return vec3(t.x, t.y, t.z)
      },
      teleport: (p) => {
        body.setTranslation({ x: p.x, y: p.y, z: p.z }, true)
        body.setLinvel({ x: 0, y: 0, z: 0 }, true)
        body.setAngvel({ x: 0, y: 0, z: 0 }, true)
      },
    }
  }

  return {
    addDynamicBody: (o) => addBody(o, true),
    addFixedBody: (o) => addBody(o, false),
    step: (dtSeconds) => {
      world.timestep = dtSeconds
      world.step()
    },
    free: () => world.free(),
  }
}

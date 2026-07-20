import { clamp, lerpVec3, type EntityId, type Vec3 } from '@mp/core'
import type { InputCommand } from '@mp/net'

/**
 * The local, client-authoritative simulation (ADR 0011). The client owns its own
 * entity: it advances the sim from input and its resulting position IS the truth
 * it reports — there is no server correction, so no reconciliation, no unacked
 * queue, no eased offsets. (Contrast the retired M4 predictor.) Generic over the
 * world so it's testable without physics.
 */
export interface LocalWorld {
  /** Apply the local input and advance the sim by one fixed step. */
  applyInput: (cmd: InputCommand) => void
  /** Current authoritative positions of the owned entities. */
  readState: () => Map<EntityId, Vec3>
}

export interface LocalControllerOptions {
  world: LocalWorld
  /** Sim tick rate (Hz) — used to render-interpolate between fixed steps. */
  tickRateHz: number
  now?: () => number
}

export interface LocalController {
  /** Advance the sim one step from a world-space move direction (+ optional jump). */
  step: (moveX: number, moveZ: number, jump?: boolean) => void
  /** Authoritative (latest-tick) positions — what to send to the server. */
  state: () => Map<EntityId, Vec3>
  /** Positions interpolated between the last two ticks, smooth at display rate. */
  renderPositions: () => Map<EntityId, Vec3>
}

// Per entity: the last two tick positions, lerped by the fraction of the way to
// the next tick. No correction offset — the local sim is never corrected.
interface Track {
  prev: Vec3
  curr: Vec3
}

const clone = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z })

export const createLocalController = (opts: LocalControllerOptions): LocalController => {
  const now = opts.now ?? (() => performance.now())
  const tickIntervalMs = 1000 / opts.tickRateHz
  const tracks = new Map<EntityId, Track>()
  let lastTickAt = now()

  const sync = (): void => {
    for (const [id, pos] of opts.world.readState()) {
      const track = tracks.get(id)
      if (track === undefined) tracks.set(id, { prev: clone(pos), curr: clone(pos) })
      else {
        track.prev = track.curr
        track.curr = clone(pos)
      }
    }
    lastTickAt = now()
  }
  sync() // seed tracks from the initial state

  return {
    step: (moveX, moveZ, jump = false) => {
      opts.world.applyInput({ moveX, moveZ, jump })
      sync()
    },
    state: () => opts.world.readState(),
    renderPositions: () => {
      const frac = clamp((now() - lastTickAt) / tickIntervalMs, 0, 1)
      const out = new Map<EntityId, Vec3>()
      for (const [id, track] of tracks) out.set(id, lerpVec3(track.prev, track.curr, frac))
      return out
    },
  }
}

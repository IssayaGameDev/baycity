import { clamp, lerpVec3, type EntityId, type Vec3 } from '@mp/core'
import type { InputCommand } from '@mp/net'

/**
 * The local simulation the predictor drives, over the SAME deterministic step as
 * the server (SEED §4). It predicts a set of entities — the local player and any
 * props "pulled into the prediction loop" (SEED §4). Generic here so the
 * predictor is testable without physics.
 */
export interface PredictedWorld<Aux = undefined> {
  /** Apply the local player's input and advance the sim by one fixed step. */
  applyInput: (cmd: InputCommand) => void
  /** Current positions of every predicted entity (player + predicted props). */
  readState: () => Map<EntityId, Vec3>
  /** Set predicted entities to authoritative positions (for reconciliation). */
  restore: (state: ReadonlyMap<EntityId, Vec3>) => void
  /**
   * Optional rollback of sim state that positions alone don't capture (velocities,
   * grounded flags, …). `saveAux` is called after every predicted input; on
   * reconcile, the aux saved at the acked tick is `restoreAux`d before the replay —
   * otherwise the replay re-integrates from the *latest* tick's state and the
   * prediction diverges (visible as jitter) whenever that state matters.
   */
  saveAux?: () => Aux
  restoreAux?: (aux: Aux) => void
}

export interface PredictorOptions<Aux = undefined> {
  world: PredictedWorld<Aux>
  /** Prediction/input tick rate (Hz) — used to render-interpolate between steps. */
  tickRateHz: number
  /**
   * How long a reconciliation correction is blended into the render position.
   * DESIGN slider (game feel); 100 ms provisional (Kodjo), tunable at runtime. See docs/netcode.md.
   */
  correctionSmoothingMs: number
  now?: () => number
}

export interface Predictor {
  /** Generate the next input from a movement direction (+ optional jump), predict
   * it locally, and return the command to send to the server. */
  predict: (moveX: number, moveZ: number, jump?: boolean) => InputCommand
  /** Apply authoritative positions + processed-input ack: drop acked inputs,
   * restore predicted entities, replay the rest, absorb each delta smoothly. */
  reconcile: (authoritative: ReadonlyMap<EntityId, Vec3>, lastProcessedSeq: number) => void
  /** Smoothed, render-interpolated positions of every predicted entity. */
  renderPositions: () => Map<EntityId, Vec3>
  /** Adjust the correction smoothing window at runtime (design tuning). */
  setCorrectionSmoothingMs: (ms: number) => void
  pendingInputs: () => number
}

// Per-entity: interpolate between the last two tick positions (prev -> curr) so
// motion is smooth at display rate, plus a decaying offset that eases in
// reconciliation corrections instead of snapping.
interface Track {
  prev: Vec3
  curr: Vec3
  offset: Vec3
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 }
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const clone = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z })

export const createPredictor = <Aux = undefined>(opts: PredictorOptions<Aux>): Predictor => {
  const now = opts.now ?? (() => performance.now())
  const tickIntervalMs = 1000 / opts.tickRateHz
  let smoothingMs = opts.correctionSmoothingMs
  const unacked: { cmd: InputCommand; aux: Aux | undefined }[] = []
  let seq = 0
  const tracks = new Map<EntityId, Track>()
  let lastTickAt = now()
  let lastFrame = now()
  // Aux at the last-acked tick — the replay's starting point (initially: pre-input state).
  let ackedAux: Aux | undefined = opts.world.saveAux?.()

  const seedTrack = (id: EntityId, pos: Vec3): Track => {
    const track: Track = { prev: clone(pos), curr: clone(pos), offset: clone(ZERO) }
    tracks.set(id, track)
    return track
  }
  for (const [id, pos] of opts.world.readState()) seedTrack(id, pos)

  return {
    predict: (moveX, moveZ, jump = false) => {
      const cmd: InputCommand = { seq: ++seq, moveX, moveZ, jump }
      opts.world.applyInput(cmd)
      for (const [id, pos] of opts.world.readState()) {
        const track = tracks.get(id)
        if (track === undefined) seedTrack(id, pos)
        else {
          track.prev = track.curr
          track.curr = clone(pos)
        }
      }
      lastTickAt = now()
      unacked.push({ cmd, aux: opts.world.saveAux?.() })
      return cmd
    },

    reconcile: (authoritative, lastProcessedSeq) => {
      const before = opts.world.readState()
      while (unacked.length > 0 && unacked[0]!.cmd.seq <= lastProcessedSeq) ackedAux = unacked.shift()!.aux
      if (opts.world.restoreAux !== undefined && ackedAux !== undefined) opts.world.restoreAux(ackedAux)
      opts.world.restore(authoritative)
      for (const p of unacked) {
        opts.world.applyInput(p.cmd)
        p.aux = opts.world.saveAux?.() // keep history on the corrected timeline
      }
      const after = opts.world.readState()
      for (const [id, aPos] of after) {
        const track = tracks.get(id)
        if (track === undefined) {
          seedTrack(id, aPos)
          continue
        }
        // Shift the render trajectory onto the corrected frame; hold the visual
        // position via the offset (which then decays) so the correction eases in.
        const corr = sub(aPos, before.get(id) ?? aPos)
        track.prev = add(track.prev, corr)
        track.curr = add(track.curr, corr)
        track.offset = sub(track.offset, corr)
      }
    },

    renderPositions: () => {
      const t = now()
      const dt = Math.max(0, t - lastFrame)
      lastFrame = t
      const decay = 1 - Math.exp(-dt / Math.max(1, smoothingMs))
      const frac = clamp((t - lastTickAt) / tickIntervalMs, 0, 1)
      const out = new Map<EntityId, Vec3>()
      for (const [id, track] of tracks) {
        track.offset = lerpVec3(track.offset, ZERO, decay)
        out.set(id, add(lerpVec3(track.prev, track.curr, frac), track.offset))
      }
      return out
    },

    setCorrectionSmoothingMs: (ms) => {
      smoothingMs = ms
    },

    pendingInputs: () => unacked.length,
  }
}

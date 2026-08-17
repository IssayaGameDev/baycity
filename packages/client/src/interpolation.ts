import { lerpVec3, type EntityId } from '@mp/core'
import type { Snapshot, SnapshotEntity } from '@mp/net'

/**
 * Pure interpolation. Given snapshots ordered ascending by `serverTimeMs` and a
 * target server time, produce each entity's interpolated position. Outside the
 * buffered range it holds the nearest endpoint (no extrapolation in M2).
 */
export const interpolateAt = (
  buffer: readonly Snapshot[],
  renderServerTimeMs: number,
): SnapshotEntity[] => {
  if (buffer.length === 0) return []

  const first = buffer[0]!
  if (buffer.length === 1 || renderServerTimeMs <= first.serverTimeMs) {
    return clone(first.entities)
  }

  const last = buffer[buffer.length - 1]!
  if (renderServerTimeMs >= last.serverTimeMs) {
    return clone(last.entities)
  }

  let a = first
  let b = last
  for (let i = 0; i < buffer.length - 1; i++) {
    const lo = buffer[i]!
    const hi = buffer[i + 1]!
    if (renderServerTimeMs >= lo.serverTimeMs && renderServerTimeMs <= hi.serverTimeMs) {
      a = lo
      b = hi
      break
    }
  }

  const span = b.serverTimeMs - a.serverTimeMs
  const t = span > 0 ? (renderServerTimeMs - a.serverTimeMs) / span : 0
  const bById = new Map<EntityId, SnapshotEntity>()
  for (const e of b.entities) bById.set(e.id, e)

  return a.entities.map((e) => {
    const target = bById.get(e.id)
    return {
      id: e.id,
      position: target ? lerpVec3(e.position, target.position, t) : { ...e.position },
      // Flags are discrete state, not a quantity: blending "grounded" with "airborne" is
      // meaningless. Take them from `a`, the newest sample at or before the render time, so a
      // state change lands on the tick it was reported rather than fading in ahead of it.
      flags: e.flags,
      // Facing is a quantity, but an angle: lerping it takes the wrong way round the circle half the
      // time, and the consumer smooths facing anyway (the animator's `yawHalfLife` exists for exactly
      // this). So it is taken from `a`, like the flags, and smoothed downstream.
      yaw: e.yaw,
      // Speed *is* an ordinary quantity, so it interpolates — which matters, because it drives stride
      // and swing amplitude. Stepped at the snapshot rate it would put a staircase in both.
      speed: target ? e.speed + (target.speed - e.speed) * t : e.speed,
    }
  })
}

const clone = (entities: readonly SnapshotEntity[]): SnapshotEntity[] =>
  entities.map((e) => ({ id: e.id, position: { ...e.position }, flags: e.flags, yaw: e.yaw, speed: e.speed }))

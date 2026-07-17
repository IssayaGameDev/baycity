import { lerpVec3, type EntityId, type Vec3 } from '@mp/core'

/**
 * Server-side history ring buffer of player positions for lag compensation
 * (SEED §3). Records a frame per tick and reconstructs positions at any past
 * time (interpolated), so hit claims can be tested against the state the shooter
 * actually saw.
 */
export interface RewindBuffer {
  record: (timeMs: number, positions: ReadonlyMap<EntityId, Vec3>) => void
  /** Player positions reconstructed at `timeMs` (clamped to the buffered range). */
  positionsAt: (timeMs: number) => Map<EntityId, Vec3>
  oldestMs: () => number
  newestMs: () => number
}

interface Frame {
  timeMs: number
  positions: Map<EntityId, Vec3>
}

export const createRewindBuffer = (maxAgeMs = 1000): RewindBuffer => {
  const frames: Frame[] = []
  return {
    record: (timeMs, positions) => {
      frames.push({ timeMs, positions: new Map(positions) })
      const cutoff = timeMs - maxAgeMs
      while (frames.length > 2 && frames[0]!.timeMs < cutoff) frames.shift()
    },
    positionsAt: (timeMs) => {
      if (frames.length === 0) return new Map()
      const first = frames[0]!
      if (timeMs <= first.timeMs) return new Map(first.positions)
      const last = frames[frames.length - 1]!
      if (timeMs >= last.timeMs) return new Map(last.positions)
      let a = first
      let b = last
      for (let i = 0; i < frames.length - 1; i++) {
        if (timeMs >= frames[i]!.timeMs && timeMs <= frames[i + 1]!.timeMs) {
          a = frames[i]!
          b = frames[i + 1]!
          break
        }
      }
      const span = b.timeMs - a.timeMs
      const t = span > 0 ? (timeMs - a.timeMs) / span : 0
      const out = new Map<EntityId, Vec3>()
      for (const [id, pa] of a.positions) {
        const pb = b.positions.get(id)
        out.set(id, pb ? lerpVec3(pa, pb, t) : pa)
      }
      return out
    },
    oldestMs: () => (frames.length > 0 ? frames[0]!.timeMs : 0),
    newestMs: () => (frames.length > 0 ? frames[frames.length - 1]!.timeMs : 0),
  }
}

/** Ray vs sphere; returns the near hit distance along `dir` (assumed unit) or null. */
export const raySphere = (origin: Vec3, dir: Vec3, center: Vec3, radius: number): number | null => {
  const lx = center.x - origin.x
  const ly = center.y - origin.y
  const lz = center.z - origin.z
  const tca = lx * dir.x + ly * dir.y + lz * dir.z
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca
  const r2 = radius * radius
  if (d2 > r2) return null
  const thc = Math.sqrt(r2 - d2)
  const t0 = tca - thc
  const t1 = tca + thc
  const t = t0 >= 0 ? t0 : t1
  return t >= 0 ? t : null
}

/** Ray-test a set of positions (spheres of `radius`), return the nearest hit id. */
export const hitScan = (
  positions: ReadonlyMap<EntityId, Vec3>,
  origin: Vec3,
  direction: Vec3,
  radius: number,
  excludeId: EntityId,
): EntityId | null => {
  const len = Math.hypot(direction.x, direction.y, direction.z) || 1
  const dir: Vec3 = { x: direction.x / len, y: direction.y / len, z: direction.z / len }
  let best: EntityId | null = null
  let bestT = Infinity
  for (const [id, pos] of positions) {
    if (id === excludeId) continue
    const t = raySphere(origin, dir, pos, radius)
    if (t !== null && t < bestT) {
      bestT = t
      best = id
    }
  }
  return best
}

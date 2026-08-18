import type { Level, LevelConfig } from './types'

/**
 * Lightweight runtime validation for level JSON — a safety net with clear errors when
 * hand-authoring, not exhaustive (TS types + a JSON schema catch most at author time).
 * Checks the load-bearing structure: config enum, instance transforms, that string prefab refs resolve,
 * and behavior tracks (ADR 0029 — the only part of the schema with enough shape to be malformed).
 * Content is authored by us, not untrusted input.
 */
export class LevelError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isVec3 = (v: unknown): boolean =>
  isObj(v) && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number'

const EASINGS = new Set(['linear', 'in', 'out', 'inOut', 'step'])
const LOOPS = new Set(['loop', 'pingPong', 'once'])

/**
 * Behaviors are checked now, and were not before, because a track is *structure* where `move` was three
 * numbers. A `keys` that is not an array, or a key whose `t` is a string, used to be impossible to write;
 * now it crashes the loader mid-instantiate. Reporting the path beats a stack trace from inside `poseAt`.
 *
 * Reached for pieces as well as instances — the only place this validator looks inside a prefab. Pieces are
 * otherwise unchecked (they are authored by the editor, and the types cover them), but a piece is where a
 * mover most often lives, so an unvalidated track there would defeat the point of validating one here.
 */
const checkBehavior = (b: unknown, at: string): void => {
  if (b === undefined) return
  if (!isObj(b)) throw new LevelError(`${at}: expected an object`)
  if (b.kind === 'static') return
  if (b.kind !== 'track') throw new LevelError(`${at}.kind: expected 'static' | 'track'`)
  if (!Array.isArray(b.keys)) throw new LevelError(`${at}.keys: expected an array of keyframes`)
  if (b.loop !== undefined && (typeof b.loop !== 'string' || !LOOPS.has(b.loop)))
    throw new LevelError(`${at}.loop: expected 'loop' | 'pingPong' | 'once'`)
  if (b.phaseMs !== undefined && (typeof b.phaseMs !== 'number' || !Number.isFinite(b.phaseMs)))
    throw new LevelError(`${at}.phaseMs: expected a finite number of milliseconds`)
  b.keys.forEach((k: unknown, n: number) => {
    const kAt = `${at}.keys[${n}]`
    if (!isObj(k)) throw new LevelError(`${kAt}: expected an object`)
    if (typeof k.t !== 'number' || !Number.isFinite(k.t)) throw new LevelError(`${kAt}.t: expected a finite time in ms`)
    if (k.position !== undefined && !isVec3(k.position)) throw new LevelError(`${kAt}.position: expected a Vec3`)
    if (k.rotation !== undefined && !isVec3(k.rotation)) throw new LevelError(`${kAt}.rotation: expected a Vec3 of euler radians`)
    if (k.easing !== undefined && (typeof k.easing !== 'string' || !EASINGS.has(k.easing)))
      throw new LevelError(`${kAt}.easing: expected 'linear' | 'in' | 'out' | 'inOut' | 'step'`)
  })
}

/** A prefab's pieces, only far enough to reach their behaviors. */
const checkPieces = (prefab: unknown, at: string): void => {
  if (!isObj(prefab) || !Array.isArray(prefab.pieces)) return
  prefab.pieces.forEach((piece: unknown, n: number) => {
    if (isObj(piece)) checkBehavior(piece.behavior, `${at}.pieces[${n}].behavior`)
  })
}

const validateConfig = (c: unknown): LevelConfig => {
  if (!isObj(c)) throw new LevelError('level.config: expected object')
  if (c.fallBehavior !== 'respawn-checkpoint' && c.fallBehavior !== 'physical-fall')
    throw new LevelError("level.config.fallBehavior: expected 'respawn-checkpoint' | 'physical-fall'")
  if (typeof c.fallY !== 'number') throw new LevelError('level.config.fallY: expected number')
  if (c.gravity !== undefined && typeof c.gravity !== 'number')
    throw new LevelError('level.config.gravity: expected number')
  return c as unknown as LevelConfig
}

export const validateLevel = (data: unknown): Level => {
  if (!isObj(data)) throw new LevelError('level: expected object')
  if (typeof data.id !== 'string') throw new LevelError('level.id: expected string')
  validateConfig(data.config)
  if (!Array.isArray(data.instances)) throw new LevelError('level.instances: expected array')

  const table = isObj(data.prefabs) ? data.prefabs : {}

  // Recursive, because instances nest to arbitrary depth. The path in the message is what makes a
  // failure findable in a file that is now a tree rather than a list.
  const checkInstance = (inst: unknown, at: string): void => {
    if (!isObj(inst)) throw new LevelError(`${at}: expected object`)
    const { prefab, transform } = inst
    if (typeof prefab !== 'string' && !isObj(prefab))
      throw new LevelError(`${at}.prefab: expected an id string or an inline prefab`)
    if (typeof prefab === 'string' && !(prefab in table))
      throw new LevelError(`${at}: prefab '${prefab}' is not in level.prefabs`)
    if (!isObj(transform) || !isVec3(transform.position))
      throw new LevelError(`${at}.transform.position: expected a Vec3`)
    if (transform.rotation !== undefined && !isVec3(transform.rotation))
      throw new LevelError(`${at}.transform.rotation: expected a Vec3`)
    if (transform.scale !== undefined && !isVec3(transform.scale))
      throw new LevelError(`${at}.transform.scale: expected a Vec3`)
    if (inst.material !== undefined && typeof inst.material !== 'string')
      throw new LevelError(`${at}.material: expected a material asset id (a per-instance override)`)
    if (inst.name !== undefined && typeof inst.name !== 'string')
      throw new LevelError(`${at}.name: expected a string (an author-facing label)`)
    checkBehavior(inst.behavior, `${at}.behavior`)
    checkPieces(typeof prefab === 'string' ? table[prefab] : prefab, at)
    if (inst.children !== undefined) {
      if (!Array.isArray(inst.children)) throw new LevelError(`${at}.children: expected an array of instances`)
      inst.children.forEach((child, n) => checkInstance(child, `${at}.children[${n}]`))
    }
  }

  data.instances.forEach((inst, n) => checkInstance(inst, `level.instances[${n}]`))
  return data as unknown as Level
}

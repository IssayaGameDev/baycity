import type { Level, LevelConfig } from './types'

/**
 * Lightweight runtime validation for level JSON — a safety net with clear errors when
 * hand-authoring, not exhaustive (TS types + a JSON schema catch most at author time).
 * Checks the load-bearing structure: config enum, instance transforms, and that string
 * prefab refs resolve. Content is authored by us, not untrusted input.
 */
export class LevelError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isVec3 = (v: unknown): boolean =>
  isObj(v) && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number'

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
    if (inst.style !== undefined && typeof inst.style !== 'string')
      throw new LevelError(`${at}.style: expected a string (a per-instance style override)`)
    if (inst.name !== undefined && typeof inst.name !== 'string')
      throw new LevelError(`${at}.name: expected a string (an author-facing label)`)
    if (inst.children !== undefined) {
      if (!Array.isArray(inst.children)) throw new LevelError(`${at}.children: expected an array of instances`)
      inst.children.forEach((child, n) => checkInstance(child, `${at}.children[${n}]`))
    }
  }

  data.instances.forEach((inst, n) => checkInstance(inst, `level.instances[${n}]`))
  return data as unknown as Level
}

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
  data.instances.forEach((inst, n) => {
    const at = `level.instances[${n}]`
    if (!isObj(inst)) throw new LevelError(`${at}: expected object`)
    const { prefab, transform } = inst
    if (typeof prefab !== 'string' && !isObj(prefab))
      throw new LevelError(`${at}.prefab: expected an id string or an inline prefab`)
    if (typeof prefab === 'string' && !(prefab in table))
      throw new LevelError(`${at}: prefab '${prefab}' is not in level.prefabs`)
    if (!isObj(transform) || !isVec3(transform.position))
      throw new LevelError(`${at}.transform.position: expected a Vec3`)
  })
  return data as unknown as Level
}

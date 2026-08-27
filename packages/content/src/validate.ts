import type { LevelConfig, Level } from './types'

/**
 * Runtime validation for a level.
 *
 * A safety net with clear errors when hand-authoring, not exhaustive: the TypeScript types catch most of it at
 * author time, and content is written by us rather than being untrusted input.
 *
 * Structure here; **parameters only when a registry is supplied**, because the declarations live in
 * `@mp/components` and this package must not depend on it. The game and the editor both pass one, so in
 * practice parameters are always checked; a bare structural pass is what a tool that only needs the tree gets.
 */

export class LevelError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const isVec3 = (v: unknown): boolean => isObj(v) && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number'

/**
 * The config block: which game the level is for (ADR 0052), and the environment.
 *
 * Nothing else. A game's rules are components on nodes, so there is no settings bag to check — see `ModeRef`.
 */
const validateConfig = (c: unknown): LevelConfig => {
  if (!isObj(c)) throw new LevelError('level.config: expected object')
  if (c.mode !== undefined) {
    if (!isObj(c.mode)) throw new LevelError('level.config.mode: expected object')
    if (typeof c.mode.name !== 'string' || c.mode.name === '') throw new LevelError('level.config.mode.name: expected a non-empty string')
  }
  if (c.environment !== undefined) validateEnvironment(c.environment)
  return c as unknown as LevelConfig
}

const HEX = /^#[0-9a-fA-F]{6}$/

/** Same rule the component layer's `color` kind applies, so a colour means one thing everywhere. */
const checkColor = (v: unknown, at: string): void => {
  if (typeof v !== 'string' || !HEX.test(v)) throw new LevelError(`${at}: expected an sRGB colour as #rrggbb`)
}

const checkNumbers = (o: Record<string, unknown>, keys: readonly string[], at: string): void => {
  for (const key of keys) {
    const v = o[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new LevelError(`${at}.${key}: expected a finite number`)
  }
}

/**
 * The environment block (ADR 0048): sun, ambient, sky, post-FX.
 *
 * Every part is optional, and so is the block. A level written before this existed, or one that only pins its
 * sun, still loads — the renderer fills the rest from its defaults. Present-but-malformed is the error case;
 * absent is not.
 */
const validateEnvironment = (e: unknown): void => {
  if (!isObj(e)) throw new LevelError('level.config.environment: expected object')

  if (e.sun !== undefined) {
    const at = 'level.config.environment.sun'
    if (!isObj(e.sun)) throw new LevelError(`${at}: expected object`)
    checkNumbers(e.sun, ['elevation', 'azimuth', 'intensity'], at)
    checkColor(e.sun.color, `${at}.color`)
    if (typeof e.sun.shadows !== 'boolean') throw new LevelError(`${at}.shadows: expected true or false`)
  }

  if (e.ambient !== undefined) {
    const at = 'level.config.environment.ambient'
    if (!isObj(e.ambient)) throw new LevelError(`${at}: expected object`)
    checkNumbers(e.ambient, ['intensity'], at)
  }

  if (e.sky !== undefined) {
    const at = 'level.config.environment.sky'
    if (!isObj(e.sky)) throw new LevelError(`${at}: expected object`)
    checkNumbers(e.sky, ['gradientBias', 'gain', 'glowSharpness', 'glowStrength', 'sunDiskIntensity'], at)
    for (const key of ['topColor', 'bottomColor', 'glowColor']) checkColor(e.sky[key], `${at}.${key}`)
  }

  if (e.postfx !== undefined) {
    const at = 'level.config.environment.postfx'
    if (!isObj(e.postfx)) throw new LevelError(`${at}: expected object`)
    for (const key of ['ao', 'bloom']) {
      if (typeof e.postfx[key] !== 'boolean') throw new LevelError(`${at}.${key}: expected true or false`)
    }
    checkNumbers(e.postfx, ['bloomStrength'], at)
  }
}

/** The capability this validator wants from a component registry. `Registry` satisfies it structurally. */
export interface ParamChecker {
  readonly checkParams: (type: string, raw: Record<string, unknown> | undefined, at: string) => void
}

const checkTransform = (t: unknown, at: string): void => {
  if (!isObj(t) || !isVec3(t.position)) throw new LevelError(`${at}.position: expected a Vec3`)
  if (t.rotation !== undefined && !isVec3(t.rotation)) throw new LevelError(`${at}.rotation: expected a Vec3`)
  if (t.scale !== undefined && !isVec3(t.scale)) throw new LevelError(`${at}.scale: expected a Vec3`)
}

const checkComponents = (value: unknown, at: string, checker: ParamChecker | undefined): void => {
  if (!Array.isArray(value)) throw new LevelError(`${at}: expected an array of components`)
  const seen = new Set<string>()
  value.forEach((c: unknown, n: number) => {
    const cAt = `${at}[${n}]`
    if (!isObj(c)) throw new LevelError(`${cAt}: expected an object`)
    if (typeof c.id !== 'string' || c.id === '') throw new LevelError(`${cAt}.id: expected a non-empty string`)
    if (typeof c.type !== 'string' || c.type === '') throw new LevelError(`${cAt}.type: expected a component type`)
    // Unique per node, because an override names a component by id within its node and nothing else
    // disambiguates two colliders.
    if (seen.has(c.id)) throw new LevelError(`${cAt}.id: '${c.id}' is used twice on this node`)
    seen.add(c.id)
    if (c.params !== undefined && !isObj(c.params)) throw new LevelError(`${cAt}.params: expected an object`)
    if (c.enabled !== undefined && typeof c.enabled !== 'boolean') throw new LevelError(`${cAt}.enabled: expected true or false`)
    checker?.checkParams(c.type, isObj(c.params) ? c.params : {}, `${cAt}.params`)
  })
}

const checkOverrides = (value: unknown, at: string, checker: ParamChecker | undefined): void => {
  if (value === undefined) return
  if (!isObj(value)) throw new LevelError(`${at}: expected an object keyed by node id`)
  for (const [id, o] of Object.entries(value)) {
    const oAt = `${at}['${id}']`
    if (!isObj(o)) throw new LevelError(`${oAt}: expected an object`)
    if (o.transform !== undefined) checkTransform(o.transform, `${oAt}.transform`)
    if (o.name !== undefined && typeof o.name !== 'string') throw new LevelError(`${oAt}.name: expected a string`)
    if (o.params !== undefined) {
      if (!isObj(o.params)) throw new LevelError(`${oAt}.params: expected an object keyed by component id`)
      for (const [cid, patch] of Object.entries(o.params))
        if (!isObj(patch)) throw new LevelError(`${oAt}.params['${cid}']: expected an object`)
    }
    if (o.enabled !== undefined) {
      if (!isObj(o.enabled)) throw new LevelError(`${oAt}.enabled: expected an object keyed by component id`)
      for (const [cid, on] of Object.entries(o.enabled))
        if (typeof on !== 'boolean') throw new LevelError(`${oAt}.enabled['${cid}']: expected true or false`)
    }
    if (o.added !== undefined) checkComponents(o.added, `${oAt}.added`, checker)
    if (o.removed !== undefined) {
      if (!Array.isArray(o.removed)) throw new LevelError(`${oAt}.removed: expected an array of component ids`)
      o.removed.forEach((cid: unknown, n: number) => {
        if (typeof cid !== 'string') throw new LevelError(`${oAt}.removed[${n}]: expected a component id`)
      })
    }
  }
  // Keys are node ids and are **not** checked against the referenced tree: an override for a node the
  // prefab no longer has is inert by design, which is what lets a prefab lose a node without every
  // placement that touched it failing to load (the rule ADR 0033 set for pieces).
}

export const validateLevel = (data: unknown, checker?: ParamChecker): Level => {
  if (!isObj(data)) throw new LevelError('level: expected object')
  if (typeof data.id !== 'string') throw new LevelError('level.id: expected string')
  validateConfig(data.config)
  if (!Array.isArray(data.nodes)) throw new LevelError('level.nodes: expected array')

  const table = isObj(data.prefabs) ? data.prefabs : {}

  /**
   * `insidePrefab` is what forbids prefab-in-prefab: a reference graph needs cycle detection that a tree
   * of plain nodes does not, and it stayed out under ADR 0023 for the same reason.
   */
  const checkNode = (node: unknown, at: string, ids: Set<string>, insidePrefab: boolean): void => {
    if (!isObj(node)) throw new LevelError(`${at}: expected object`)
    if (typeof node.id !== 'string' || node.id === '') throw new LevelError(`${at}.id: expected a non-empty string`)
    if (ids.has(node.id)) throw new LevelError(`${at}.id: '${node.id}' is used twice in this tree`)
    ids.add(node.id)
    if (node.name !== undefined && typeof node.name !== 'string') throw new LevelError(`${at}.name: expected a string`)
    checkTransform(node.transform, `${at}.transform`)
    checkComponents(node.components, `${at}.components`, checker)
    if (node.prefab !== undefined) {
      if (typeof node.prefab !== 'string') throw new LevelError(`${at}.prefab: expected a prefab table key`)
      if (insidePrefab) throw new LevelError(`${at}.prefab: a node inside a prefab cannot reference another prefab`)
      if (!(node.prefab in table)) throw new LevelError(`${at}: prefab '${node.prefab}' is not in level.prefabs`)
    }
    checkOverrides(node.overrides, `${at}.overrides`, checker)
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) throw new LevelError(`${at}.children: expected an array of nodes`)
      node.children.forEach((child, n) => checkNode(child, `${at}.children[${n}]`, ids, insidePrefab))
    }
  }

  for (const [key, root] of Object.entries(table)) checkNode(root, `level.prefabs['${key}']`, new Set(), true)
  const levelIds = new Set<string>()
  data.nodes.forEach((node, n) => checkNode(node, `level.nodes[${n}]`, levelIds, false))
  return data as unknown as Level
}

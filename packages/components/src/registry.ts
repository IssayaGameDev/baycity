import type { ComponentDef } from './define'
import { ComponentError, defaultsOf, readParams, type ParamDecls, type Params, type RawParams } from './params'

/** A definition with its parameter shape erased, which is what a lookup by string can return. */
export type AnyComponentDef = ComponentDef<ParamDecls>

/**
 * The set of component types this build knows about.
 *
 * One registry rather than a module-level mutable map: a test builds its own with two fake components and
 * cannot disturb the real one, and the editor and the game are handed the same value rather than trusting
 * import order to have populated a singleton.
 */
export interface Registry {
  readonly has: (type: string) => boolean
  readonly get: (type: string) => AnyComponentDef | undefined
  /** Every definition, in declaration order — the order the editor's add menu lists them. */
  readonly all: () => readonly AnyComponentDef[]
  /** Every declared parameter at its default. What a freshly added component holds. */
  readonly defaults: (type: string) => Params<ParamDecls>
  /** Throws unless `raw` matches the type's declaration. The seam `validateLevel` accepts (stage C1.2). */
  readonly checkParams: (type: string, raw: RawParams | undefined, at: string) => void
}

/**
 * Throws on a duplicate type, matching `createShortcuts` on a duplicate chord: a shadowed registration is
 * silent at runtime and shows up as a component whose fields are subtly the other one's.
 */
export const createRegistry = (defs: readonly AnyComponentDef[]): Registry => {
  const byType = new Map<string, AnyComponentDef>()
  for (const def of defs) {
    if (byType.has(def.type)) throw new ComponentError(`duplicate component type '${def.type}'`)
    byType.set(def.type, def)
  }
  const need = (type: string, at: string): AnyComponentDef => {
    const def = byType.get(type)
    if (def === undefined) throw new ComponentError(`${at}: unknown component type '${type}'`)
    return def
  }
  return {
    has: (type) => byType.has(type),
    get: (type) => byType.get(type),
    all: () => [...byType.values()],
    defaults: (type) => defaultsOf(need(type, 'defaults').params),
    checkParams: (type, raw, at) => {
      readParams(need(type, at).params, raw, at)
    },
  }
}

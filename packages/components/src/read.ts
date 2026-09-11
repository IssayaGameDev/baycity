import { firstOfType, type ComponentData } from '@mp/content'
import type { ComponentDef } from './define'
import type { Registry } from './registry'
import { readParams, type ParamDecls, type Params } from './params'

/**
 * Reading a component off a node, typed by its declaration.
 *
 * This is the payoff of declaring parameters: `componentOn(node.components, Bumper)?.power` is a `number`
 * with no cast and no second lookup, where the schema layer only knows it as `unknown`. A mode asks for the
 * components it understands and ignores the rest, which is what lets the loader stay ignorant of gameplay.
 */

/** Is this component present and enabled on the node? */
export const hasComponent = (components: readonly ComponentData[], def: ComponentDef): boolean =>
  firstOfType(components, def.type) !== undefined

/**
 * The first enabled component of this type, with its parameters completed from the declaration's defaults
 * and typed. `undefined` when the node does not have one.
 */
export const componentOn = <D extends ParamDecls>(components: readonly ComponentData[], def: ComponentDef<D>): Params<D> | undefined => {
  const c = firstOfType(components, def.type)
  return c === undefined ? undefined : readParams(def.params, c.params, def.type)
}

/**
 * Every asset id named by an `asset` parameter on any component of these nodes, optionally of one kind
 * (ADR 0082). What a loader has to fetch beyond the Renderers' models and materials: a pad's active material, a
 * door's open sound — anything a game's component points at. Empty strings are the "none" an asset parameter
 * defaults to and are skipped.
 */
export const assetParamIds = (
  nodes: readonly { readonly components: readonly ComponentData[] }[],
  registry: Registry,
  of?: 'material' | 'model' | 'animation',
): string[] => {
  const ids = new Set<string>()
  for (const node of nodes)
    for (const c of node.components) {
      const def = registry.get(c.type)
      if (def === undefined) continue
      for (const [key, spec] of Object.entries(def.params)) {
        if (spec.kind !== 'asset' || (of !== undefined && spec.of !== of)) continue
        const value = c.params?.[key]
        if (typeof value === 'string' && value !== '') ids.add(value)
      }
    }
  return [...ids]
}

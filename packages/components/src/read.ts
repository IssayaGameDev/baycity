import { firstOfType, type ComponentData } from '@mp/content'
import type { ComponentDef } from './define'
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

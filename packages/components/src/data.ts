import type { DataAsset } from '@mp/content'

import { defaultsOf, readParams, type ParamDecls, type Params } from './params'

/**
 * Data types (ADR 0181): Unity's ScriptableObject classes. A type declares the fields a data asset of it holds — the
 * parameter kinds a component declares, read and defaulted the same way — and its place in the Project window's
 * **New data** menu. A game declares its own (`ModeDescriptor.dataTypes`), and a data asset of one lives only in
 * that game's library: no other game has the code that reads it.
 *
 * A data asset has no scene around it, so a `nodeRef`, `componentRef` or `stages` field means nothing in one; the
 * editor does not draw them.
 */
export interface DataTypeDef<D extends ParamDecls = ParamDecls> {
  /** What a data asset names in its `type`. Capitalised like a component's. */
  readonly type: string
  /** What a person reads: `Keyboard Style`. Falls back to `type`. */
  readonly label?: string
  /** Its place in **New data** — Unity's `CreateAssetMenu` path, folders by `/`: `Keyboard/Keyboard Style`. Falls back to the label. */
  readonly menu?: string
  readonly fields: D
}

/** Declare a data type: the declaration, with its fields' literal types kept, as `defineComponent` does. */
export const defineDataType = <const D extends ParamDecls>(def: DataTypeDef<D>): DataTypeDef<D> => def

/** A new data asset of this type: every field at its default. What **New data** writes. */
export const newDataAsset = (def: DataTypeDef): DataAsset => ({ type: def.type, fields: { ...defaultsOf(def.fields) } })

/**
 * A data asset's fields, typed by its declaration: checked, and completed with the defaults of fields added since it
 * was written. `undefined` for none or another type; throws on a value its field does not take.
 */
export const readData = <D extends ParamDecls>(def: DataTypeDef<D>, asset: DataAsset | undefined, at: string): Params<D> | undefined =>
  asset === undefined || asset.type !== def.type ? undefined : readParams(def.fields, asset.fields, at)

/** Its folders and name in **New data**: the menu path split, or the label alone. */
export const dataMenuPath = (def: DataTypeDef): string[] => (def.menu ?? def.label ?? def.type).split('/').map((s) => s.trim()).filter((s) => s !== '')

import type { Node, NodeOverride } from './types'

/**
 * The one walk, and the one list of what a placement can record (ADR 0151).
 *
 * A level's nodes are not only `children`: a placement keeps the children it adds under a piece in that
 * piece's override record (ADR 0135), and those are ordinary nodes of the level. About ten walkers each wrote
 * their own descent over `children` and most of them missed these — hydration, id re-minting, reference
 * counting, holds. Everything that visits nodes goes through here instead.
 *
 * Imports types only, like `eases.ts`: the editor's `vite.config.ts` reaches this through `ops.ts` by relative
 * path, under plain Node (`tools/editor/src/viteConfigImports.test.ts`).
 */

/** Every list of nodes hanging off `n`: its own `children`, then what each of its records adds, keyed by piece. */
export const childListsOf = (n: Node): Node[][] => {
  const out: Node[][] = []
  if (n.children !== undefined) out.push(n.children)
  for (const over of Object.values(n.overrides ?? {})) if (over.addedChildren !== undefined) out.push(over.addedChildren)
  return out
}

/** Every node of a forest, depth-first, added children included. */
export const forEachNode = (roots: readonly Node[], visit: (n: Node) => void): void => {
  const walk = (n: Node): void => {
    visit(n)
    for (const kids of childListsOf(n)) for (const kid of kids) walk(kid)
  }
  for (const r of roots) walk(r)
}

/** The ids of a node and everything under it, added children included. */
export const idsUnder = (n: Node): string[] => {
  const out: string[] = []
  forEachNode([n], (x) => out.push(x.id))
  return out
}

/** The ids of every node a placement added under its pieces, and everything under those. */
export const addedIdsOf = (placement: Node): Set<string> => {
  const out = new Set<string>()
  for (const over of Object.values(placement.overrides ?? {})) for (const kid of over.addedChildren ?? []) for (const id of idsUnder(kid)) out.add(id)
  return out
}

/**
 * Every field a `NodeOverride` can carry, and what "nothing" is for it. **The list, once**: it is written as a
 * `Record` over the type's keys, so a field added to `NodeOverride` and not here does not compile — which is
 * how the seven hand-written copies of this list drifted apart.
 *
 * - `value` — absent is nothing; any value is something, `''` and `false` included.
 * - `map` — absent or `{}`.
 * - `list` — absent or `[]`.
 */
export const OVERRIDE_FIELDS = {
  transform: 'value',
  name: 'value',
  params: 'map',
  added: 'list',
  removed: 'list',
  enabled: 'map',
  nodeEnabled: 'value',
  removedNodes: 'list',
  addedChildren: 'list',
  childOrder: 'list',
  sequences: 'map',
} as const satisfies Record<keyof NodeOverride, 'value' | 'map' | 'list'>

export type OverrideField = keyof typeof OVERRIDE_FIELDS

export const OVERRIDE_FIELD_NAMES = Object.keys(OVERRIDE_FIELDS) as OverrideField[]

/** Whether this field of the record says nothing. */
export const overrideFieldEmpty = (over: NodeOverride, field: OverrideField): boolean => {
  const v = over[field]
  if (v === undefined) return true
  switch (OVERRIDE_FIELDS[field]) {
    case 'value':
      return false
    case 'map':
      return Object.keys(v as object).length === 0
    case 'list':
      return (v as readonly unknown[]).length === 0
  }
}

/** The fields of this record that say something. */
export const overrideFieldsSet = (over: NodeOverride | undefined): OverrideField[] =>
  over === undefined ? [] : OVERRIDE_FIELD_NAMES.filter((f) => !overrideFieldEmpty(over, f))

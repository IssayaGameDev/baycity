/**
 * A reference into a prefab placement (ADR 0219): the placement's id, `/`, then the id of the node inside it — the id
 * its prefab gave it, which every placement of that prefab shares, so the placement is what tells two apart. Unity
 * names the object in the instance; a level here names the placement, then the piece.
 *
 * What a `nodeRef` holds, and a `componentRef`'s `node`. A plain id — no `/` — is a node in the reference's own scope
 * or the level's, as before; the ids the editor mints never hold one.
 */

export const REF_PATH_SEPARATOR = '/'

/** The reference to node `node` inside placement `placement`. */
export const refInto = (placement: string, node: string): string => `${placement}${REF_PATH_SEPARATOR}${node}`

/** The placement and the node a reference into one names, or `null` for a plain id. */
export const refPathOf = (id: string): { readonly placement: string; readonly node: string } | null => {
  const at = id.indexOf(REF_PATH_SEPARATOR)
  return at <= 0 || at === id.length - 1 ? null : { placement: id.slice(0, at), node: id.slice(at + 1) }
}

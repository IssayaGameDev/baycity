import { mayUse, type AssetDatabase, type AssetKind } from '@mp/content'

/**
 * Why asset `id` cannot fill a reference field that takes `of`, in a document of `user`'s — a game's name, or `null`
 * for Shared (ADR 0161) — or `null` when it can (ADR 0176). The rule the fields' pickers already list by, said as a
 * reason for a drop.
 */
export const assetRefusal = (db: AssetDatabase | null, of: AssetKind, id: string, user: string | null): string | null => {
  const entry = db?.byId[id]
  if (entry === undefined) return 'not in the project'
  if (entry.kind !== of) return `this takes a ${of}, not a ${entry.kind}`
  if (!mayUse(user, entry.path)) return user === null ? `${entry.name} is a game's own, and this is Shared` : `${entry.name} belongs to another game`
  return null
}

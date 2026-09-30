import type { AnyComponentDef } from '@mp/components'

/**
 * The Add Component menu's folders (ADR 0178): Unity's `AddComponentMenu` path. A component declares its folder
 * (`ComponentDef.menu`); a game's own goes in a folder named after its game. The Inspector's Add Component and the
 * Hierarchy's Add Component submenu both group by this.
 */

/** The built-in folders, in the order they show. A game's folder, and anything else, follows by name. */
export const MENU_FOLDERS: readonly string[] = ['Physics', 'Rendering', 'Gameplay', 'Animation']

/** A component's folder: what it declares, else its game's, else `Other`. */
export const menuFolderOf = (def: AnyComponentDef | undefined, gameLabel: string | null): string => def?.menu ?? gameLabel ?? 'Other'

/** Entries grouped by folder: the built-in folders first in their order, then the rest by name; each keeps its order. */
export const byMenuFolder = <T>(entries: readonly T[], folderOf: (entry: T) => string): { folder: string; entries: T[] }[] => {
  const groups = new Map<string, T[]>()
  for (const e of entries) {
    const f = folderOf(e)
    const list = groups.get(f) ?? []
    list.push(e)
    groups.set(f, list)
  }
  const rank = (f: string): number => {
    const i = MENU_FOLDERS.indexOf(f)
    return i < 0 ? MENU_FOLDERS.length : i
  }
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([folder, list]) => ({ folder, entries: list }))
}

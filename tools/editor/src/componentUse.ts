import { libraryOf, type Node } from '@mp/content'

import { componentTypesInRaw } from './editorDoc'

/**
 * Where a game still uses a component type (ADR 0175): what taking a shared component out of the game is refused
 * on. Without it the game cannot load a level that has one, and the editor would adopt it straight back the next
 * time that level opened.
 *
 * - **Levels**, each with the prefabs placed in it — the server's listing (`/api/levels`), which counts what is
 *   open in a room, so a friend's placement a moment ago is in it. A level it could not read is listed apart: it
 *   may have one.
 * - **The game's own prefabs**, placed or not, so none of them is left holding a component its game lacks. Shared
 *   prefabs belong to no game; one placed in a level is counted with that level.
 */
export interface ComponentUse {
  levels: string[]
  prefabs: string[]
  unreadable: string[]
}

export const componentUse = (
  type: string,
  game: string,
  levels: readonly { readonly name: string; readonly mode?: string; readonly components?: readonly string[] }[],
  prefabs: readonly { readonly name: string; readonly path: string; readonly root: Node | undefined }[],
): ComponentUse => {
  const use: ComponentUse = { levels: [], prefabs: [], unreadable: [] }
  for (const level of levels) {
    if (level.mode !== game) continue
    const bare = level.name.slice(level.name.indexOf('/') + 1)
    if (level.components === undefined) use.unreadable.push(bare)
    else if (level.components.includes(type)) use.levels.push(bare)
  }
  for (const prefab of prefabs) {
    if (libraryOf(prefab.path) !== game || prefab.root === undefined) continue
    if (componentTypesInRaw({ nodes: [prefab.root] }).includes(type)) use.prefabs.push(prefab.name)
  }
  return use
}

/** A few names, and how many more. */
const some = (names: readonly string[]): string =>
  names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`

/** Why `label` cannot leave the game, or `null` when nothing of the game uses it. */
export const removalRefusal = (label: string, use: ComponentUse): string | null => {
  const where = [
    ...(use.levels.length > 0 ? [`level${use.levels.length === 1 ? '' : 's'} ${some(use.levels)}`] : []),
    ...(use.prefabs.length > 0 ? [`prefab${use.prefabs.length === 1 ? '' : 's'} ${some(use.prefabs)}`] : []),
  ]
  if (where.length > 0) return `${label} is still used in ${where.join(' and ')}: take it off those objects first`
  if (use.unreadable.length > 0) return `${some(use.unreadable)} could not be read, so ${label} may still be in it`
  return null
}

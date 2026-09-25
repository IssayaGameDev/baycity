import { inLibrary, libraryDir, libraryOf, type AssetDatabase, type AssetEntry, type AssetKind } from '@mp/content'

/**
 * The folder structure behind the asset database, derived from paths.
 *
 * Folders are not stored anywhere: an entry's `path` *is* its location, so the tree is a projection of the
 * database rather than a second source of truth that could disagree with it. The one thing paths cannot
 * express is an **empty folder**, which has no files to imply it, so those are carried alongside (the dev
 * server lists real directories).
 *
 * Everything here is pure, which is the point: what a folder contains, what a filter leaves visible, and
 * whether a move is legal are the parts worth being sure about.
 *
 * Paths are relative to `content/` and start with their library (ADR 0161), so a tree is one **library's**:
 * `root` is that library's folder — `assets` for the shared one — and nothing outside it is drawn.
 */

/** The shared library's folder. */
export const SHARED = libraryDir(null)

/** The folder of the library a path is in: `SHARED`, or a game's own (`keyboard/assets`). */
export const libraryRootOf = (path: string): string => libraryDir(libraryOf(path) ?? null)

/** A library as the panel names it: `assets` for the shared one, `keyboard assets` for a game's own. */
export const libraryLabel = (root: string): string => {
  const game = libraryOf(root)
  return game === null || game === undefined ? 'assets' : `${game} assets`
}

/** A folder as the panel names it, inside its library: `materials`, not `assets/materials`; `''` at the top. */
export const shownFolder = (folder: string): string => {
  const root = libraryRootOf(folder)
  return folder === root ? '' : folder.startsWith(`${root}/`) ? folder.slice(root.length + 1) : folder
}
export interface TreeNode {
  /** Folder path from `content/`, forward-slashed; the library's own folder at the root. */
  path: string
  /** Last segment; the library's name (`assets`, or the game's) at the root. */
  name: string
  depth: number
  children: TreeNode[]
  /** Assets directly in this folder, not counting subfolders. */
  fileCount: number
}

/** Directory part of a path: for an asset, the folder it is in — its library's own at the top. */
export const folderOf = (path: string): string => {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

/** Whether `path` is `root` or inside it. */
const within = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`)

/** Every ancestor of a folder down from `root`, root first, excluding the folder itself; none outside `root`. */
export const ancestorsOf = (folder: string, root: string = SHARED): string[] => {
  if (folder === root || !within(folder, root)) return []
  const rest = folder.slice(root.length + 1).split('/')
  const out: string[] = [root]
  for (let i = 1; i < rest.length; i++) out.push(`${root}/${rest.slice(0, i).join('/')}`)
  return out
}

/**
 * Build one library's folder tree, `root` its folder. `extraFolders` are directories that exist on disk with
 * nothing in them — created but not yet filled — which no path could imply; any outside `root` are left out.
 */
export const buildTree = (db: AssetDatabase, extraFolders: readonly string[] = [], root: string = SHARED): TreeNode => {
  const fileCounts = new Map<string, number>()
  const known = new Set<string>([root])

  const noteFolder = (folder: string): void => {
    known.add(folder)
    for (const a of ancestorsOf(folder, root)) known.add(a)
  }

  for (const entry of db.entries) {
    const folder = folderOf(entry.path)
    if (!within(folder, root)) continue
    noteFolder(folder)
    fileCounts.set(folder, (fileCounts.get(folder) ?? 0) + 1)
  }
  for (const folder of extraFolders) if (folder !== root && within(folder, root)) noteFolder(folder)

  const rootDepth = root.split('/').length
  const nodeFor = (path: string): TreeNode => ({
    path,
    name: path === root ? libraryLabel(root) : path.slice(path.lastIndexOf('/') + 1),
    depth: path.split('/').length - rootDepth,
    children: [],
    fileCount: fileCounts.get(path) ?? 0,
  })

  const nodes = new Map<string, TreeNode>()
  for (const path of known) nodes.set(path, nodeFor(path))
  for (const [path, node] of nodes) {
    if (path === root) continue
    nodes.get(folderOf(path))?.children.push(node)
  }
  for (const node of nodes.values()) node.children.sort((a, b) => a.name.localeCompare(b.name))
  return nodes.get(root)!
}

/** Depth-first, parents before children — the order a tree panel draws rows in. */
export const flattenTree = (root: TreeNode, collapsed: ReadonlySet<string>): TreeNode[] => {
  const out: TreeNode[] = []
  const walk = (node: TreeNode): void => {
    out.push(node)
    if (collapsed.has(node.path)) return
    for (const child of node.children) walk(child)
  }
  walk(root)
  return out
}

export interface Filter {
  /** The library to look in, by its folder (`SHARED`, or a game's). */
  library: string
  /** Folder to show. `null` means every folder of the library. */
  folder: string | null
  /** Kind to show. `null` means every kind. */
  kind: AssetKind | null
  /** Case-insensitive substring of the name. */
  search: string
  /** Include assets in subfolders of `folder`. */
  recursive: boolean
}

/**
 * Entries a filter leaves visible, name-sorted.
 *
 * A folder and a kind are independent axes on purpose: "textures in this folder" and "every material
 * anywhere" are both things an author asks for, and making the kind a tab (as this panel first did) can only
 * answer the second.
 */
export const filterEntries = (db: AssetDatabase, filter: Filter): AssetEntry[] => {
  const needle = filter.search.trim().toLowerCase()
  return db.entries
    .filter((e) => {
      if (filter.kind !== null && e.kind !== filter.kind) return false
      if (needle !== '' && !e.name.toLowerCase().includes(needle)) return false
      const folder = folderOf(e.path)
      if (!within(folder, filter.library)) return false
      if (filter.folder === null) return true
      return filter.recursive ? folder === filter.folder || folder.startsWith(`${filter.folder}/`) : folder === filter.folder
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Immediate subfolders of `folder`, for showing them as tiles beside the files. */
export const subfoldersOf = (root: TreeNode, folder: string): TreeNode[] => {
  const find = (node: TreeNode): TreeNode | undefined => {
    if (node.path === folder) return node
    for (const child of node.children) {
      const hit = find(child)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  return find(root)?.children ?? []
}

/**
 * Whether a folder may be moved into `into`. A folder cannot go inside itself or its own descendants — the
 * path would be unresolvable and the move would delete the subtree on the way.
 */
export const canMoveFolder = (folder: string, into: string): boolean => {
  if (!inLibrary(folder)) return false // a library's own folder is not a thing you can move
  if (into === folder) return false
  if (into.startsWith(`${folder}/`)) return false
  return folderOf(folder) !== into // already there
}

/** Path a file or folder gets when moved into `into`, keeping its own name. */
export const movedInto = (path: string, into: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return into === '' ? name : `${into}/${name}`
}

/** Path a file or folder gets when renamed in place. */
export const renamedTo = (path: string, name: string): string => {
  const folder = folderOf(path)
  return folder === '' ? name : `${folder}/${name}`
}

/** One game as the games window lists it (ADR 0162): its name, its label, and the levels in its folder. */
export interface GameRow {
  name: string
  label: string
  /** Qualified `<game>/<name>`, as everything outside the folder calls a level (ADR 0108). */
  levels: { qualified: string; name: string }[]
}

/**
 * Group levels under their games, games in label order and levels with `default` first.
 *
 * `default` leads because it is the level the game boots into with no `?level=` — the one you reach for — and
 * every game may now own one (ADR 0108). A game with no levels is still a row: it is where the first one gets
 * made, and hiding it would make a new game unreachable.
 */
export const gameRows = (
  games: readonly { name: string; label: string }[],
  levels: readonly { name: string; mode?: string }[],
): GameRow[] => {
  const byGame = new Map<string, { qualified: string; name: string }[]>()
  for (const g of games) byGame.set(g.name, [])
  for (const level of levels) {
    const slash = level.name.indexOf('/')
    const game = level.mode ?? (slash > 0 ? level.name.slice(0, slash) : undefined)
    if (game === undefined) continue
    const short = slash > 0 ? level.name.slice(slash + 1) : level.name
    const list = byGame.get(game)
    if (list === undefined) continue // a level whose game this build does not have; the tree cannot place it
    list.push({ qualified: level.name, name: short })
  }
  return [...games]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((g) => ({
      ...g,
      levels: (byGame.get(g.name) ?? []).sort((a, b) => {
        if (a.name === 'default') return -1
        if (b.name === 'default') return 1
        return a.name.localeCompare(b.name)
      }),
    }))
}

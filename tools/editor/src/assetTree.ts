import type { AssetDatabase, AssetEntry, AssetKind } from '@mp/content'

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
 */
export interface TreeNode {
  /** Folder path, forward-slashed, `''` for the root. */
  path: string
  /** Last segment, or `'assets'` at the root. */
  name: string
  depth: number
  children: TreeNode[]
  /** Assets directly in this folder, not counting subfolders. */
  fileCount: number
}

/** Directory part of an asset path, `''` when it sits at the root. */
export const folderOf = (path: string): string => {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

/** Every ancestor of a folder, root first, excluding the folder itself. */
export const ancestorsOf = (folder: string): string[] => {
  if (folder === '') return []
  const parts = folder.split('/')
  const out: string[] = ['']
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'))
  return out
}

/**
 * Build the folder tree. `extraFolders` are directories that exist on disk with nothing in them — created
 * but not yet filled — which no path could imply.
 */
export const buildTree = (db: AssetDatabase, extraFolders: readonly string[] = []): TreeNode => {
  const fileCounts = new Map<string, number>()
  const known = new Set<string>([''])

  const noteFolder = (folder: string): void => {
    known.add(folder)
    for (const a of ancestorsOf(folder)) known.add(a)
  }

  for (const entry of db.entries) {
    const folder = folderOf(entry.path)
    noteFolder(folder)
    fileCounts.set(folder, (fileCounts.get(folder) ?? 0) + 1)
  }
  for (const folder of extraFolders) if (folder !== '') noteFolder(folder)

  const nodeFor = (path: string): TreeNode => ({
    path,
    name: path === '' ? 'assets' : path.slice(path.lastIndexOf('/') + 1),
    depth: path === '' ? 0 : path.split('/').length,
    children: [],
    fileCount: fileCounts.get(path) ?? 0,
  })

  const nodes = new Map<string, TreeNode>()
  for (const path of known) nodes.set(path, nodeFor(path))
  for (const [path, node] of nodes) {
    if (path === '') continue
    nodes.get(folderOf(path))?.children.push(node)
  }
  for (const node of nodes.values()) node.children.sort((a, b) => a.name.localeCompare(b.name))
  return nodes.get('')!
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
  /** Folder to show. `null` means every folder. */
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
      if (filter.folder === null) return true
      const folder = folderOf(e.path)
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
  if (folder === '') return false // the root is not a thing you can move
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

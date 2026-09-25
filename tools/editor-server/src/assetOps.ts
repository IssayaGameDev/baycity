import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, normalize, relative, sep } from 'node:path'

import { META_SUFFIX } from '../../../packages/content/src/assets'

/**
 * Filesystem operations behind the Project explorer: make a folder, move or rename, delete.
 *
 * **A move carries the sidecar with the file.** That is the whole reason ids exist: rename `crate.glb` and
 * every reference to it must survive, which it only does if `crate.glb.meta` goes along. Losing that one
 * detail would quietly turn the id scheme back into paths.
 *
 * Every path is resolved against the root and refused if it escapes — this is reachable over HTTP from a dev
 * server, and it deletes things. The root is `content/`; that a path is inside an asset library, and not a level,
 * is the API's check (ADR 0161).
 */
export class AssetOpError extends Error {}

/** Resolve `rel` inside `root`, or throw. `..` would otherwise reach any file on the machine. */
const resolve = (root: string, rel: string): string => {
  const full = normalize(join(root, rel))
  const contained = full === root || full.startsWith(root + sep)
  if (!contained) throw new AssetOpError(`path escapes the content root: ${rel}`)
  return full
}

const toRelative = (root: string, full: string): string => relative(root, full).split('\\').join('/')

/** Every folder under the root, relative and forward-slashed — including the empty ones. */
export const listFolders = (root: string): string[] => {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (!statSync(full).isDirectory()) continue
      out.push(toRelative(root, full))
      walk(full)
    }
  }
  walk(root)
  return out.sort()
}

export const makeFolder = (root: string, path: string): void => {
  if (path.trim() === '') throw new AssetOpError('a folder needs a name')
  const full = resolve(root, path)
  if (existsSync(full)) throw new AssetOpError(`already exists: ${path}`)
  mkdirSync(full, { recursive: true })
}

/**
 * Move or rename a file or a folder. A file's sidecar moves with it, so its id — and every reference to it —
 * survives. Refuses to overwrite, and refuses to move a folder inside itself, where the destination path
 * would be unresolvable and the subtree would be lost on the way.
 */
export const movePath = (root: string, from: string, to: string): void => {
  if (from.trim() === '' || to.trim() === '') throw new AssetOpError('move needs a source and a destination')
  const src = resolve(root, from)
  const dst = resolve(root, to)
  if (src === root) throw new AssetOpError('the content root cannot be moved')
  if (!existsSync(src)) throw new AssetOpError(`not found: ${from}`)
  if (existsSync(dst)) throw new AssetOpError(`already exists: ${to}`)
  if (dst === src || dst.startsWith(src + sep)) throw new AssetOpError('a folder cannot be moved inside itself')

  mkdirSync(join(dst, '..'), { recursive: true })
  renameSync(src, dst)

  // The sidecar is a separate file, so it needs the same move. Folders carry theirs along inside them.
  if (statSync(dst).isFile()) {
    const srcMeta = `${src}${META_SUFFIX}`
    if (existsSync(srcMeta)) renameSync(srcMeta, `${dst}${META_SUFFIX}`)
  }
}

/** Delete a file (with its sidecar) or a folder and everything in it. */
export const removePath = (root: string, path: string): void => {
  if (path.trim() === '') throw new AssetOpError('the content root cannot be deleted')
  const full = resolve(root, path)
  if (full === root) throw new AssetOpError('the content root cannot be deleted')
  if (!existsSync(full)) throw new AssetOpError(`not found: ${path}`)

  const isFile = statSync(full).isFile()
  rmSync(full, { recursive: true, force: true })
  // Leaving an orphan sidecar behind would be harmless but untidy, and confusing to anyone reading the tree.
  if (isFile) rmSync(`${full}${META_SUFFIX}`, { force: true })
}

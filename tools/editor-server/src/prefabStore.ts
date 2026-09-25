import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createAssetIndex, type AssetIndex } from './assetIndex'

import { META_SUFFIX } from '../../../packages/content/src/assets'
import type { Node } from '../../../packages/content/src/types'

/**
 * The prefab definitions on disk, by asset id (ADR 0091).
 *
 * A level references a prefab by id, so anything that opens a level has to resolve those references — and on
 * this side that means reading the files. The asset index (`assetIndex.ts`) already knows every file and its
 * identity (the `.meta` sidecar), so this is a lookup in it plus a parse, with a rescan when an id is not known
 * yet — a prefab saved seconds ago must resolve for the level that references it — or has left the path the
 * index gave.
 *
 * The file itself is read every time on purpose. Prefabs are few and small, a level opens rarely, and a cached
 * definition would mean a level resolving a prefab that has since changed — the exact bug this whole change
 * exists to remove.
 */
export interface PrefabStore {
  /** The prefab file's root node for this id, or `undefined` when there is no such file. */
  root: (assetId: string) => Node | undefined
  /** Path of a prefab asset relative to `content/` (ADR 0161), for a lock key or a change report. */
  pathOf: (assetId: string) => string | undefined
  /** Write a prefab back to its own file. Returns the path written, or `null` when the id is unknown. */
  write: (assetId: string, root: Node) => string | null
}

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && Array.isArray((v as { components?: unknown }).components)

/** `index` is the one the content API writes through, so a prefab it just saved or moved is already in it. */
export const createPrefabStore = (contentDir: string, index: AssetIndex = createAssetIndex(contentDir)): PrefabStore => {
  const prefabPath = (assetId: string): string | undefined => {
    const e = index.byId(assetId)
    return e?.kind === 'prefab' ? e.path : undefined
  }

  /**
   * Does `rel` still hold this prefab? Its sidecar is what says so — the id travels with the file (ADR 0026) —
   * so this is one small read rather than a walk of the tree.
   */
  const stillAt = (assetId: string, rel: string): boolean => {
    try {
      const meta: unknown = JSON.parse(readFileSync(join(contentDir, `${rel}${META_SUFFIX}`), 'utf8'))
      return typeof meta === 'object' && meta !== null && (meta as { id?: unknown }).id === assetId && existsSync(join(contentDir, rel))
    } catch {
      return false
    }
  }

  /**
   * The path for an id, rescanning when it is not known — a prefab created since the last look — **or when the
   * one remembered no longer holds it**. A prefab renamed, moved or deleted since kept its old path here, so a
   * level opened afterwards resolved nothing for its placements, and a prefab edit was written back to where the
   * file used to be (or refused, its folder gone) until the server restarted.
   */
  const pathOf = (assetId: string): string | undefined => {
    const known = prefabPath(assetId)
    if (known !== undefined && stillAt(assetId, known)) return known
    index.refresh()
    return prefabPath(assetId)
  }

  return {
    pathOf,
    write: (assetId, root) => {
      const rel = pathOf(assetId)
      if (rel === undefined) return null
      writeFileSync(join(contentDir, rel), `${JSON.stringify(root, null, 2)}\n`)
      return rel
    },
    root: (assetId) => {
      const rel = pathOf(assetId)
      if (rel === undefined) return undefined
      const file = join(contentDir, rel)
      if (!existsSync(file)) return undefined
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
        // Structural, as every other reader's check is: a root node has a components array. A malformed file
        // is an unresolved reference, not a server that will not start.
        return isNode(parsed) ? parsed : undefined
      } catch {
        return undefined
      }
    },
  }
}

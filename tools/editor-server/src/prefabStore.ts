import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { importAssets } from './assetImporter'

import type { Node } from '../../../packages/content/src/types'

/**
 * The prefab definitions on disk, by asset id (ADR 0091).
 *
 * A level references a prefab by id, so anything that opens a level has to resolve those references — and on
 * this side that means reading the files. The importer already walks the asset tree and owns identity (the
 * `.meta` sidecar), so this is a thin index over it plus a parse, with one rescan when an id is not known yet:
 * a prefab saved seconds ago must resolve for the level that references it.
 *
 * Nothing is cached across a miss on purpose. Prefabs are few and small, a level opens rarely, and a stale
 * index here would mean a level resolving a prefab that has since changed — the exact bug this whole change
 * exists to remove.
 */
export interface PrefabStore {
  /** The prefab file's root node for this id, or `undefined` when there is no such file. */
  root: (assetId: string) => Node | undefined
  /** Repo-relative path of a prefab asset, for a lock key or a change report. */
  pathOf: (assetId: string) => string | undefined
}

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && Array.isArray((v as { components?: unknown }).components)

export const createPrefabStore = (assetsDir: string): PrefabStore => {
  let byId = new Map<string, string>() // asset id → path relative to the assets folder

  const scan = (): void => {
    const { entries } = importAssets(assetsDir)
    byId = new Map(entries.filter((e) => e.kind === 'prefab').map((e) => [e.id, e.path]))
  }

  /** The path for an id, rescanning once when it is not known — a prefab created since the last look. */
  const pathOf = (assetId: string): string | undefined => {
    const known = byId.get(assetId)
    if (known !== undefined) return known
    scan()
    return byId.get(assetId)
  }

  return {
    pathOf,
    root: (assetId) => {
      const rel = pathOf(assetId)
      if (rel === undefined) return undefined
      const file = join(assetsDir, rel)
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

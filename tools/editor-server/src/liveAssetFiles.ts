import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { AssetIndex } from './assetIndex'
import { assetPath } from './live'
import type { LiveAssetsOptions } from './liveAssets'

import type { AssetEntry } from '../../../packages/content/src/assets'

/**
 * A live asset's file, by id, found through the asset index (ADR 0159) — wherever it has been moved to since it
 * opened. `server.ts` and the dev editor's `vite.config.ts` both build their live assets over this.
 */
export const liveAssetFiles = (contentDir: string, index: AssetIndex): Pick<LiveAssetsOptions, 'read' | 'write'> => {
  /** The entry, looked for again when the index has none or its file is not where the index says. */
  const find = (assetId: string): AssetEntry | undefined => {
    const e = index.byId(assetId)
    if (e !== undefined && existsSync(join(contentDir, e.path))) return e
    index.refresh()
    const again = index.byId(assetId)
    return again !== undefined && existsSync(join(contentDir, again.path)) ? again : undefined
  }
  return {
    read: (assetId) => {
      const e = find(assetId)
      if (e === undefined) return null
      try {
        return { kind: e.kind, json: JSON.parse(readFileSync(join(contentDir, e.path), 'utf8')) as unknown }
      } catch {
        return null
      }
    },
    write: (assetId, json) => {
      const e = find(assetId)
      if (e === undefined) return null
      writeFileSync(join(contentDir, e.path), `${JSON.stringify(json, null, 2)}\n`)
      return assetPath(e.path)
    },
  }
}

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { AssetIndex } from './assetIndex'
import { assetPath } from './live'
import type { LiveAssetsOptions } from './liveAssets'

import type { AssetEntry } from '../../../packages/content/src/assets'
import { gameFile, isGameName } from '../../../packages/content/src/layout'
import { gameOfDocId } from '../../../packages/content/src/liveAssets'

/**
 * A live asset's file, by id, found through the asset index (ADR 0159) — wherever it has been moved to since it
 * opened — or a game's data file, by `gameDocId` (ADR 0162). `server.ts` and the dev editor's `vite.config.ts`
 * both build their live assets over this.
 */
export const liveAssetFiles = (contentDir: string, index: AssetIndex): Pick<LiveAssetsOptions, 'read' | 'write'> => {
  /** A game's `game.json`, relative to the content folder, when the id names a game that has one. */
  const gamePath = (id: string): string | null => {
    const game = gameOfDocId(id)
    if (game === null || !isGameName(game) || !existsSync(join(contentDir, gameFile(game)))) return null
    return gameFile(game)
  }
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
      if (gameOfDocId(assetId) !== null) {
        const path = gamePath(assetId)
        if (path === null) return null
        try {
          return { kind: 'game', json: JSON.parse(readFileSync(join(contentDir, path), 'utf8')) as unknown }
        } catch {
          return null
        }
      }
      const e = find(assetId)
      if (e === undefined) return null
      try {
        return { kind: e.kind, json: JSON.parse(readFileSync(join(contentDir, e.path), 'utf8')) as unknown }
      } catch {
        return null
      }
    },
    write: (assetId, json) => {
      if (gameOfDocId(assetId) !== null) {
        const path = gamePath(assetId)
        if (path === null) return null
        writeFileSync(join(contentDir, path), `${JSON.stringify(json, null, 2)}\n`)
        return assetPath(path)
      }
      const e = find(assetId)
      if (e === undefined) return null
      writeFileSync(join(contentDir, e.path), `${JSON.stringify(json, null, 2)}\n`)
      return assetPath(e.path)
    },
  }
}

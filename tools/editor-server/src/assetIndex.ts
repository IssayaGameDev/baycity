import { importAssets } from './assetImporter'

import type { AssetEntry } from '../../../packages/content/src/assets'

/**
 * The asset list, held in memory: one walk of every library answers every lookup until something changes it.
 * Paths are relative to `content/`, starting with their library (ADR 0161).
 *
 * Every write the API makes rescans, and so does every `GET /api/assets` — which is also where a file copied in
 * from outside the API first gets its sidecar. Everything else reads: a prefab served live looked its file up
 * with a whole walk per request, so an editor fetching the library walked the tree once per prefab.
 *
 * A sidecar written by a scan nobody asked for (a lookup that found the list empty or stale) is kept until the
 * next `rescan`, which reports it: every new sidecar is attributed to someone and so reaches a commit.
 */
export interface AssetIndex {
  entries: () => readonly AssetEntry[]
  byPath: (path: string) => AssetEntry | undefined
  byId: (id: string) => AssetEntry | undefined
  /** Walk the tree again. Returns every sidecar written since the last `rescan`, for attribution. */
  rescan: () => string[]
  /** Walk the tree again for a lookup; the sidecars it writes wait for the next `rescan` to be reported. */
  refresh: () => void
}

export const createAssetIndex = (contentDir: string): AssetIndex => {
  let list: AssetEntry[] | null = null
  let paths = new Map<string, AssetEntry>()
  let ids = new Map<string, AssetEntry>()
  /** Sidecars written by a `refresh`, not yet reported. */
  let unreported: string[] = []

  const scan = (): string[] => {
    const { entries, created } = importAssets(contentDir)
    list = entries
    paths = new Map(entries.map((e) => [e.path, e]))
    ids = new Map(entries.map((e) => [e.id, e]))
    return created
  }
  const ready = (): void => {
    if (list === null) unreported.push(...scan())
  }

  return {
    entries: () => {
      ready()
      return list ?? []
    },
    byPath: (path) => {
      ready()
      return paths.get(path)
    },
    byId: (id) => {
      ready()
      return ids.get(id)
    },
    rescan: () => {
      const created = [...unreported, ...scan()]
      unreported = []
      return created
    },
    refresh: () => {
      unreported.push(...scan())
    },
  }
}

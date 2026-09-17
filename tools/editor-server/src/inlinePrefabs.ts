import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { ASSETS_DIR, LEVELS_DIR, LEVEL_SUFFIX } from '../../../packages/content/src/layout'
import { prefabRefsIn } from '../../../packages/content/src/prefabs'
import type { Level, Node } from '../../../packages/content/src/types'

/**
 * Finding the levels that carry a prefab **definition** rather than a reference (ADR 0124).
 *
 * `level.prefabs` is a resolution table — contents in memory, reference on disk. A definition that reached
 * disk is read *instead of* the asset from then on (`hydratePrefabs` skips an id the level already carries),
 * so the placement looks linked and silently stops following its prefab. ADR 0124 stopped new ones; these are
 * the files that already have one.
 *
 * Planning is separate from writing, and pure, for the reason `layoutMoves` is: what this will do to Kodjo's
 * content has to be readable before it does it.
 */

/** One entry in a level's table, and whether dropping it is safe. */
export interface InlineEntry {
  assetId: string
  /** A placement in this level references it. An entry nothing references is dead weight either way. */
  referenced: boolean
  /** The asset exists, so dropping the entry leaves the placement resolving against the real prefab. */
  hasAsset: boolean
  /** The entry and the asset differ, so dropping it changes what this level draws. */
  drifted: boolean
}

export interface InlineFinding {
  /** Path relative to the content directory. */
  file: string
  entries: InlineEntry[]
}

/** Prefab assets by id, read from the shared library's `.meta` sidecars (ADR 0026). */
export const prefabAssets = (contentDir: string): Map<string, { path: string; root: Node }> => {
  const out = new Map<string, { path: string; root: Node }>()
  const walk = (dir: string): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!name.endsWith('.prefab.json')) continue
      let id: string
      let root: Node
      try {
        id = String((JSON.parse(readFileSync(`${full}.meta`, 'utf8')) as { id?: unknown }).id ?? '')
        root = JSON.parse(readFileSync(full, 'utf8')) as Node
      } catch {
        continue
      }
      if (id !== '') out.set(id, { path: full, root })
    }
  }
  walk(join(contentDir, ASSETS_DIR, 'prefabs'))
  return out
}

/**
 * Every level carrying a definition, with what dropping each entry would mean.
 *
 * Reads only. A level with no `prefabs` table is not listed at all, which is the normal case.
 */
export const findInlinePrefabs = (contentDir: string): InlineFinding[] => {
  const assets = prefabAssets(contentDir)
  const out: InlineFinding[] = []
  let games: string[]
  try {
    games = readdirSync(contentDir).filter((name) => name !== ASSETS_DIR && statSync(join(contentDir, name)).isDirectory())
  } catch {
    return out
  }
  for (const game of games) {
    const dir = join(contentDir, game, LEVELS_DIR)
    let names: string[]
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(LEVEL_SUFFIX))
    } catch {
      continue
    }
    for (const name of names) {
      let level: Level
      try {
        level = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Level
      } catch {
        continue
      }
      const table = level.prefabs
      if (table === undefined || Object.keys(table).length === 0) continue
      const refs = new Set(prefabRefsIn(level))
      const entries = Object.entries(table).map(([assetId, root]) => {
        const asset = assets.get(assetId)
        return {
          assetId,
          referenced: refs.has(assetId),
          hasAsset: asset !== undefined,
          // Compared as written, since that is what a reader would have got either way.
          drifted: asset !== undefined && JSON.stringify(asset.root) !== JSON.stringify(root),
        }
      })
      out.push({ file: `${game}/${LEVELS_DIR}/${name}`, entries })
    }
  }
  return out
}

/**
 * Which entries may be dropped, and which must be kept and why.
 *
 * **Only an entry whose asset exists.** Dropping one with no asset behind it would turn a placement that
 * currently draws something into one that draws nothing — the level's table is genuinely its only source
 * there, which is the case `hydratePrefabs`'s skip was written for.
 *
 * A **drifted** entry is dropped too, and that is the point: the level starts following the prefab again. It
 * is also the only reason this changes what anything looks like, so it is reported separately and the caller
 * decides.
 */
export const planInlineCleanup = (
  findings: readonly InlineFinding[],
): { drop: { file: string; assetId: string; drifted: boolean }[]; keep: { file: string; assetId: string; why: string }[] } => {
  const drop: { file: string; assetId: string; drifted: boolean }[] = []
  const keep: { file: string; assetId: string; why: string }[] = []
  for (const f of findings) {
    for (const e of f.entries) {
      if (!e.hasAsset) {
        keep.push({ file: f.file, assetId: e.assetId, why: 'no prefab asset has this id — the table is the only source' })
        continue
      }
      drop.push({ file: f.file, assetId: e.assetId, drifted: e.drifted })
    }
  }
  return { drop, keep }
}

/** The level as it should be written: the table without the dropped ids, and gone entirely when empty. */
export const withoutEntries = (level: Level, dropIds: readonly string[]): Level => {
  const drop = new Set(dropIds)
  if (level.prefabs === undefined) return level
  const kept = Object.fromEntries(Object.entries(level.prefabs).filter(([id]) => !drop.has(id)))
  const out = { ...level }
  if (Object.keys(kept).length > 0) out.prefabs = kept
  else delete out.prefabs
  return out
}

import { normalizePoints, type Beyond, type CurvePoint, type Interpolation } from './curve'

/**
 * A game's tunable values, declared by the game and edited in the editor's Game section (ADR 0087, 0088).
 *
 * The values live in `content/games/<game>.json` under `settings`, beside the shared-component list (ADR 0077):
 * data, so a balance change is a save in the editor rather than a commit and a deploy, and so the staging game
 * and the live mirror pick it up like any other content. A game reads them through `readSettings`, which lays
 * whatever the file has over the declared defaults — a key the file lacks is its default, a key the game no
 * longer declares is ignored, a value of the wrong shape is the default.
 *
 * Two kinds: a **number**, one field; a **curve**, control points on a graph (`curve.ts`).
 */
export interface NumberSetting {
  kind?: 'number'
  /** What the editor shows. */
  label: string
  default: number
  min?: number
  max?: number
  step?: number
  /** One line under the field: what the number does. */
  hint?: string
}

export interface CurveSetting {
  kind: 'curve'
  label: string
  hint?: string
  /** Axis names for the editor: `'Level'`, `'XP to next level'`. */
  xLabel: string
  yLabel: string
  interpolation: Interpolation
  beyond: Beyond
  /** Draw and edit y on a log axis (exponential curves read as straight lines). */
  logY?: boolean
  /** The smallest y a point may take; `ratio` curves need > 0. */
  yMin?: number
  default: readonly CurvePoint[]
}

export type SettingDecl = NumberSetting | CurveSetting
export type SettingDecls = Readonly<Record<string, SettingDecl>>

export type SettingValue<D extends SettingDecl> = D extends CurveSetting ? CurvePoint[] : number
export type SettingValues<D extends SettingDecls> = { [K in keyof D]: SettingValue<D[K]> }

export const isCurveSetting = (d: SettingDecl): d is CurveSetting => d.kind === 'curve'

/** One declared value from whatever the file holds: the file's when it has the right shape, else the default. */
export const readSetting = <D extends SettingDecl>(decl: D, raw: unknown): SettingValue<D> => {
  if (isCurveSetting(decl)) {
    const pts = normalizePoints(raw)
    return (pts ?? decl.default.map((p) => ({ ...p }))) as SettingValue<D>
  }
  return (typeof raw === 'number' && Number.isFinite(raw) ? raw : decl.default) as SettingValue<D>
}

/** Declared defaults overlaid with what `raw` (the file's `settings` block, or anything) carries. */
export const readSettings = <D extends SettingDecls>(decls: D, raw: unknown): SettingValues<D> => {
  const out = {} as SettingValues<D>
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  for (const [key, decl] of Object.entries(decls) as [keyof D, SettingDecl][]) {
    out[key] = readSetting(decl, source[key as string]) as SettingValues<D>[keyof D]
  }
  return out
}

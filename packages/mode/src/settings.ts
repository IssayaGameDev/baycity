import { normalizePoints, type Beyond, type CurvePoint, type Interpolation } from './curve'

/**
 * A game's tunable values, declared by the game and edited in the editor's games window, Settings (ADR 0087, 0088,
 * 0162).
 *
 * The values live in `content/<game>/game.json` under `settings`, beside the shared-component list (ADR 0077):
 * data, so a balance change is a save in the editor rather than a commit and a deploy, and so the staging game
 * and the live mirror pick it up like any other content. A game reads them through `readSettings`, which lays
 * whatever the file has over the declared defaults — a key the file lacks is its default, a key the game no
 * longer declares is ignored, a value of the wrong shape is the default.
 *
 * Three kinds: a **number**, one field; a **curve**, control points on a graph (`curve.ts`); a **table**, rows of
 * numbers in named columns (ADR 0222) — Keyboard's step pads, a tier a row.
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

/** One column of a table: a number per row, as a number setting is. */
export interface TableColumn {
  label: string
  default: number
  min?: number
  max?: number
  step?: number
}

/** Rows of numbers in named columns (ADR 0222); the editor draws them as a list field — add, remove, drag to reorder. */
export interface TableSetting {
  kind: 'table'
  label: string
  hint?: string
  columns: Readonly<Record<string, TableColumn>>
  default: readonly Readonly<Record<string, number>>[]
}

export type SettingDecl = NumberSetting | CurveSetting | TableSetting
export type SettingDecls = Readonly<Record<string, SettingDecl>>

/** A table's rows, every column a number. */
export type TableRows = Record<string, number>[]

export type SettingValue<D extends SettingDecl> = D extends CurveSetting ? CurvePoint[] : D extends TableSetting ? TableRows : number
export type SettingValues<D extends SettingDecls> = { [K in keyof D]: SettingValue<D[K]> }

export const isCurveSetting = (d: SettingDecl): d is CurveSetting => d.kind === 'curve'
export const isTableSetting = (d: SettingDecl): d is TableSetting => d.kind === 'table'

/**
 * A table's rows from whatever the file holds: a list of objects, each column the row's finite number or the column's
 * default; anything else is the declared rows.
 */
const readTable = (decl: TableSetting, raw: unknown): TableRows => {
  if (!Array.isArray(raw) || !raw.every((r) => typeof r === 'object' && r !== null && !Array.isArray(r))) return decl.default.map((r) => ({ ...r }))
  return raw.map((r: Record<string, unknown>) => {
    const row: Record<string, number> = {}
    for (const [key, col] of Object.entries(decl.columns)) {
      const v = r[key]
      row[key] = typeof v === 'number' && Number.isFinite(v) ? v : col.default
    }
    return row
  })
}

/** One declared value from whatever the file holds: the file's when it has the right shape, else the default. */
export const readSetting = <D extends SettingDecl>(decl: D, raw: unknown): SettingValue<D> => {
  if (isCurveSetting(decl)) {
    const pts = normalizePoints(raw)
    return (pts ?? decl.default.map((p) => ({ ...p }))) as SettingValue<D>
  }
  if (isTableSetting(decl)) return readTable(decl, raw) as SettingValue<D>
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

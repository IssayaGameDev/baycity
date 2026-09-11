/**
 * A game's tunable numbers, declared by the game and edited in the editor's Game section (ADR 0087).
 *
 * The values live in `content/games/<game>.json` under `settings`, beside the shared-component list (ADR 0077):
 * data, so a balance change is a save in the editor rather than a commit and a deploy, and so the staging game
 * and the live mirror pick it up like any other content. A game reads them through `readSettings`, which lays
 * whatever the file has over the declared defaults — a key the file lacks is its default, a key the game no
 * longer declares is ignored.
 */
export interface SettingDecl {
  /** What the editor shows. */
  label: string
  default: number
  min?: number
  max?: number
  step?: number
  /** One line under the field: what the number does. */
  hint?: string
}

export type SettingDecls = Readonly<Record<string, SettingDecl>>

/** Declared defaults overlaid with the finite numbers `raw` carries. `raw` is the file's `settings` block, or anything. */
export const readSettings = <D extends SettingDecls>(decls: D, raw: unknown): { [K in keyof D]: number } => {
  const out = {} as { [K in keyof D]: number }
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  for (const [key, decl] of Object.entries(decls) as [keyof D, SettingDecl][]) {
    const v = source[key as string]
    out[key] = typeof v === 'number' && Number.isFinite(v) ? v : decl.default
  }
  return out
}

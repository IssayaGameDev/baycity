import type { Vec3 } from '@mp/core'
import type { AssetSpec, ParamDecls } from '@mp/components'

/**
 * Unity's Copy Component / Paste Component Values / Paste Component As New (ADR 0191): what the Inspector holds
 * between a copy and a paste. In this tab only, Kodjo's call — it lives in the Inspector, so it survives a
 * rebuild, another selection, another level and a prefab opened on top, and goes with the tab.
 *
 * Pure: what may be pasted where, and why not. The Inspector does the writing.
 */

/** A component as it was copied: its type, every value — the defaults filled in — and whether it was on. */
export interface ComponentClip {
  readonly kind: 'component'
  readonly type: string
  /** What the Inspector called it, for a refusal that names it. */
  readonly label: string
  readonly params: Readonly<Record<string, unknown>>
  readonly enabled: boolean
}

/** The Transform card's three lines, as the Inspector reads them. */
export interface TransformClip {
  readonly kind: 'transform'
  readonly position: Vec3
  readonly rotationDeg: Vec3
  readonly scale: Vec3
}

export type Clip = ComponentClip | TransformClip

/** Why `clip` cannot be pasted as values onto a component of `type`, or `null` when it can. */
export const valuesRefusal = (clip: Clip | null, type: string): string | null => {
  if (clip === null || clip.kind !== 'component') return 'nothing copied — Copy Component first'
  return clip.type === type ? null : `the copy is a ${clip.label}, and this is not one`
}

/**
 * Why the asset references in a copy cannot go into this document, or `null` (ADR 0191): each asset parameter, and
 * each asset field of a list's rows, asked of `refuse` — the rule a dropped asset meets, so another game's own
 * asset is refused here as it would be dropped on the field.
 */
export const assetsRefusal = (
  params: Readonly<Record<string, unknown>>,
  decls: ParamDecls,
  refuse: (of: AssetSpec['of'], id: string, dataType: string | undefined) => string | null,
): string | null => {
  const check = (value: unknown, spec: AssetSpec, field: string): string | null => {
    if (typeof value !== 'string' || value === '') return null
    const why = refuse(spec.of, value, spec.dataType)
    return why === null ? null : `${field}: ${why}`
  }
  for (const [key, spec] of Object.entries(decls)) {
    const field = spec.label ?? key
    if (spec.kind === 'asset') {
      const why = check(params[key], spec, field)
      if (why !== null) return why
    } else if (spec.kind === 'list') {
      const rows = params[key]
      if (!Array.isArray(rows)) continue
      for (const row of rows) {
        if (typeof row !== 'object' || row === null) continue
        for (const [inner, innerSpec] of Object.entries(spec.item)) {
          if (innerSpec.kind !== 'asset') continue
          const why = check((row as Record<string, unknown>)[inner], innerSpec, `${field} › ${innerSpec.label ?? inner}`)
          if (why !== null) return why
        }
      }
    }
  }
  return null
}

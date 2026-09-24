/**
 * The easing names, in the order a picker should offer them (ADR 0138). The standard set every tween library
 * ships, named as DOTween and easings.net name them rather than as `d3-ease` does, so the file does not depend
 * on which library supplies the formula.
 *
 * **A module of its own, importing nothing.** Checking a stored sequence needs the names, and that check is
 * reached from `ops.ts` and `validate.ts` — which the editor's `vite.config.ts` bundles by relative path and
 * Vite loads through plain Node, where a workspace package whose entry is `.ts` cannot load. Beside the
 * formulas in `sequence.ts` they pulled `@mp/core` into that config, and the editor's build failed.
 */
export const EASES = [
  'linear',
  'in-sine',
  'out-sine',
  'in-out-sine',
  'in-quad',
  'out-quad',
  'in-out-quad',
  'in-cubic',
  'out-cubic',
  'in-out-cubic',
  'in-quart',
  'out-quart',
  'in-out-quart',
  'in-quint',
  'out-quint',
  'in-out-quint',
  'in-expo',
  'out-expo',
  'in-out-expo',
  'in-circ',
  'out-circ',
  'in-out-circ',
  'in-back',
  'out-back',
  'in-out-back',
  'in-elastic',
  'out-elastic',
  'in-out-elastic',
  'in-bounce',
  'out-bounce',
  'in-out-bounce',
] as const
export type Ease = (typeof EASES)[number]

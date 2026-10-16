import { untilStage, type CompiledSequence, type SequenceClocks } from './sequence'
import type { ComponentData } from './types'

/**
 * A `Countdown` (ADR 0228): the text on its node counting down to the next of a sequence's stages — a platform's
 * fade-in, then its fade-out — each with its own words, `{t}` the seconds. On the sequence's own clock, so it is the
 * same on every screen a shared sequence is. One reading, for the loader and the editor's preview alike.
 */

export const COUNTDOWN = 'Countdown'

export interface CountdownRow {
  /** The stage counted to, 1 the first. */
  readonly stage: number
  /** What the text says while this row is the next, `{t}` the seconds left. */
  readonly text: string
}

export interface CountdownDesc {
  /** The `Sequence` counted on: its node, and its id there (`''` the node's first). `null` while none is set. */
  readonly sequence: { readonly node: string; readonly component: string } | null
  readonly rows: readonly CountdownRow[]
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The enabled `Countdown` component's reading, or `undefined` when the node has none. */
export const countdownOf = (components: readonly ComponentData[]): CountdownDesc | undefined => {
  const c = components.find((x) => x.type === COUNTDOWN && x.enabled !== false)
  if (c === undefined) return undefined
  const ref = c.params.sequence
  // A bare node id is a reference still in its old shape: that node's first.
  const sequence =
    typeof ref === 'string' && ref !== ''
      ? { node: ref, component: '' }
      : isObj(ref) && typeof ref.node === 'string' && ref.node !== ''
        ? { node: ref.node, component: typeof ref.component === 'string' ? ref.component : '' }
        : null
  const rows = Array.isArray(c.params.rows)
    ? c.params.rows.flatMap((r: unknown) => (isObj(r) && Number.isFinite(Number(r.stage)) ? [{ stage: Math.round(Number(r.stage)), text: typeof r.text === 'string' ? r.text : '' }] : []))
    : []
  return { sequence, rows }
}

/** Seconds as the text shows them: tenths, rounded up — so the last it reads is 0.1, never 0.0 before its moment. */
export const countdownSeconds = (s: number): string => (Math.ceil(s * 10 - 1e-9) / 10).toFixed(1)

/**
 * What the text says at these clocks: the row whose stage starts soonest, its `{t}` the seconds until then. `null`
 * when nothing is counted to — no sequence, no rows, every stage past its last pass: the Text's own words then.
 */
export const countdownText = (desc: CountdownDesc, compiled: CompiledSequence | undefined, clocks: SequenceClocks): string | null => {
  if (compiled === undefined) return null
  let next: { until: number; text: string } | null = null
  for (const row of desc.rows) {
    const until = untilStage(compiled, clocks, row.stage - 1)
    if (until !== null && (next === null || until < next.until)) next = { until, text: row.text }
  }
  return next === null ? null : next.text.replaceAll('{t}', countdownSeconds(next.until))
}

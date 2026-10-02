import type { Registry } from '@mp/components'

/**
 * What a refusal says to put right (ADR 0194): the nearest real names to one that is not. A model that is told
 * "no component type 'Mesh Renderer': its type is 'Renderer'" fixes the call; one told only "no" goes looking.
 */

const norm = (s: string): string => s.toLowerCase().replace(/[\s_-]/g, '')

/** Edits between two words: a typo is one or two. */
const distance = (a: string, b: string): number => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row.push(Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)))
    prev = row
  }
  return prev[b.length]!
}

/**
 * The candidates nearest `word`, best first: the same but for case and spacing, then one holding the other, then a
 * few edits away. None when nothing is near.
 */
export const closest = (word: string, candidates: readonly string[], max = 3): string[] => {
  const w = norm(word)
  if (w === '') return []
  const reach = Math.max(2, Math.floor(w.length / 3))
  const scored = candidates
    .map((c) => {
      const n = norm(c)
      return { c, d: n === w ? 0 : n.includes(w) || w.includes(n) ? 1 : 1 + distance(n, w) }
    })
    .filter((x) => x.d <= reach)
    .sort((a, b) => a.d - b.d)
  return [...new Set(scored.map((x) => x.c))].slice(0, max)
}

/** `: did you mean 'a' or 'b'?`, or nothing. */
export const didYouMean = (options: readonly string[]): string => (options.length === 0 ? '' : `: did you mean ${options.map((o) => `'${o}'`).join(' or ')}?`)

/** What a component type that is not one should have been: the type a label belongs to, or the nearest types. */
export const componentTypeHint = (registry: Registry, word: string): string => {
  const defs = registry.all()
  const labelled = defs.find((d) => d.label !== undefined && norm(d.label) === norm(word))
  if (labelled !== undefined) return `: its type is '${labelled.type}' (labelled ${labelled.label})`
  const near = closest(
    word,
    defs.flatMap((d) => [d.type, ...(d.label === undefined ? [] : [d.label])]),
  )
  return didYouMean([...new Set(near.map((n) => defs.find((d) => d.type === n || d.label === n)!.type))])
}

import { describe, expect, it } from 'vitest'

import { placeFor, type DropLayout } from './sequenceDrag'

/**
 * Where a drag lands (ADR 0147): the nearest place, from the pointer's height alone — nothing has to be hit.
 * Two stages, 100 px tall each, a 14 px link above, between and below them.
 */
const LAYOUT: DropLayout = {
  stages: [
    { id: 'A', top: 14, bottom: 114, steps: [{ id: 'a', mid: 50 }, { id: 'b', mid: 80 }] },
    { id: 'B', top: 128, bottom: 228, steps: [{ id: 'c', mid: 170 }] },
  ],
  links: [
    { before: 'A', top: 0, bottom: 14 },
    { before: 'B', top: 114, bottom: 128 },
    { top: 228, bottom: 242 },
  ],
}

describe('where a step lands', () => {
  it('joins the stage it is over, before the first step whose middle is below the pointer', () => {
    expect(placeFor('step', 40, LAYOUT)).toEqual({ kind: 'step', place: { kind: 'into', stage: 'A', before: 'a' } })
    expect(placeFor('step', 60, LAYOUT)).toEqual({ kind: 'step', place: { kind: 'into', stage: 'A', before: 'b' } })
    expect(placeFor('step', 100, LAYOUT), 'past the last step: the end of the stage').toEqual({ kind: 'step', place: { kind: 'into', stage: 'A' } })
  })

  it('becomes a stage of its own on a link between stages, or past either end', () => {
    expect(placeFor('step', 120, LAYOUT)).toEqual({ kind: 'step', place: { kind: 'new-stage', before: 'B' } })
    expect(placeFor('step', 5, LAYOUT)).toEqual({ kind: 'step', place: { kind: 'new-stage', before: 'A' } })
    expect(placeFor('step', 235, LAYOUT)).toEqual({ kind: 'step', place: { kind: 'new-stage' } })
    expect(placeFor('step', 400, LAYOUT), 'far below everything: still the end').toEqual({ kind: 'step', place: { kind: 'new-stage' } })
    expect(placeFor('step', -50, LAYOUT), 'far above: still the start').toEqual({ kind: 'step', place: { kind: 'new-stage', before: 'A' } })
  })

  it('starts the first stage in an empty sequence', () => {
    expect(placeFor('step', 10, { stages: [], links: [] })).toEqual({ kind: 'step', place: { kind: 'new-stage' } })
  })
})

describe('where a stage lands', () => {
  it('goes before the first stage whose middle is below the pointer, or at the end', () => {
    expect(placeFor('stage', 40, LAYOUT)).toEqual({ kind: 'stage', before: 'A' })
    expect(placeFor('stage', 150, LAYOUT)).toEqual({ kind: 'stage', before: 'B' })
    expect(placeFor('stage', 200, LAYOUT)).toEqual({ kind: 'stage' })
  })
})

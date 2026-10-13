import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import type { WorldNode } from '@mp/content'

import type { CheckpointStop } from './components/obstacle'
import { SLIDE_SECONDS, slideOut, stepSlide, teleportRows } from './teleportWindow'

/** The teleport window (ADR 0203): what it lists, and how it slides. */
describe('the teleport window', () => {
  const stop = (number: number, position: ReturnType<typeof vec3>, yaw: number, key: string): CheckpointStop => ({
    number,
    node: {} as WorldNode,
    position,
    yaw,
    key,
    pivot: position,
    safeZoneText: undefined,
    requiredLevelText: undefined,
  })

  it('lists Start, facing kept, then every checkpoint by number, facing its way', () => {
    const rows = teleportRows(vec3(0, 1, 0), [stop(1, vec3(0, 2, 90), 0, 'a'), stop(2, vec3(-160, 5, 440), Math.PI / 2, 'b')], () => true)
    expect(rows.map((r) => r.label)).toEqual(['Start', 'Checkpoint 1', 'Checkpoint 2'])
    expect(rows[0]!.to).toEqual({ position: vec3(0, 1, 0), obstacle: null })
    expect(rows[2]!.to).toEqual({ position: vec3(-160, 5, 440), yaw: Math.PI / 2, obstacle: rows[2]!.to.obstacle })
    expect(rows[2]!.to.obstacle, 'the checkpoint it lands on').not.toBeNull()
  })

  /** Kodjo's call (ADR 0211): one not yet reached is listed, greyed, and cannot be picked. */
  it('shuts a checkpoint not yet reached, never Start', () => {
    const rows = teleportRows(vec3(0, 1, 0), [stop(1, vec3(0, 0, 1), 0, 'a'), stop(2, vec3(0, 0, 2), 0, 'b')], (key) => key === 'a')
    expect(rows.map((r) => r.locked)).toEqual([false, false, true])
  })

  it('slides out in a quarter second, eased to a stop, and back the same way', () => {
    expect(SLIDE_SECONDS).toBe(0.25)
    expect(stepSlide(0, true, 0.125)).toBeCloseTo(0.5, 9)
    expect(stepSlide(0.5, true, 1), 'never past out').toBe(1)
    expect(stepSlide(0.5, false, 1), 'never past shut').toBe(0)
    // Out-cubic: most of the way in the first half, settling at the end.
    expect(slideOut(0.5)).toBeCloseTo(0.875, 9)
    expect(slideOut(1)).toBe(1)
  })

  it('turns back from wherever it is when closed mid-slide', () => {
    const half = stepSlide(0, true, 0.1)
    expect(stepSlide(half, false, 0.1)).toBeCloseTo(0, 9)
  })
})

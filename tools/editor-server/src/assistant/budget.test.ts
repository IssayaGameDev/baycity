import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { costOf, createBudget } from './budget'
import { DEFAULT_MODEL, modelOf } from './models'

/** A person's day on the assistant (ADR 0192): counted in dollars, kept across a restart, fresh each UTC day. */
let dir = ''
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'mp-budget-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the assistant’s budget', () => {
  it('prices usage at the model’s rates, cache reads and writes included', () => {
    const haiku = DEFAULT_MODEL.prices
    expect(costOf({ input_tokens: 1_000_000, output_tokens: 0 }, haiku)).toBeCloseTo(1, 9)
    expect(costOf({ input_tokens: 0, output_tokens: 200_000 }, haiku)).toBeCloseTo(1, 9)
    expect(costOf({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 800_000, cache_read_input_tokens: 1_000_000 }, haiku)).toBeCloseTo(1.1, 9)
    // Fable 5.1 (ADR 0199): input 10, output 50, cache write 12.5, cache read 0.25.
    expect(costOf({ input_tokens: 100_000, output_tokens: 20_000, cache_creation_input_tokens: 80_000, cache_read_input_tokens: 1_000_000 }, modelOf('claude-fable-5-1')!.prices)).toBeCloseTo(3.25, 9)
  })

  it('counts each person apart, keeps it through a restart, and starts again the next day', () => {
    let t = Date.UTC(2026, 9, 1, 10)
    const file = join(dir, 'spend.json')
    const a = createBudget({ file, limit: 1, now: () => t })
    a.add('Ada@x.com', 0.4)
    a.add('ada@x.com', 0.2)
    a.add('bob@x.com', 0.1)
    expect(a.spent('ada@x.com')).toBeCloseTo(0.6, 9)
    const again = createBudget({ file, limit: 1, now: () => t })
    expect(again.spent('ADA@x.com'), 'a restart keeps the day').toBeCloseTo(0.6, 9)
    t = Date.UTC(2026, 9, 2, 0, 1)
    expect(again.spent('ada@x.com'), 'a new UTC day').toBe(0)
  })
})

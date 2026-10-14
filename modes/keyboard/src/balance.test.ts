import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { clearSeconds, formatReport, gateSpeed, padFor, runSeconds, simulate, type SimStage, type SimWorld } from './balance'
import { defaultSimWorld, simWorldOf } from './balanceWorlds'
import { DESIGN_STAGES, World } from './components/world'
import { PAD_SETTINGS, padTiersFrom } from './padTable'
import { DEFAULT_CURVE, maxSpeedAt } from './progression'

/** The balance simulator on the World (ADR 0223): what it reads, how a run is timed, how the player chooses. */

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))
const PADS = padTiersFrom(undefined)
const stage = (level: number, wins: number, extra: Partial<SimStage> = {}): SimStage => ({ level, wins, runSeconds: 45, floorSeconds: 5, failChance: 0, ...extra })
const world = (stages: SimStage[], extra: Partial<SimWorld> = {}): SimWorld => ({ name: 'W', baseXp: 1, speedMultiplier: 1, levelToEnter: 0, padTiers: 8, stages, ...extra })
/** No rebirth within reach: what a test about something else needs. */
const NO_REBIRTH = { ...DEFAULT_CURVE, rebirthLevel: [{ x: 1, y: 1e9 }] }

describe('a new World’s stages agree with docs/games/keyboard/world-1.md', () => {
  const md = readFileSync(here('../../../docs/games/keyboard/world-1.md'), 'utf8')
  const rows = md
    .split('\n')
    .filter((l) => /^\| \d+ \|/.test(l))
    .map((l) => {
      const cells = l.split('|').map((c) => c.trim())
      return { stage: Number(cells[1]), level: Number(/\d+/.exec(cells[4] ?? '')?.[0]), wins: Number((cells[5] ?? '').replace(/\s/g, '')) }
    })
    .filter((r) => Number.isFinite(r.wins))
  it('has the design table’s Levels (low bound) and Wins, in order', () => {
    expect(DESIGN_STAGES.map(([level, wins], i) => ({ stage: i + 1, level, wins }))).toEqual(rows)
  })
  it('defaults the pad table to the eight the game shipped', () => {
    expect(PADS).toEqual(PAD_SETTINGS.pads.default)
  })
})

describe('a run', () => {
  const s = stage(10, 100, { runSeconds: 40, floorSeconds: 19 })
  it('takes its run time at the gate, shrinking with speed, and never goes under its floor', () => {
    expect(runSeconds(s, 30, 30)).toBe(40)
    expect(runSeconds(s, 30, 60)).toBeCloseTo(19 + 21 / 2, 9)
    expect(runSeconds(s, 30, 1e9), 'a 19 s door stays 19 s').toBeCloseTo(19, 5)
  })
  it('costs, for each failed run before a clear, a share of a run and the trip back', () => {
    expect(clearSeconds(stage(0, 1, { runSeconds: 10, floorSeconds: 10 }), 10, 10, 0.5, 3), 'never failed').toBe(13)
    // Half fail: one failed run on average, half a run and the trip back.
    expect(clearSeconds(stage(0, 1, { runSeconds: 10, floorSeconds: 10, failChance: 0.5 }), 10, 10, 0.5, 3)).toBeCloseTo(13 + 5 + 3, 9)
  })
  it('gates at the Max Speed of its Level, times the world’s', () => {
    expect(gateSpeed(stage(20, 1), { speedMultiplier: 1 }, DEFAULT_CURVE)).toBe(maxSpeedAt(20))
    expect(gateSpeed(stage(20, 1), { speedMultiplier: 0.5 }, DEFAULT_CURVE)).toBe(maxSpeedAt(20) / 2)
  })
})

describe('padFor', () => {
  it('is the best pad the Wins reach among the world’s tiers, else the base', () => {
    expect(padFor(0, PADS, 8)).toBe(1)
    expect(padFor(15, PADS, 8)).toBe(5)
    expect(padFor(1e9, PADS, 3), 'only its first three').toBe(5)
  })
})

describe('simulate', () => {
  it('clears the stages in order, each once its speed passes the gate', () => {
    const r = simulate({ curve: NO_REBIRTH, pads: PADS, worlds: [world([stage(0, 1), stage(0, 3), stage(5, 10)])], horizonS: 1800 })
    const at = [1, 2, 3].map((n) => r.clearedAt.get(`W/${n}`))
    expect(at.every((t) => t !== undefined)).toBe(true)
    expect(at[0]!).toBeLessThan(at[1]!)
    expect(at[1]!).toBeLessThan(at[2]!)
  })

  it('farms the reached stage paying the most Wins a minute, not the furthest', () => {
    // Stage 2 needs far more speed than the player has, so it is cleared slowly; stage 1 is quick and pays well.
    const r = simulate({ curve: NO_REBIRTH, pads: [], worlds: [world([stage(0, 100, { runSeconds: 5, floorSeconds: 5 }), stage(0, 101, { runSeconds: 60, floorSeconds: 60 })])], horizonS: 600 })
    expect(r.events.some((e) => e.what.startsWith('farming stage 1'))).toBe(true)
    expect(r.events.some((e) => e.what.startsWith('farming stage 2'))).toBe(false)
  })

  it('takes pads by threshold and rebirths at the Level the curve asks', () => {
    const curve = { ...DEFAULT_CURVE, rebirthLevel: [{ x: 1, y: 3 }, { x: 2, y: 1e9 }], rebirthMultiplier: [{ x: 1, y: 2 }, { x: 2, y: 2 }] }
    const r = simulate({ curve, pads: PADS, worlds: [world([stage(0, 5, { runSeconds: 5, floorSeconds: 5 })])], horizonS: 900 })
    const whats = r.events.map((e) => e.what)
    expect(whats.some((w) => w.startsWith('pad +2/step taken'))).toBe(true)
    expect(whats.some((w) => w.startsWith('rebirth 1 at Level'))).toBe(true)
    expect(r.final.rebirths).toBe(1)
    expect(r.final.perStep % 2, 'the rebirth’s ×2 on the pad').toBe(0)
  })

  it('pays a step the world’s base XP, and moves up a world at its Level', () => {
    const w1 = world([stage(0, 1, { runSeconds: 5, floorSeconds: 5 })], { name: 'W1' })
    const w2 = world([stage(0, 1, { runSeconds: 5, floorSeconds: 5 })], { name: 'W2', levelToEnter: 5, baseXp: 100, speedMultiplier: 0.5 })
    const r = simulate({ curve: NO_REBIRTH, pads: [], worlds: [w2, w1], horizonS: 1800 })
    expect(r.events.some((e) => e.what.startsWith('entered W2'))).toBe(true)
    expect(r.final.world).toBe('W2')
    expect(r.final.perStep).toBe(100)
    expect(r.final.speed).toBe(maxSpeedAt(r.final.level) * 0.5)
  })

  it('reports without throwing on a World’s defaults', () => {
    const input = { curve: DEFAULT_CURVE, pads: PADS, worlds: [defaultSimWorld(PADS.length)], horizonS: 1800 }
    const text = formatReport(input, simulate(input))
    expect(text).toContain('Level milestones')
    expect(text).toContain('Events')
    expect(text).toMatch(/World 1 \(defaults\): 14 stages/)
  })
})

describe('reading a level’s World', () => {
  it('takes its numbers, fail % as a fraction, and the whole pad table when it lists no pads', () => {
    const level = {
      id: 'lv',
      config: {},
      nodes: [
        {
          id: 'w',
          transform: { position: { x: 0, y: 0, z: 0 } },
          components: [{ id: 'c', type: World.type, params: { baseXp: 2, stages: [{ obstacle: null, level: 7, wins: 30, gateSeconds: 20, floorSeconds: 4, fail: 25 }] } }],
        },
      ],
    }
    expect(simWorldOf('lv', level, 8)).toEqual({
      name: 'lv',
      baseXp: 2,
      speedMultiplier: 1,
      levelToEnter: 0,
      padTiers: 8,
      stages: [{ level: 7, wins: 30, runSeconds: 20, floorSeconds: 4, failChance: 0.25 }],
    })
    expect(simWorldOf('none', { id: 'x', config: {}, nodes: [] }, 8)).toBeNull()
  })
})

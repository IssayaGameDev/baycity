import { describe, expect, it } from 'vitest'

import { AUTO_DARK, AUTO_LIGHT, autoInk, cellHash, keyColoursAt } from './keyColours'

/** A key's colours from a Keyboard Style (ADR 0182): picked by weight, letters that read, hashed so every player agrees. */

const FALLBACK = { cap: 0xe8e6e1, ink: 0x2b2b31 }

describe('a key’s colours', () => {
  it('wears the board’s plain look with no style, no rows, or no weight', () => {
    expect(keyColoursAt(undefined, 1, 0, 0, FALLBACK)).toEqual(FALLBACK)
    expect(keyColoursAt({ keys: [], jitter: 0 }, 1, 0, 0, FALLBACK)).toEqual(FALLBACK)
    expect(keyColoursAt({ keys: [{ cap: '#ff0000', letter: '', weight: 0 }], jitter: 0 }, 1, 0, 0, FALLBACK)).toEqual(FALLBACK)
  })

  it('takes a row’s letter colour with its cap, and auto’s where it has none', () => {
    expect(keyColoursAt({ keys: [{ cap: '#ff8800', letter: '#ffffff', weight: 1 }], jitter: 0 }, 1, 3, 4, FALLBACK)).toEqual({ cap: 0xff8800, ink: 0xffffff })
    expect(keyColoursAt({ keys: [{ cap: '#111111', letter: '', weight: 1 }], jitter: 0 }, 1, 3, 4, FALLBACK).ink).toBe(AUTO_LIGHT)
  })

  it('picks rows in proportion to their weights', () => {
    const style = { keys: [{ cap: '#ffffff', letter: '', weight: 3 }, { cap: '#000000', letter: '', weight: 1 }], jitter: 0 }
    let white = 0
    for (let c = 0; c < 40; c++) for (let r = 0; r < 40; r++) if (keyColoursAt(style, 7, c, r, FALLBACK).cap === 0xffffff) white++
    expect(white / 1600).toBeGreaterThan(0.7)
    expect(white / 1600).toBeLessThan(0.8)
  })

  it('is the same key the same colour every time, and another seed reshuffles it', () => {
    const style = { keys: [{ cap: '#ff0000', letter: '', weight: 1 }, { cap: '#00ff00', letter: '', weight: 1 }, { cap: '#0000ff', letter: '', weight: 1 }], jitter: 0.2 }
    const board = (seed: number): number[] => [...Array(30).keys()].map((n) => keyColoursAt(style, seed, n, n * 2, FALLBACK).cap)
    expect(board(1)).toEqual(board(1))
    expect(board(2)).not.toEqual(board(1))
  })

  it('varies a cap’s shade by at most the jitter, and leaves its letter alone', () => {
    const style = { keys: [{ cap: '#808080', letter: '#000000', weight: 1 }], jitter: 0.1 }
    for (let n = 0; n < 50; n++) {
      const k = keyColoursAt(style, 1, n, 0, FALLBACK)
      const grey = (k.cap >> 16) & 0xff
      expect(grey).toBeGreaterThanOrEqual(Math.floor(128 * 0.9))
      expect(grey).toBeLessThanOrEqual(Math.ceil(128 * 1.1))
      expect(k.ink).toBe(0x000000)
    }
  })
})

describe('auto letters and the hash', () => {
  it('puts dark letters on a light cap and light ones on a dark cap', () => {
    expect(autoInk(0xffffff)).toBe(AUTO_DARK)
    expect(autoInk(0xe8e6e1)).toBe(AUTO_DARK)
    expect(autoInk(0x000000)).toBe(AUTO_LIGHT)
    expect(autoInk(0x1d3b8a)).toBe(AUTO_LIGHT)
  })

  it('stays in 0…1', () => {
    for (let n = 0; n < 200; n++) {
      const h = cellHash(n, n * 3, n * 7, 1)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(1)
    }
  })
})

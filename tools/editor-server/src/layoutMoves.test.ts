import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { applyLayout, planLayout, tidyOldFolders } from './layoutMoves'

/** A content tree in the old flat layout. `levels` maps a file name to the game it declares (or `null`). */
const oldTree = (games: readonly string[], levels: Record<string, string | null>): string => {
  const root = mkdtempSync(join(tmpdir(), 'layout-'))
  mkdirSync(join(root, 'games'), { recursive: true })
  mkdirSync(join(root, 'levels'), { recursive: true })
  mkdirSync(join(root, 'assets', 'materials'), { recursive: true })
  writeFileSync(join(root, 'assets', 'materials', 'checker.mat.json'), '{"shader":"standard","params":{}}\n')
  for (const g of games) writeFileSync(join(root, 'games', `${g}.json`), `{"components":[],"settings":{}}\n`)
  for (const [name, game] of Object.entries(levels)) {
    const config = game === null ? {} : { mode: { name: game } }
    writeFileSync(join(root, 'levels', `${name}.json`), `${JSON.stringify({ id: name, config, nodes: [] }, null, 2)}\n`)
  }
  return root
}

const treeOf = (dir: string, prefix = ''): string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix === '' ? name.name : `${prefix}/${name.name}`
    if (name.isDirectory()) out.push(...treeOf(join(dir, name.name), rel))
    else out.push(rel)
  }
  return out
}

describe('migrating to per-game folders (ADR 0108)', () => {
  it('plans a game file and a level into the game folder it already declares', () => {
    const root = oldTree(['keyboard', 'parkour'], { 'keyboard2': 'keyboard', 'default': 'parkour' })
    expect(planLayout(root)).toEqual({
      moves: [
        { from: 'games/keyboard.json', to: 'keyboard/game.json' },
        { from: 'games/parkour.json', to: 'parkour/game.json' },
        { from: 'levels/default.json', to: 'parkour/levels/default.level.json' },
        { from: 'levels/keyboard2.json', to: 'keyboard/levels/keyboard2.level.json' },
      ],
      refusals: [],
    })
  })

  it('moves the files and leaves the shared asset library alone', () => {
    const root = oldTree(['keyboard'], { 'keyboard2': 'keyboard' })
    const before = readFileSync(join(root, 'levels', 'keyboard2.json'), 'utf8')
    const { moves } = planLayout(root)
    applyLayout(root, moves)
    tidyOldFolders(root)
    expect(treeOf(root)).toEqual([
      'assets/materials/checker.mat.json',
      'keyboard/game.json',
      'keyboard/levels/keyboard2.level.json',
    ])
    // A pure rename: the level's bytes are what they were, so no id, reference or parameter can have moved.
    expect(readFileSync(join(root, 'keyboard', 'levels', 'keyboard2.level.json'), 'utf8')).toBe(before)
  })

  it('lets two games each own a level called default — the point of the change', () => {
    const root = oldTree(['keyboard', 'parkour'], { 'default': 'parkour', 'kb-default': 'keyboard' })
    const { moves } = planLayout(root)
    applyLayout(root, moves)
    // Renaming `kb-default` to `default` afterwards is now legal, because the folders keep them apart.
    expect(treeOf(root)).toContain('parkour/levels/default.level.json')
    expect(treeOf(root)).toContain('keyboard/levels/kb-default.level.json')
  })

  it('refuses a level that declares no game, and then moves nothing', () => {
    const root = oldTree(['keyboard'], { 'orphan': null, 'keyboard2': 'keyboard' })
    const plan = planLayout(root)
    expect(plan.refusals).toHaveLength(1)
    expect(plan.refusals[0]).toContain('orphan')
    expect(plan.refusals[0]).toContain('declares no game')
    // The CLI exits non-zero on any refusal without calling `applyLayout`, so the tree is untouched.
    expect(treeOf(root)).toContain('levels/keyboard2.json')
  })

  it('refuses a level whose game has no data file', () => {
    const root = oldTree(['keyboard'], { 'stray': 'nosuchgame' })
    expect(planLayout(root).refusals[0]).toContain('has no content/games/nosuchgame.json')
  })

  it('refuses a level that will not parse rather than guessing where it goes', () => {
    const root = oldTree(['keyboard'], {})
    writeFileSync(join(root, 'levels', 'broken.json'), '{ not json')
    expect(planLayout(root).refusals[0]).toContain('will not parse')
  })

  it('is idempotent: a tree already migrated plans nothing', () => {
    const root = oldTree(['keyboard'], { 'keyboard2': 'keyboard' })
    const { moves } = planLayout(root)
    applyLayout(root, moves)
    tidyOldFolders(root)
    expect(planLayout(root)).toEqual({ moves: [], refusals: [] })
  })

  it('never overwrites: a destination that exists stops the move', () => {
    const root = oldTree(['keyboard'], { 'keyboard2': 'keyboard' })
    mkdirSync(join(root, 'keyboard', 'levels'), { recursive: true })
    writeFileSync(join(root, 'keyboard', 'levels', 'keyboard2.level.json'), 'mine\n')
    const { moves } = planLayout(root)
    expect(() => applyLayout(root, moves)).toThrow(/already exists/)
    expect(readFileSync(join(root, 'keyboard', 'levels', 'keyboard2.level.json'), 'utf8')).toBe('mine\n')
  })

  it('leaves the old folders in place when something is still in them', () => {
    const root = oldTree(['keyboard'], {})
    writeFileSync(join(root, 'levels', 'notes.txt'), 'keep me\n')
    const { moves } = planLayout(root)
    applyLayout(root, moves)
    expect(tidyOldFolders(root)).toEqual(['games'])
    expect(treeOf(root)).toContain('levels/notes.txt')
  })
})

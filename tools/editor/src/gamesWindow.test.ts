// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { createGamesWindow, type GamesWindowHost } from './gamesWindow'

/**
 * The games window (ADR 0162): every game, the picked one's levels with who is in each, its components; opening a
 * level from it, and picking a game only browsing.
 */

const rig = (over: Partial<GamesWindowHost> = {}) => {
  document.body.replaceChildren()
  const calls: string[] = []
  const host: GamesWindowHost = {
    games: () => [
      { name: 'keyboard', label: 'Keyboard' },
      { name: 'parkour', label: 'Parkour' },
    ],
    levels: () => [
      { name: 'keyboard/Roblox', mode: 'keyboard' },
      { name: 'keyboard/default', mode: 'keyboard' },
      { name: 'parkour/level1', mode: 'parkour' },
    ],
    game: () => 'keyboard',
    openLevel: () => 'keyboard/Roblox',
    peopleIn: (q) => (q === 'keyboard/default' ? [{ name: 'Ana Lima', colour: '#ff0000' }] : []),
    components: () => ({ own: [{ type: 'Keyboard', label: 'Keyboard surface' }], shared: [{ type: 'Hazard', label: 'Hazard' }], engine: [{ type: 'Renderer', label: 'Mesh Renderer' }] }),
    onOpenLevel: (q) => calls.push(`open ${q}`),
    onNewLevel: (g) => calls.push(`new ${g}`),
    onLevelContext: (_at, q) => calls.push(`menu ${q}`),
    ...over,
  }
  const w = createGamesWindow(host)
  w.open()
  const $$ = (sel: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(sel)]
  const tiles = (): string[] => $$('.gw-tile .gw-name').map((n) => n.textContent ?? '')
  return { w, calls, $$, tiles }
}

describe('the games window', () => {
  it('opens on the game you are in, its levels as tiles — default first — and who is in each', () => {
    const { $$, tiles } = rig()
    expect($$('.gw-game').map((b) => b.textContent)).toEqual(['Keyboard', 'Parkour'])
    expect($$('.gw-game.on').map((b) => b.textContent)).toEqual(['Keyboard'])
    expect(tiles()).toEqual(['New level', 'default', 'Roblox'])
    expect($$('.gw-tile.on .gw-name').map((n) => n.textContent), 'the one open').toEqual(['Roblox'])
    const face = $$('.gw-people .pp')[0]!
    expect(face.textContent).toBe('AL')
    expect(face.title).toBe('Ana Lima is in default')
  })

  it('only browses when another game is picked, and opens a level on a double-click', () => {
    const { $$, tiles, calls } = rig()
    $$('.gw-game')[1]!.click()
    expect(tiles()).toEqual(['New level', 'level1'])
    expect(calls, 'nothing opened by picking a game').toEqual([])
    $$('.gw-tile')[1]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    $$('.gw-new')[0]!.click()
    $$('.gw-tile')[1]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    expect(calls).toEqual(['open parkour/level1', 'new parkour', 'menu parkour/level1'])
  })

  it('lists the game’s components as its own, the shared ones it took, and the built-in ones', () => {
    const { $$ } = rig()
    $$('.gw-tab').find((t) => t.textContent === 'Components')!.click()
    expect($$('.gw-section').map((s) => s.textContent)).toEqual(['Its own', 'Shared', 'Built in'])
    expect($$('.gw-component-l').map((l) => l.textContent)).toEqual(['Keyboard surface', 'Hazard', 'Mesh Renderer'])
  })

  it('keeps the keys from the level behind it, and closes on Escape', () => {
    const { w } = rig()
    let reached = false
    const behind = (): void => void (reached = true)
    window.addEventListener('keydown', behind)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }))
    expect(reached, 'a Delete here deletes nothing there').toBe(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w.isOpen()).toBe(false)
    window.removeEventListener('keydown', behind)
  })
})

// @vitest-environment happy-dom
import type { BalanceLevel } from '@mp/mode'
import { describe, expect, it } from 'vitest'

import { createGamesWindow, type GamesWindowHost } from './gamesWindow'

/**
 * The games window (ADR 0162): every game, the picked one's levels with who is in each, its settings, its components;
 * opening a level from it, and picking a game only browsing.
 */

const rig = (over: Partial<GamesWindowHost> = {}) => {
  document.body.replaceChildren()
  const calls: string[] = []
  const values: Record<string, number> = { keyPitch: 1 }
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
    onRemoveShared: (g, type) => calls.push(`remove ${type} from ${g}`),
    onOpenLevel: (q) => calls.push(`open ${q}`),
    onNewLevel: (g) => calls.push(`new ${g}`),
    onLevelContext: (_at, q) => calls.push(`menu ${q}`),
    moveRefusal: (q, g) => (q === 'keyboard/Roblox' && g === 'parkour' ? 'it uses Keyboard surface, which Parkour does not have' : null),
    onMoveLevel: (q, g) => calls.push(`move ${q} to ${g}`),
    settings: (g) => (g === 'keyboard' ? { decls: { keyPitch: { label: 'Key pitch', default: 1, min: 0.5, hint: 'metres between keys' } }, values } : null),
    onSettingChanged: (g, key, v, ongoing) => calls.push(`set ${g} ${key} ${String(v)}${ongoing ? ' ongoing' : ''}`),
    balance: () => null,
    onApplyBalance: (g, options) => calls.push(`apply ${g} ${JSON.stringify(options)}`),
    undo: () => calls.push('undo'),
    redo: () => calls.push('redo'),
    ...over,
  }
  const w = createGamesWindow(host)
  w.open()
  const $$ = (sel: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(sel)]
  const tiles = (): string[] => $$('.gw-tile .gw-name').map((n) => n.textContent ?? '')
  return { w, calls, $$, tiles, values }
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

  it('offers to remove a shared component, and only a shared one', () => {
    const { $$, calls } = rig()
    $$('.gw-tab').find((t) => t.textContent === 'Components')!.click()
    const removes = $$('.gw-component-x')
    expect(removes.map((b) => b.title)).toEqual(['Remove Hazard from this game'])
    removes[0]!.click()
    expect(calls).toEqual(['remove Hazard from keyboard'])
  })

  it('moves a level dropped on another game, and shows why one cannot go while it is held over it', () => {
    const { $$, calls } = rig()
    const tile = (name: string): HTMLElement => $$('.gw-tile').find((t) => t.querySelector('.gw-name')?.textContent === name)!
    const game = (label: string): HTMLElement => $$('.gw-game').find((g) => g.textContent === label)!
    const drag = (from: HTMLElement, to: HTMLElement, type: 'dragover' | 'drop'): void => {
      from.dispatchEvent(new Event('dragstart', { bubbles: true }))
      to.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))
    }
    drag(tile('Roblox'), game('Parkour'), 'dragover')
    expect(game('Parkour').classList.contains('refused')).toBe(true)
    expect(game('Parkour').title).toBe('it uses Keyboard surface, which Parkour does not have')
    drag(tile('default'), game('Parkour'), 'dragover')
    expect(game('Parkour').classList.contains('drop-onto')).toBe(true)
    drag(tile('default'), game('Parkour'), 'drop')
    drag(tile('default'), game('Keyboard'), 'drop')
    expect(calls, 'onto its own game, nothing').toEqual(['move keyboard/default to parkour'])
  })

  it('edits the game’s settings, and shows a value changed elsewhere in place', () => {
    const { w, $$, calls, values } = rig()
    $$('.gw-tab').find((t) => t.textContent === 'Settings')!.click()
    expect($$('.gw-settings .irow-l').map((l) => l.textContent)).toEqual(['Key pitch'])
    expect($$('.gw-settings .gw-note').map((n) => n.textContent)).toEqual(['metres between keys'])
    const input = document.querySelector<HTMLInputElement>('.gw-settings .sf-v')!
    expect(input.value).toBe('1')
    input.value = '0.25'
    input.dispatchEvent(new Event('blur'))
    expect(calls, 'typed below its minimum: clamped').toEqual(['set keyboard keyPitch 0.5'])
    values.keyPitch = 2
    w.settingsChanged('parkour')
    expect(input.value, 'another game’s change is not this page’s').toBe('0.5')
    w.settingsChanged('keyboard')
    expect(input.value).toBe('2')
    $$('.gw-game')[1]!.click()
    expect($$('.gw-settings .gw-note').map((n) => n.textContent)).toEqual(['This build has no code for this game.'])
  })

  it('takes Ctrl+Z and Ctrl+Y to the editor’s one history, but not from a field being typed in', () => {
    const { $$, calls } = rig()
    $$('.gw-tab').find((t) => t.textContent === 'Settings')!.click()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Z', ctrlKey: true, shiftKey: true }))
    const input = document.querySelector<HTMLInputElement>('.gw-settings .sf-v')!
    let reached = false
    const behind = (): void => void (reached = true)
    window.addEventListener('keydown', behind)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    window.removeEventListener('keydown', behind)
    expect(calls).toEqual(['undo', 'redo', 'redo'])
    expect(reached, 'a key pressed in the window stops at it').toBe(false)
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

  it('has a Balance tab for a game with one: the model, each moment against its target, re-run on every change (ADR 0225, 0226)', async () => {
    const reports: Record<string, number>[] = []
    let give: (levels: BalanceLevel[]) => void = () => {}
    let minutes = 45
    const { w, $$, calls } = rig({
      balance: (g) =>
        g !== 'keyboard'
          ? null
          : {
              options: { hold: { label: 'moving %', default: 100, min: 0, max: 100 } },
              rules: { modelMinutes: { label: 'World length, min', default: 45, min: 1 } },
              ruleValues: () => ({ modelMinutes: minutes }),
              levels: () => new Promise<BalanceLevel[]>((done) => void (give = done)),
              report: (levels, options) => {
                reports.push({ ...options })
                const moments = [
                  { label: 'stage 1', targetS: 60, simulatedS: 48 },
                  { label: 'stage 2', targetS: 120, simulatedS: 125 },
                  { label: 'stage 3', targetS: null, simulatedS: 200 },
                  { label: 'stage 4', targetS: 600, simulatedS: null },
                ]
                return { groups: [{ title: 'World 1', moments }], notes: [`${levels.length} level`] }
              },
            },
    })
    expect($$('.gw-tab').map((t) => t.textContent)).toEqual(['Levels', 'Settings', 'Balance', 'Components'])
    $$('.gw-tab').find((t) => t.textContent === 'Balance')!.click()
    expect($$('.gw-results')[0]!.textContent).toBe('Reading the levels…')
    give([{ name: 'Roblox', level: { id: 'Roblox', config: {}, nodes: [] } }])
    await Promise.resolve()
    expect(reports, 'the player starts at its defaults').toEqual([{ hold: 100 }])
    const rows = $$('.gw-moment')
    expect(rows.map((r) => r.className.replace('gw-moment ', ''))).toEqual(['early', 'on', 'none', 'missed'])
    expect(rows.map((r) => [...r.children].map((c) => c.textContent))).toEqual([
      ['stage 1', '1m00', '48s', '12s early'],
      ['stage 2', '2m00', '2m05', 'on target (5s late)'],
      ['stage 3', '—', '3m20', ''],
      ['stage 4', '10m00', 'not reached', 'not reached'],
    ])
    expect($$('.gw-results .gw-note').map((n) => n.textContent)).toEqual(['1 level'])
    expect($$('.gw-balance > .gw-section').map((n) => n.textContent)).toEqual(['Model: World 1', 'Player', 'Results'])

    const [rule, hold] = [...document.querySelectorAll<HTMLInputElement>('.gw-balance .sf-v')]
    hold!.value = '70'
    hold!.dispatchEvent(new Event('blur'))
    expect(reports.at(-1), 'a player option re-runs it').toEqual({ hold: 70 })
    rule!.value = '30'
    rule!.dispatchEvent(new Event('blur'))
    expect(calls, 'a rule is a setting, written as one').toEqual(['set keyboard modelMinutes 30'])
    minutes = 30
    w.settingsChanged('keyboard')
    expect(rule!.value, 'shown in place').toBe('30')
    expect(reports, 'and the run again').toHaveLength(3)
    document.querySelector<HTMLButtonElement>('.gw-apply')!.click()
    expect(calls.at(-1), 'Apply, for the player set').toBe('apply keyboard {"hold":70}')

    $$('.gw-game')[1]!.click()
    expect($$('.gw-tab').map((t) => t.textContent), 'none for a game without one').toEqual(['Levels', 'Settings', 'Components'])
  })
})

import { gameRows } from './assetTree'
import { icon } from './icons'
import { initials } from './people'

/**
 * The games window (Track B, ADR 0162): every game, and the one picked's levels and components, in a window over the
 * editor that the top bar's game button opens — PlayCanvas's project dashboard, Kodjo's reference.
 *
 * Levels left the Project window for it: a game is not an asset folder, it is where levels live, and the Project
 * window is the asset library now. Picking a game here only **browses**; opening one of its levels (a double-click)
 * is how the editor moves to that game. Its tiles say who is in each level.
 */

/** One of a game's components, as the Components tab lists it. */
export interface ComponentRow {
  type: string
  label: string
}

export interface GamesWindowHost {
  games: () => readonly { name: string; label: string }[]
  /** Every level on disk, qualified `<game>/<name>`. */
  levels: () => readonly { name: string; mode?: string }[]
  /** The game being edited, `null` for none. */
  game: () => string | null
  /** The level open now, qualified. */
  openLevel: () => string
  /** The others in a level, by its qualified name, each in their colour. */
  peopleIn: (qualified: string) => readonly { name: string; colour: string }[]
  /** A game's components: its own code's, the shared ones it has taken (ADR 0077), and the engine's. */
  components: (game: string) => { own: readonly ComponentRow[]; shared: readonly ComponentRow[]; engine: readonly ComponentRow[] } | null
  /** Open a level — which moves the editor to its game. The host guards unsaved work. */
  onOpenLevel: (qualified: string) => void
  /** Make a level in this game's folder, and open it. */
  onNewLevel: (game: string) => void
  /** Right-click on a level: the host's menu, with Duplicate, Rename, Delete. */
  onLevelContext: (at: { x: number; y: number }, qualified: string) => void
}

export interface GamesWindow {
  open: () => void
  close: () => void
  isOpen: () => boolean
  /** Draw again: a level made or gone, someone in or out of one. Nothing when closed. */
  render: () => void
}

type Tab = 'levels' | 'components'

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export const createGamesWindow = (host: GamesWindowHost): GamesWindow => {
  let root: HTMLElement | null = null
  let picked: string | null = null
  let tab: Tab = 'levels'

  const scrim = el('div', 'gw-scrim')
  const box = el('div', 'gw')
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-label', 'Games')
  scrim.append(box)
  // A press on the dim area outside the window closes it, as Escape does.
  scrim.addEventListener('pointerdown', (e) => {
    if (e.target === scrim) close()
  })

  /**
   * Keys go to the window while it is up, not to the level behind it: a Delete here must not delete a node there.
   * Escape closes it. A context menu open over it keeps its own keys.
   */
  const onKey = (e: KeyboardEvent): void => {
    if (document.querySelector('.menu, [data-dialog]') !== null) return
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  const levelTile = (qualified: string, name: string): HTMLElement => {
    const t = el('button', `gw-tile${host.openLevel() === qualified ? ' on' : ''}`)
    t.type = 'button'
    t.title = `${qualified} — double-click to open`
    const pic = el('span', 'gw-pic')
    pic.append(icon('level'))
    const people = host.peopleIn(qualified)
    if (people.length > 0) {
      const row = el('span', 'gw-people')
      for (const p of people) {
        const face = el('span', 'pp', initials(p.name))
        face.style.setProperty('--pc', p.colour)
        face.title = `${p.name} is in ${name}`
        row.append(face)
      }
      pic.append(row)
    }
    t.append(pic, el('span', 'gw-name', name))
    t.addEventListener('dblclick', () => host.onOpenLevel(qualified))
    t.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      host.onLevelContext({ x: e.clientX, y: e.clientY }, qualified)
    })
    return t
  }

  const levelsPage = (game: string): HTMLElement => {
    const grid = el('div', 'gw-tiles')
    const make = el('button', 'gw-tile gw-new')
    make.type = 'button'
    make.title = `a new level in content/${game}/levels/`
    const pic = el('span', 'gw-pic')
    pic.append(icon('plus'))
    make.append(pic, el('span', 'gw-name', 'New level'))
    make.addEventListener('click', () => host.onNewLevel(game))
    grid.append(make)
    const row = gameRows(host.games(), host.levels()).find((g) => g.name === game)
    for (const level of row?.levels ?? []) grid.append(levelTile(level.qualified, level.name))
    return grid
  }

  const componentsPage = (game: string): HTMLElement => {
    const page = el('div', 'gw-components')
    const list = host.components(game)
    if (list === null) {
      page.append(el('div', 'gw-note', 'This build has no code for this game.'))
      return page
    }
    const section = (title: string, note: string, rows: readonly ComponentRow[]): void => {
      page.append(el('div', 'gw-section', title), el('div', 'gw-note', note))
      if (rows.length === 0) page.append(el('div', 'gw-none', 'none'))
      for (const r of rows) {
        const line = el('div', 'gw-component')
        line.append(el('span', 'gw-component-l', r.label), el('span', 'gw-component-t', r.type))
        page.append(line)
      }
    }
    section('Its own', 'Written for this game: another game cannot use them.', list.own)
    section('Shared', 'From the shared set, taken by this game. Placing a prefab that uses another adds it.', list.shared)
    section('Built in', 'Every game has these.', list.engine)
    return page
  }

  const render = (): void => {
    if (root === null) return
    const games = host.games()
    if (picked === null || !games.some((g) => g.name === picked)) picked = host.game() ?? games[0]?.name ?? null

    const head = el('div', 'gw-head')
    head.append(el('span', 'gw-title', 'Games'))
    const shut = el('button', 'gw-close')
    shut.type = 'button'
    shut.title = 'Close (Esc)'
    shut.append(icon('close'))
    shut.addEventListener('click', () => close())
    head.append(shut)

    const list = el('div', 'gw-games')
    for (const g of games) {
      const b = el('button', `gw-game${g.name === picked ? ' on' : ''}`)
      b.type = 'button'
      b.append(el('span', 'gw-game-l', g.label))
      if (g.name === host.game()) {
        const here = el('span', 'gw-here')
        here.title = 'the game you are in'
        b.append(here)
      }
      b.addEventListener('click', () => {
        picked = g.name
        render()
      })
      list.append(b)
    }

    const page = el('div', 'gw-page')
    const label = games.find((g) => g.name === picked)?.label ?? ''
    const tabs = el('div', 'gw-tabs')
    tabs.append(el('span', 'gw-page-title', label))
    for (const [id, text] of [['levels', 'Levels'], ['components', 'Components']] as const) {
      const b = el('button', `gw-tab${tab === id ? ' on' : ''}`, text)
      b.type = 'button'
      b.addEventListener('click', () => {
        tab = id
        render()
      })
      tabs.append(b)
    }
    const body = el('div', 'gw-tab-body')
    if (picked !== null) body.append(tab === 'levels' ? levelsPage(picked) : componentsPage(picked))
    else body.append(el('div', 'gw-note', 'No game is installed in this build.'))
    page.append(tabs, body)

    const main = el('div', 'gw-body')
    main.append(list, page)
    box.replaceChildren(head, main)
  }

  const open = (): void => {
    if (root !== null) return
    picked = host.game()
    root = scrim
    document.body.append(scrim)
    window.addEventListener('keydown', onKey, true)
    render()
  }

  const close = (): void => {
    if (root === null) return
    root = null
    scrim.remove()
    window.removeEventListener('keydown', onKey, true)
  }

  return { open, close, isOpen: () => root !== null, render }
}

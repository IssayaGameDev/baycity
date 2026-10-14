import type { ParamDecls } from '@mp/components'
import { isCurveSetting, isTableSetting, type BalanceLevel, type BalanceReport, type CurvePoint, type NumberSetting, type SettingDecls, type TableRows } from '@mp/mode'

import { gameRows } from './assetTree'
import { clockOf, differenceOf, verdictOf } from './balanceView'
import { fieldRow, numberScrub, scrubFieldOf } from './controls'
import { createCurveEditor, type CurveEditor } from './curveEditor'
import { icon } from './icons'
import { initials } from './people'
import { listField } from './listField'

/**
 * The games window (Track B, ADR 0162): every game, and the one picked's levels, settings and components, in a window
 * over the editor that the top bar's game button opens — PlayCanvas's project dashboard, Kodjo's reference.
 *
 * Levels left the Project window for it: a game is not an asset folder, it is where levels live, and the Project
 * window is the asset library now. Picking a game here only **browses**; opening one of its levels (a double-click)
 * is how the editor moves to that game. Its tiles say who is in each level.
 *
 * A game's settings are its data file's, a live document (ADR 0162): a change shows at once, is everyone's, and is
 * an entry in the editor's one history, so Ctrl+Z here is the editor's.
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
  /** Take a shared component out of a game (ADR 0175): the host refuses while anything of the game uses it, and says where. */
  onRemoveShared: (game: string, type: string) => void
  /** Open a level — which moves the editor to its game. The host guards unsaved work. */
  onOpenLevel: (qualified: string) => void
  /** Make a level in this game's folder, and open it. */
  onNewLevel: (game: string) => void
  /** Right-click on a level: the host's menu, with Duplicate, Rename, Delete. */
  onLevelContext: (at: { x: number; y: number }, qualified: string) => void
  /** Why this level cannot go to that game, or `null` (ADR 0162): shown on the game while the level is dragged over it. */
  moveRefusal: (qualified: string, game: string) => string | null
  /** Move a level to another game: the host confirms, and refuses what `moveRefusal` does. */
  onMoveLevel: (qualified: string, game: string) => void
  /** A game's declared settings (ADR 0087/0088) and their values now, or `null` when this build has no code for it. */
  settings: (game: string) => { decls: SettingDecls; values: Readonly<Record<string, SettingShown>> } | null
  /** A setting was changed; `ongoing` while a number is still being dragged, so the drag is one undo entry. */
  onSettingChanged: (game: string, key: string, value: SettingShown, ongoing: boolean) => void
  /**
   * A game's Balance tab (ADR 0225), `null` when it has none: what it lets you set about the imagined player, its
   * levels as they are now — the open one live, the rest as the server has them — and its simulator over them with the
   * game's settings now.
   */
  balance: (game: string) => {
    options: Readonly<Record<string, NumberSetting>>
    levels: () => Promise<readonly BalanceLevel[]>
    report: (levels: readonly BalanceLevel[], options: Readonly<Record<string, number>>) => BalanceReport
  } | null
  /** The editor's one history (ADR 0159). */
  undo: () => void
  redo: () => void
}

/** A setting's value as the window shows and writes it: a number, a curve's points, a table's rows (ADR 0222). */
export type SettingShown = number | CurvePoint[] | TableRows

export interface GamesWindow {
  open: () => void
  close: () => void
  isOpen: () => boolean
  /** Draw again: a level made or gone, someone in or out of one. Nothing when closed. */
  render: () => void
  /** A game's settings changed — anyone's edit, an undo: its fields show the values now, in place, and its Balance re-runs. */
  settingsChanged: (game: string) => void
}

type Tab = 'levels' | 'settings' | 'balance' | 'components'

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
  /** The level being dragged onto a game, if one is (ADR 0162). */
  let dragging: string | null = null
  /** The Settings tab's fields by key, to show a value from elsewhere in place, and its graphs, to let go of. */
  let settingFields = new Map<string, (v: SettingShown) => void>()
  let curves: CurveEditor[] = []
  /** The imagined player per game, as the Balance tab sets it: kept while the editor is open, each from its default. */
  const balanceOptions = new Map<string, Record<string, number>>()
  /** The levels the Balance tab runs over, read each time it is shown: `levels` is `null` until they have come. */
  let balanceLevels: { game: string; levels: readonly BalanceLevel[] | null } | null = null
  /** Run the Balance tab's simulator again and redraw its results, while it is shown. */
  let rerunBalance: (() => void) | null = null

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
   * One pressed in the window — or in a curve's graph opened large over it — reaches what it was pressed in first,
   * a field being typed in, the graph, and stops at the window on its way out. Escape closes it; Ctrl+Z and Ctrl+Y are the editor's one history. A context
   * menu or a dialog over it keeps its own keys.
   */
  const onKey = (e: KeyboardEvent): void => {
    if (document.querySelector('.menu, [data-dialog]') !== null) return
    if (e.target instanceof Node && scrim.contains(e.target)) return // `afterKey` has it on the way out
    afterKey(e)
  }
  const afterKey = (e: KeyboardEvent): void => {
    if (document.querySelector('.menu, [data-dialog]') !== null) return
    e.stopPropagation()
    const t = e.target
    if (e.defaultPrevented || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    if (e.key === 'Escape') close()
    else if (mod && k === 'z' && !e.shiftKey) host.undo()
    else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) host.redo()
    else return
    e.preventDefault()
  }
  scrim.addEventListener('keydown', afterKey)

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
    // Dragged onto a game on the left, it moves there (ADR 0162).
    t.draggable = true
    t.addEventListener('dragstart', (e) => {
      dragging = qualified
      const dt = e.dataTransfer
      if (dt) {
        dt.setData('text/plain', qualified)
        dt.effectAllowed = 'move'
      }
    })
    t.addEventListener('dragend', () => {
      dragging = null
      render()
    })
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

  /**
   * The game's settings (ADR 0087/0088): a number is a field, dragged or typed; a curve is a graph. Each change is
   * the host's to send, and shows at once.
   */
  const settingsPage = (game: string): HTMLElement => {
    const page = el('div', 'gw-settings')
    const settings = host.settings(game)
    if (settings === null) {
      page.append(el('div', 'gw-note', 'This build has no code for this game.'))
      return page
    }
    const decls = Object.entries(settings.decls)
    if (decls.length === 0) page.append(el('div', 'gw-none', 'This game has no settings.'))
    for (const [key, decl] of decls) {
      const v = settings.values[key]
      if (isCurveSetting(decl)) {
        page.append(el('div', 'gw-section', decl.label))
        const holder = el('div', 'icurve')
        page.append(holder)
        // Opened large, the graph goes over the window, inside it, so its keys are the window's too.
        const graph = createCurveEditor(holder, {
          decl,
          points: Array.isArray(v) ? (v as CurvePoint[]) : decl.default,
          size: { w: 600, h: 220 },
          overlayParent: scrim,
          onChange: (points) => host.onSettingChanged(game, key, points, false),
        })
        curves.push(graph)
        settingFields.set(key, (next) => {
          if (Array.isArray(next)) graph.set(next as CurvePoint[])
        })
        if (decl.hint !== undefined) page.append(el('div', 'gw-note', decl.hint))
        continue
      }
      if (isTableSetting(decl)) {
        // A table (ADR 0222): the list field, a column a number; a row's drag writes when it lets go.
        page.append(el('div', 'gw-section', decl.label))
        const item: ParamDecls = Object.fromEntries(
          Object.entries(decl.columns).map(([column, c]) => [
            column,
            { kind: 'number', label: c.label, default: c.default, ...(c.min === undefined ? {} : { min: c.min }), ...(c.max === undefined ? {} : { max: c.max }), ...(c.step === undefined ? {} : { step: c.step }) },
          ]),
        )
        const rowsOf = (x: unknown): TableRows => (Array.isArray(x) && x.every((r) => typeof r === 'object' && r !== null) ? (x as TableRows) : decl.default.map((r) => ({ ...r })))
        const table = listField({
          item,
          value: rowsOf(v),
          title: decl.label,
          write: (rows, ongoing) => {
            if (ongoing !== true) host.onSettingChanged(game, key, rows as TableRows, false)
          },
          settle: () => undefined,
        })
        page.append(table.root)
        settingFields.set(key, (next) => {
          if (Array.isArray(next)) table.set(rowsOf(next))
        })
        if (decl.hint !== undefined) page.append(el('div', 'gw-note', decl.hint))
        continue
      }
      // A drag is one undo entry: each step is `ongoing`, and letting go ends it with the value it let go at.
      let last: number | null = null
      const field = scrubFieldOf({
        value: typeof v === 'number' ? v : decl.default,
        spec: numberScrub(decl),
        title: decl.label,
        commit: (n) => host.onSettingChanged(game, key, n, false),
        live: {
          start: () => undefined,
          move: (n) => {
            last = n
            host.onSettingChanged(game, key, n, true)
          },
          end: () => {
            if (last !== null) host.onSettingChanged(game, key, last, false)
            last = null
          },
        },
      })
      settingFields.set(key, (next) => {
        if (typeof next === 'number') field.set(next)
      })
      page.append(fieldRow(decl.label, field.root))
      if (decl.hint !== undefined) page.append(el('div', 'gw-note', decl.hint))
    }
    return page
  }

  /** The results: the notes, then a table a group — each moment, its target, the simulated time, how far off. */
  const reportView = (report: BalanceReport): HTMLElement[] => {
    const out: HTMLElement[] = report.notes.map((n) => el('div', 'gw-note', n))
    for (const g of report.groups) {
      out.push(el('div', 'gw-section', g.title))
      const table = el('table', 'gw-moments')
      const head = el('tr')
      for (const h of ['', 'target', 'simulated', 'against it']) head.append(el('th', undefined, h))
      table.append(head)
      for (const m of g.moments) {
        const row = el('tr', `gw-moment ${verdictOf(m.targetS, m.simulatedS)}`)
        row.append(
          el('td', 'gw-moment-l', m.label),
          el('td', undefined, m.targetS === null ? '—' : clockOf(m.targetS)),
          el('td', undefined, m.simulatedS === null ? 'not reached' : clockOf(m.simulatedS)),
          el('td', 'gw-moment-v', differenceOf(m.targetS, m.simulatedS)),
        )
        table.append(row)
      }
      out.push(table)
    }
    return out
  }

  /**
   * The game's balance (ADR 0225): the imagined player's numbers, then every moment the simulator reaches against the
   * target set for it. Re-run on every change here, in Settings, or by anyone; the levels are read when the tab shows.
   */
  const balancePage = (game: string): HTMLElement => {
    const page = el('div', 'gw-settings gw-balance')
    const balance = host.balance(game)
    if (balance === null) {
      page.append(el('div', 'gw-note', 'This game has no balance view.'))
      return page
    }
    const opts = balanceOptions.get(game) ?? Object.fromEntries(Object.entries(balance.options).map(([k, o]) => [k, o.default]))
    balanceOptions.set(game, opts)
    const results = el('div', 'gw-results')
    const run = (): void => {
      const levels = balanceLevels?.game === game ? balanceLevels.levels : null
      if (levels === null) {
        results.replaceChildren(el('div', 'gw-note', 'Reading the levels…'))
        return
      }
      try {
        results.replaceChildren(...reportView(balance.report(levels, opts)))
      } catch (e) {
        results.replaceChildren(el('div', 'gw-note', `The simulator stopped: ${e instanceof Error ? e.message : String(e)}`))
      }
    }
    // A drag re-runs once a frame, however many steps it takes in one.
    let queued = false
    const soon = (): void => {
      if (queued) return
      queued = true
      requestAnimationFrame(() => {
        queued = false
        if (rerunBalance === run) run()
      })
    }
    page.append(el('div', 'gw-section', 'Player'), el('div', 'gw-note', 'Who the simulator plays: each starts at its default, and stays as set while the editor is open.'))
    for (const [key, decl] of Object.entries(balance.options)) {
      const field = scrubFieldOf({
        value: opts[key] ?? decl.default,
        spec: numberScrub(decl),
        title: decl.label,
        commit: (n) => {
          opts[key] = n
          run()
        },
        live: {
          start: () => undefined,
          move: (n) => {
            opts[key] = n
            soon()
          },
          end: () => run(),
        },
      })
      page.append(fieldRow(decl.label, field.root))
      if (decl.hint !== undefined) page.append(el('div', 'gw-note', decl.hint))
    }
    page.append(el('div', 'gw-note', 'Targets are set on a World’s rows (each stage, and entering it) and in Settings (each rebirth). On target: within 10 %.'), results)
    rerunBalance = run
    if (balanceLevels?.game !== game) {
      const asked: { game: string; levels: readonly BalanceLevel[] | null } = { game, levels: null }
      balanceLevels = asked
      balance.levels().then(
        (levels) => {
          if (balanceLevels !== asked) return
          asked.levels = levels
          rerunBalance?.()
        },
        (e: unknown) => {
          if (balanceLevels === asked) results.replaceChildren(el('div', 'gw-note', `Could not read the levels: ${e instanceof Error ? e.message : String(e)}`))
        },
      )
    }
    run()
    return page
  }

  const componentsPage = (game: string): HTMLElement => {
    const page = el('div', 'gw-components')
    const list = host.components(game)
    if (list === null) {
      page.append(el('div', 'gw-note', 'This build has no code for this game.'))
      return page
    }
    // Only a shared one can go: the others are the game's code, or every game's.
    const section = (title: string, note: string, rows: readonly ComponentRow[], removable = false): void => {
      page.append(el('div', 'gw-section', title), el('div', 'gw-note', note))
      if (rows.length === 0) page.append(el('div', 'gw-none', 'none'))
      for (const r of rows) {
        const line = el('div', 'gw-component')
        line.append(el('span', 'gw-component-l', r.label), el('span', 'gw-component-t', r.type))
        if (removable) {
          const remove = el('button', 'gw-component-x')
          remove.type = 'button'
          remove.title = `Remove ${r.label} from this game`
          remove.append(icon('close'))
          remove.addEventListener('click', () => host.onRemoveShared(game, r.type))
          line.append(remove)
        }
        page.append(line)
      }
    }
    section('Its own', 'Written for this game: another game cannot use them.', list.own)
    section(
      'Shared',
      'From the shared set, taken by this game. Placing a prefab that uses another adds it; one nothing here uses can be removed.',
      list.shared,
      true,
    )
    section('Built in', 'Every game has these.', list.engine)
    return page
  }

  /** The Settings tab's graphs go with the page they were on. */
  const letGoOfSettings = (): void => {
    for (const c of curves) c.dispose()
    curves = []
    settingFields = new Map()
    rerunBalance = null
  }

  const render = (): void => {
    if (root === null) return
    letGoOfSettings()
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
      // A level dropped on a game moves there; one that cannot shows why, greyed, as it is held over it.
      const game = g
      const ownGame = (): boolean => dragging !== null && dragging.startsWith(`${game.name}/`)
      b.addEventListener('dragover', (e) => {
        if (dragging === null || ownGame()) return
        e.preventDefault()
        const why = host.moveRefusal(dragging, game.name)
        b.classList.toggle('refused', why !== null)
        b.classList.toggle('drop-onto', why === null)
        b.title = why ?? `Move to ${game.label}`
        const dt = e.dataTransfer
        if (dt) dt.dropEffect = why === null ? 'move' : 'none'
      })
      b.addEventListener('dragleave', () => {
        b.classList.remove('refused', 'drop-onto')
        b.removeAttribute('title')
      })
      b.addEventListener('drop', (e) => {
        e.preventDefault()
        const level = dragging
        dragging = null
        b.classList.remove('refused', 'drop-onto')
        if (level === null || level.startsWith(`${game.name}/`)) return
        host.onMoveLevel(level, game.name)
      })
      list.append(b)
    }

    const page = el('div', 'gw-page')
    const label = games.find((g) => g.name === picked)?.label ?? ''
    const tabs = el('div', 'gw-tabs')
    tabs.append(el('span', 'gw-page-title', label))
    // Balance only for a game that has one (ADR 0225).
    const hasBalance = picked !== null && host.balance(picked) !== null
    if (tab === 'balance' && !hasBalance) tab = 'levels'
    const shown: readonly (readonly [Tab, string])[] = [['levels', 'Levels'], ['settings', 'Settings'], ...(hasBalance ? [['balance', 'Balance'] as const] : []), ['components', 'Components']]
    for (const [id, text] of shown) {
      const b = el('button', `gw-tab${tab === id ? ' on' : ''}`, text)
      b.type = 'button'
      b.addEventListener('click', () => {
        tab = id
        // Shown again, read again: a level may have changed since.
        if (id === 'balance') balanceLevels = null
        render()
      })
      tabs.append(b)
    }
    const body = el('div', 'gw-tab-body')
    if (picked !== null) body.append(tab === 'levels' ? levelsPage(picked) : tab === 'settings' ? settingsPage(picked) : tab === 'balance' ? balancePage(picked) : componentsPage(picked))
    else body.append(el('div', 'gw-note', 'No game is installed in this build.'))
    page.append(tabs, body)

    const main = el('div', 'gw-body')
    main.append(list, page)
    box.replaceChildren(head, main)
  }

  const open = (): void => {
    if (root !== null) return
    picked = host.game()
    balanceLevels = null
    root = scrim
    document.body.append(scrim)
    window.addEventListener('keydown', onKey, true)
    render()
  }

  const close = (): void => {
    if (root === null) return
    root = null
    letGoOfSettings()
    balanceLevels = null
    scrim.remove()
    window.removeEventListener('keydown', onKey, true)
  }

  const settingsChanged = (game: string): void => {
    if (root === null || picked !== game) return
    if (tab === 'balance') rerunBalance?.()
    if (tab !== 'settings') return
    const values = host.settings(game)?.values
    if (values === undefined) return
    for (const [key, show] of settingFields) {
      const v = values[key]
      if (v !== undefined) show(v)
    }
  }

  return { open, close, isOpen: () => root !== null, render, settingsChanged }
}

import { ASSET_KINDS, buildDatabase, type AssetDatabase, type AssetEntry, type AssetKind } from '@mp/content'

import { buildTree, filterEntries, flattenTree, folderOf, gameRows, subfoldersOf, type Filter, type Place, type TreeNode } from './assetTree'

/**
 * The Project panel: every game and its levels, and a file explorer over the shared `content/assets/`.
 *
 * A tree on the left, tiles on the right, with a breadcrumb, a kind filter and a search box. The folder and
 * the kind are **independent axes**: "textures in this folder" and "every material anywhere" are both things
 * an author asks for, and the tabs this panel started with could only answer the second.
 *
 * **Games are the top of the tree** (ADR 0108). A game is a folder holding its levels, so opening a level is
 * picking it out of the tree rather than choosing a game in one dropdown and a level in another — the two
 * dropdowns this replaced, which made the game implicit in a control nowhere near the file it governed.
 *
 * A level is **not** an asset entry: nothing references a level by id, so it has no `.meta` and does not
 * belong in the asset database. It is its own row type, keyed by the qualified `<game>/<name>` that every
 * route, lock and live document already uses.
 *
 * **A preview is generated only for a tile that comes into view.** A folder of a thousand models cannot render
 * a thousand thumbnails and does not have to: an `IntersectionObserver` with a margin asks for one just before
 * its tile scrolls in, once, and the cache keeps it. That bounds the *loading* too — a model is fetched only
 * when something is about to show it.
 *
 * Every prefab is a file in a folder and a level references one by asset id (ADR 0091), so the tree is the
 * whole story: there is nothing placeable that is not a file. The pseudo-folder for a level's own prefab table
 * went with the table, as the code kit beside it went with ADR 0027.
 */
export interface ProjectHost {
  db: () => AssetDatabase | null
  /** The installed games, for the top of the tree (ADR 0108). */
  games: () => readonly { name: string; label: string }[]
  /** Every level on disk, qualified `<game>/<name>` with the game it is in. */
  levels: () => readonly { name: string; mode?: string }[]
  /** The level open right now, qualified — drawn as the selected tile. */
  openLevel: () => string
  /** Open a level by its qualified name. The editor guards unsaved work and joins its live session. */
  onOpenLevel: (qualified: string) => void
  /**
   * Author for this game from now on, without opening anything: it is what a new level is made in, and what
   * the registry is composed from while no level is open.
   */
  onPickGame: (game: string) => void
  /** Make a level in this game's folder. */
  onNewLevel: (game: string) => void
  /** Folders on disk, including the empty ones no asset path can imply. */
  folders: () => readonly string[]
  urlOf: (path: string) => string
  /** The armed prefab or model, shown pressed while it waits for a viewport click. */
  armed: () => string | null
  selectedAsset: () => string | null
  /** Arm a placeable asset (a prefab file or a model) for the next viewport click. */
  onPickAsset: (assetId: string) => void
  /**
   * Why a placeable asset cannot go into the open document, or `null` (ADR 0076). A prefab using a component
   * the open level's game lacks is shown greyed, with the reason, rather than armed and refused later.
   */
  unplaceableWhy: (assetId: string) => string | null
  /** Open a non-placeable asset in the Inspector. */
  onSelectAsset: (assetId: string) => void
  /** Make a new asset of a kind this panel can author, in `folder`. See `CREATABLE`. */
  onCreateAsset: (kind: AssetKind, folder: string) => void
  onMkdir: (parent: string, name: string) => void
  onRename: (path: string, name: string) => void
  onDelete: (path: string) => void
  /**
   * Open a context menu for a file or folder.
   *
   * The panel says *what* was right-clicked; the host decides what can be done to it, because that needs the
   * document (is this prefab open?) and the asset database (is this material referenced?), neither of which
   * belongs here.
   *
   * This replaced a `window.prompt()` in which **clearing the name deleted the file** — a folder and all its
   * contents included. A blocking dialog whose empty state is destructive is the worst interaction in the
   * editor, and it was reached by the same right-click that now opens this.
   */
  onContext: (at: { x: number; y: number }, path: string, isFolder: boolean) => void
  /** Move a file or folder into `toFolder`. */
  onMove: (from: string, toFolder: string) => void
  /** Files dragged in from outside the browser, to be uploaded into `folder` (ADR 0083). */
  onUpload: (files: readonly File[], folder: string) => void
  /**
   * Ask for a tile's picture. Called only when the tile is about to be visible, and expected to answer from
   * cache when it can — `done` may be called synchronously.
   */
  requestPreview: (
    kind: 'prefab' | 'model' | 'material' | 'shader' | 'texture',
    key: string,
    done: (url: string | null) => void,
  ) => void
}

export interface Project {
  render: () => void
  /**
   * The asset folder on screen: `''` at the assets root, `null` across all folders — and `null` while a
   * game's levels are on screen. `Save as prefab…` writes here, so navigating the panel is how the
   * destination is chosen (ADR 0091).
   */
  folder: () => string | null
  /** Show this game's levels. The editor calls it when a level opens, so the tree follows the document. */
  showGame: (game: string) => void
}

const KIND_LABEL: Record<AssetKind, string> = {
  prefab: 'Prefabs',
  texture: 'Textures',
  model: 'Models',
  material: 'Materials',
  shader: 'Shaders',
  sound: 'Sounds',
  font: 'Fonts',
}

/** Kinds a viewport click can place; everything else opens in the Inspector. */
const PLACEABLE = new Set<AssetKind>(['prefab', 'model'])
/**
 * Kinds this panel can make from nothing.
 *
 * A material and an animation clip are both authored *here* rather than imported, so an empty one is a
 * meaningful starting point. A texture or a model arrives as a file, and a prefab is made by extracting one
 * from a level as one (ADR 0091).
 */
const CREATABLE = new Set<AssetKind>(['material'])
/** Kinds with no picture worth inventing. */
const UNPREVIEWABLE = new Set<AssetKind>(['sound', 'font'])

type PreviewKind = 'prefab' | 'model' | 'material' | 'shader' | 'texture'

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== '') node.className = className
  return node
}

export const createProjectPanel = (container: HTMLElement, host: ProjectHost): Project => {
  /**
   * Where the panel is looking: inside a game, or in the asset library (ADR 0108). It starts in the library,
   * which is where it has always started, and the editor moves it to a game when a level opens.
   */
  let place: Place = { at: 'assets', folder: '' }
  /** The asset folder on screen, or `null` for every folder — and `null` while a game is on screen. */
  const folderNow = (): string | null => (place.at === 'assets' ? place.folder : null)
  let kind: AssetKind | null = null
  let search = ''
  let recursive = false
  const collapsed = new Set<string>()

  const head = el('div', 'ex-head')
  const body = el('div', 'ex-body')
  const treePane = el('div', 'ex-tree')
  const grid = el('div', 'tiles')
  const preview = el('div', 'asset-preview')
  const right = el('div', 'ex-right')
  right.append(grid, preview)
  body.append(treePane, right)
  container.append(head, body)

  /**
   * One observer for the whole grid. A tile is asked for its preview once, just before it scrolls in, then
   * unobserved — the cache answers any later redraw.
   */
  const observer = new IntersectionObserver(
    (records) => {
      for (const record of records) {
        if (!record.isIntersecting) continue
        const tile = record.target
        if (!(tile instanceof HTMLElement)) continue
        observer.unobserve(tile)
        const previewKind = tile.dataset['previewKind']
        const previewKey = tile.dataset['previewKey']
        if (previewKind === undefined || previewKey === undefined) continue
        host.requestPreview(previewKind as PreviewKind, previewKey, (url) => {
          // The tile may have been redrawn away while the preview was being made.
          if (url === null || !tile.isConnected) return
          const img = tile.querySelector('img.thumb')
          if (img instanceof HTMLImageElement) img.src = url
        })
      }
    },
    { root: grid, rootMargin: '200px' },
  )

  // --- header ---
  const crumbs = el('div', 'ex-crumbs')
  const kindSelect = el('select', 'ctl')
  for (const [value, label] of [['', 'All kinds'], ...ASSET_KINDS.map((k) => [k, KIND_LABEL[k]] as const)] as const) {
    const opt = el('option')
    opt.value = value
    opt.textContent = label
    kindSelect.append(opt)
  }
  kindSelect.addEventListener('change', () => {
    kind = kindSelect.value === '' ? null : (kindSelect.value as AssetKind)
    render()
  })

  const searchInput = el('input', 'ctl')
  searchInput.type = 'text'
  searchInput.placeholder = 'search'
  searchInput.addEventListener('input', () => {
    search = searchInput.value
    render()
  })

  const recurseBox = el('input', 'ctl')
  recurseBox.type = 'checkbox'
  recurseBox.id = 'ex-recurse'
  recurseBox.addEventListener('change', () => {
    recursive = recurseBox.checked
    render()
  })
  const recurseLabel = el('label', 'tb-label')
  recurseLabel.htmlFor = 'ex-recurse'
  recurseLabel.textContent = 'subfolders'

  const newFolderButton = el('button', 'ctl')
  newFolderButton.textContent = '+ folder'
  newFolderButton.addEventListener('click', () => {
    const name = prompt('New folder name')
    if (name !== null && name.trim() !== '') host.onMkdir(folderNow() ?? '', name.trim())
  })

  head.append(crumbs, kindSelect, searchInput, recurseBox, recurseLabel, newFolderButton)

  const goTo = (target: string | null): void => {
    place = { at: 'assets', folder: target }
    render()
  }

  const goToGame = (game: string): void => {
    place = { at: 'game', game }
    host.onPickGame(game)
    render()
  }

  const renderCrumbs = (): void => {
    crumbs.replaceChildren()
    const crumb = (label: string, target: string | null): HTMLButtonElement => {
      const b = el('button', 'ctl crumb')
      b.textContent = label
      b.addEventListener('click', () => goTo(target))
      return b
    }
    if (place.at === 'game') {
      const game = place.game
      const b = el('button', 'ctl crumb sel')
      b.textContent = game
      b.disabled = true
      crumbs.append(crumb('content', ''), b)
      return
    }
    crumbs.append(crumb('assets', ''))
    if (place.folder === null) {
      crumbs.append(crumb('(all folders)', null))
      return
    }
    let acc = ''
    for (const part of place.folder === '' ? [] : place.folder.split('/')) {
      acc = acc === '' ? part : `${acc}/${part}`
      crumbs.append(crumb(part, acc))
    }
  }

  /**
   * A drop is one of two things: a tile dragged from this panel (a move), or files dragged in from the desktop
   * (an upload). `into` may be a getter, for the grid, whose folder changes.
   */
  const dropTargetFor = (target: HTMLElement, into: string | (() => string | null)): void => {
    const folderOf = (): string | null => (typeof into === 'string' ? into : into())
    target.addEventListener('dragover', (e) => {
      if (folderOf() === null) return
      e.preventDefault()
      target.classList.add('drop-onto')
    })
    target.addEventListener('dragleave', () => target.classList.remove('drop-onto'))
    target.addEventListener('drop', (e) => {
      const dest = folderOf()
      if (dest === null) return
      e.preventDefault()
      e.stopPropagation()
      target.classList.remove('drop-onto')
      const files = [...(e.dataTransfer?.files ?? [])]
      if (files.length > 0) {
        host.onUpload(files, dest)
        return
      }
      const from = e.dataTransfer?.getData('text/plain')
      if (from !== undefined && from !== '') host.onMove(from, dest)
    })
  }
  // The grid itself takes desktop drops for the folder being looked at; not for "all folders" or the level's own.
  dropTargetFor(grid, () => folderNow())

  /**
   * The games, each with its levels under it (ADR 0108). Above the asset library, because this is what an
   * author opens the panel to do; the library is where they go to fetch something to put in it.
   */
  const renderGames = (): void => {
    for (const game of gameRows(host.games(), host.levels())) {
      const key = `game:${game.name}`
      const on = place.at === 'game' && place.game === game.name
      const row = el('div', `row${on ? ' sel' : ''}`)
      row.style.paddingLeft = '6px'
      const twist = el('span', 'twist')
      twist.textContent = game.levels.length === 0 ? '' : collapsed.has(key) ? '\u25b8' : '\u25be'
      if (game.levels.length > 0) {
        twist.addEventListener('click', (e) => {
          e.stopPropagation()
          if (collapsed.has(key)) collapsed.delete(key)
          else collapsed.add(key)
          render()
        })
      }
      const name = el('span', 'name')
      name.textContent = game.label
      const count = el('span', 'badge')
      count.textContent = String(game.levels.length)
      row.append(twist, name, count)
      row.title = `${game.name} \u2014 content/${game.name}/`
      row.addEventListener('click', () => goToGame(game.name))
      treePane.append(row)

      if (collapsed.has(key)) continue
      for (const level of game.levels) {
        const lr = el('div', `row${host.openLevel() === level.qualified ? ' sel' : ''}`)
        lr.style.paddingLeft = '30px'
        const lname = el('span', 'name')
        lname.textContent = level.name
        lr.append(el('span', 'twist'), lname)
        lr.title = level.qualified
        // One click opens: a level is the thing this panel is for, and a second gesture to confirm was the
        // dropdown's behaviour, not an improvement on it.
        lr.addEventListener('click', () => host.onOpenLevel(level.qualified))
        treePane.append(lr)
      }
    }
  }

  const renderTree = (root: TreeNode): void => {
    treePane.replaceChildren()
    renderGames()

    for (const node of flattenTree(root, collapsed)) {
      const row = el('div', `row${folderNow() === node.path ? ' sel' : ''}`)
      row.style.paddingLeft = `${6 + node.depth * 12}px`

      const twist = el('span', 'twist')
      twist.textContent = node.children.length > 0 ? (collapsed.has(node.path) ? '▸' : '▾') : ''
      if (node.children.length > 0) {
        twist.addEventListener('click', (e) => {
          e.stopPropagation()
          if (collapsed.has(node.path)) collapsed.delete(node.path)
          else collapsed.add(node.path)
          render()
        })
      }
      const name = el('span', 'name')
      name.textContent = node.name
      const count = el('span', 'badge')
      count.textContent = String(node.fileCount)
      row.append(twist, name, count)
      row.addEventListener('click', () => goTo(node.path))
      dropTargetFor(row, node.path)
      treePane.append(row)
    }

    const all = el('div', `row${folderNow() === null ? ' sel' : ''}`)
    const allName = el('span', 'name')
    allName.textContent = 'All folders'
    all.append(el('span', 'twist'), allName)
    all.addEventListener('click', () => goTo(null))
    treePane.append(all)
  }

  const tile = (label: string, title: string, on: boolean, previewKind: PreviewKind | null, previewKey: string): HTMLButtonElement => {
    const b = el('button', `ctl tile${on ? ' armed' : ''}${previewKind !== null ? ' has-thumb' : ''}`)
    b.title = title
    if (previewKind !== null) {
      // The <img> is created empty on purpose: the observer fills its src when the tile nears the viewport,
      // so a thousand tiles cost a thousand empty boxes rather than a thousand renders.
      const img = el('img', 'thumb')
      img.alt = ''
      b.append(img)
      b.dataset['previewKind'] = previewKind
      b.dataset['previewKey'] = previewKey
    }
    const text = el('span', 'tile-name')
    text.textContent = label
    b.append(text)
    return b
  }

  /** Right-click hands the point and the target to the host, which owns the menu. */
  const contextMenu = (target: HTMLElement, path: string, isFolder: boolean): void => {
    target.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation() // a tile's menu, not the panel's
      host.onContext({ x: e.clientX, y: e.clientY }, path, isFolder)
    })
  }

  const draggable = (target: HTMLElement, path: string): void => {
    target.draggable = true
    target.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', path)
      if (e.dataTransfer !== null) e.dataTransfer.effectAllowed = 'move'
    })
  }

  /** Audition a sound, sample a font, enlarge a texture. */
  const showPreview = (entry: AssetEntry): void => {
    preview.replaceChildren()
    const url = host.urlOf(entry.path)

    if (entry.kind === 'texture') {
      const img = el('img')
      img.src = url
      img.alt = entry.name
      preview.append(img)
    } else if (entry.kind === 'sound') {
      const audio = el('audio')
      audio.src = url
      audio.controls = true
      audio.autoplay = true
      preview.append(audio)
    } else if (entry.kind === 'font') {
      const family = `preview-${entry.id}`
      const sample = el('div', 'font-sample')
      sample.textContent = 'The quick brown fox 0123456789'
      sample.style.fontFamily = `"${family}", system-ui, sans-serif`
      preview.append(sample)
      // Loaded rather than declared, so a font that fails says so instead of silently using the UI font.
      void new FontFace(family, `url(${url})`)
        .load()
        .then((face) => void document.fonts.add(face))
        .catch(() => (sample.textContent = `${entry.name}: could not be loaded`))
    }

    const caption = el('div', 'caption')
    caption.textContent = entry.path
    preview.append(caption)
  }

  const empty = (text: string): HTMLDivElement => {
    const d = el('div', 'empty')
    d.textContent = text
    return d
  }

  const render = (): void => {
    const db = host.db() ?? buildDatabase([])
    const root = buildTree(db, host.folders())

    kindSelect.value = kind ?? ''
    recurseBox.checked = recursive
    if (document.activeElement !== searchInput) searchInput.value = search
    const folder = folderNow()
    newFolderButton.disabled = folder === null
    kindSelect.disabled = place.at === 'game'
    renderCrumbs()
    renderTree(root)

    // Every tile is about to be replaced, so the old observations are meaningless.
    observer.disconnect()
    grid.replaceChildren()

    // A game's levels, as tiles, plus where a new one is made (ADR 0108).
    if (place.at === 'game') {
      const game = place.game
      const rows = gameRows(host.games(), host.levels()).find((g) => g.name === game)
      const b = el('button', 'ctl tile new')
      b.textContent = '+ new level'
      b.title = `a new level in content/${game}/levels/`
      b.addEventListener('click', () => host.onNewLevel(game))
      grid.append(b)
      for (const level of rows?.levels ?? []) {
        const t = el('button', `ctl tile${host.openLevel() === level.qualified ? ' armed' : ''}`)
        t.title = level.qualified
        const text = el('span', 'tile-name')
        text.textContent = level.name
        t.append(text)
        t.addEventListener('click', () => host.onOpenLevel(level.qualified))
        grid.append(t)
      }
      if (rows === undefined || rows.levels.length === 0) grid.append(empty(`${game} has no levels yet`))
      return
    }

    // Subfolders as tiles, so going down a level does not mean crossing to the tree.
    if (folder !== null && search === '') {
      for (const node of subfoldersOf(root, folder)) {
        const t = el('button', 'ctl tile folder')
        t.textContent = `▸ ${node.name}`
        t.title = node.path
        t.addEventListener('click', () => goTo(node.path))
        dropTargetFor(t, node.path)
        draggable(t, node.path)
        contextMenu(t, node.path, true)
        grid.append(t)
      }
    }

    // Only on a single kind's tab and inside a real folder: "new" needs to know what to make and where.
    if (kind !== null && CREATABLE.has(kind) && folder !== null) {
      const target = folder
      const making = kind
      const b = el('button', 'ctl tile new')
      b.textContent = `+ new ${kind}`
      b.addEventListener('click', () => host.onCreateAsset(making, target))
      grid.append(b)
    }

    const filter: Filter = { folder, kind, search, recursive }
    const entries = filterEntries(db, filter)
    if (entries.length === 0 && grid.children.length === 0) {
      grid.append(empty(folder === null ? 'nothing matches' : `nothing in ${folder === '' ? 'assets' : folder}`))
      return
    }

    for (const entry of entries) {
      const placeable = PLACEABLE.has(entry.kind)
      const on = placeable ? host.armed() === entry.id : host.selectedAsset() === entry.id
      const previewKind = UNPREVIEWABLE.has(entry.kind) ? null : (entry.kind as PreviewKind)
      // Showing more than one folder's worth means the name alone is ambiguous.
      const label = folder === null || recursive ? `${folderOf(entry.path)}/${entry.name}`.replace(/^\//, '') : entry.name
      const why = placeable ? host.unplaceableWhy(entry.id) : null
      const t = tile(label, why === null ? entry.path : `${entry.path} — ${why}`, on, previewKind, entry.id)
      // Greyed rather than hidden: the file exists and is worth seeing; it is this game it cannot go into.
      if (why !== null) t.classList.add('foreign')
      t.addEventListener('click', () => {
        if (why !== null) return
        if (placeable) host.onPickAsset(entry.id)
        else {
          host.onSelectAsset(entry.id)
          showPreview(entry)
        }
      })
      draggable(t, entry.path)
      contextMenu(t, entry.path, false)
      grid.append(t)
      if (previewKind !== null) observer.observe(t)
    }
  }

  render()
  return { render, folder: folderNow, showGame: (game) => goToGame(game) }
}

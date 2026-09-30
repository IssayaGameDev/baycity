import { icon, type IconName } from './icons'

/**
 * A searchable tree for choosing one thing (ADR 0178): folders that open and shut, and what can be chosen inside
 * them. The reference fields' picker lays objects out as the Hierarchy does and assets by their folders; Add
 * Component groups components by their menu folder — Unity's pickers and its Add Component menu. A search lists
 * every match flat, with where it is in grey; Enter takes the first.
 */
export interface TreeItem {
  readonly key: string
  readonly label: string
  readonly icon?: IconName
  /** Grey text after the name: `adds to game`. */
  readonly hint?: string
  /** Whether choosing it means anything. A folder, or an object out of reach, only opens. */
  readonly pickable: boolean
  readonly children?: readonly TreeItem[]
}

export interface TreePickerOptions {
  readonly items: readonly TreeItem[]
  /** A first row that picks nothing — `None` — or absent where there is no none (Add Component). */
  readonly none?: string
  readonly pick: (key: string | null) => void
  /** What is chosen now: lit, and every folder above it open. */
  readonly current?: string | null
  /** Every folder open from the start, for a short list; otherwise only the way to `current`. */
  readonly openAll?: boolean
}

export interface TreePicker {
  readonly root: HTMLElement
  /** Put the keyboard in the search box. */
  readonly focus: () => void
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Left padding of a row, and how far each level indents it. */
const BASE = 6
const INDENT = 14

/**
 * Flat entries with a folder path each, as a tree of folders: a folder's key is `folder:` and its path, it opens
 * and shuts, and folders and entries keep the order they first appear in.
 */
export const folderTree = (
  entries: readonly { readonly key: string; readonly label: string; readonly icon?: IconName; readonly hint?: string; readonly folders: readonly string[] }[],
): TreeItem[] => {
  interface Folder {
    key: string
    label: string
    kids: (Folder | TreeItem)[]
  }
  const top: (Folder | TreeItem)[] = []
  const folders = new Map<string, Folder>()
  const isFolder = (x: Folder | TreeItem): x is Folder => 'kids' in x
  for (const e of entries) {
    let into = top
    let path = ''
    for (const name of e.folders) {
      path = path === '' ? name : `${path}/${name}`
      let f = folders.get(path)
      if (f === undefined) {
        f = { key: `folder:${path}`, label: name, kids: [] }
        folders.set(path, f)
        into.push(f)
      }
      into = f.kids
    }
    into.push({ key: e.key, label: e.label, pickable: true, ...(e.icon === undefined ? {} : { icon: e.icon }), ...(e.hint === undefined ? {} : { hint: e.hint }) })
  }
  const out = (x: Folder | TreeItem): TreeItem => (isFolder(x) ? { key: x.key, label: x.label, icon: 'folder', pickable: false, children: x.kids.map(out) } : x)
  return top.map(out)
}

export const treePicker = (o: TreePickerOptions): TreePicker => {
  const root = el('div', 'tp')
  const search = el('input', 'txt tp-search')
  search.type = 'text'
  search.spellcheck = false
  search.placeholder = 'Search'
  const rows = el('div', 'tp-rows')
  root.append(search, rows)

  /** Every item with the labels of the folders above it, for the search and for opening the way to one. */
  const all: { item: TreeItem; path: readonly TreeItem[] }[] = []
  const walk = (items: readonly TreeItem[], path: readonly TreeItem[]): void => {
    for (const item of items) {
      all.push({ item, path })
      if (item.children !== undefined) walk(item.children, [...path, item])
    }
  }
  walk(o.items, [])

  const open = new Set<string>()
  if (o.openAll === true) for (const { item } of all) if (item.children !== undefined) open.add(item.key)
  const here = all.find((x) => x.item.key === o.current)
  for (const up of here?.path ?? []) open.add(up.key)

  const row = (item: TreeItem | null, depth: number, where?: string): HTMLButtonElement => {
    const b = el('button', 'tp-row')
    b.type = 'button'
    b.style.paddingLeft = `${BASE + depth * INDENT}px`
    const branch = item?.children !== undefined && item.children.length > 0
    const twist = el('span', 'tp-tw')
    if (branch && where === undefined) {
      twist.append(icon('chevron'))
      twist.classList.toggle('open', open.has(item.key))
    }
    b.append(twist)
    if (item?.icon !== undefined) b.append(icon(item.icon))
    b.append(el('span', 'tp-t', item === null ? (o.none ?? 'None') : item.label))
    if (item?.hint !== undefined) b.append(el('span', 'tp-hint', item.hint))
    if (where !== undefined && where !== '') b.append(el('span', 'tp-hint', where))
    if (item !== null && item.key === o.current) b.classList.add('on')
    if (item !== null && !item.pickable) b.classList.add('tp-folder')
    const toggle = (): void => {
      if (item === null) return
      if (open.has(item.key)) open.delete(item.key)
      else open.add(item.key)
      draw()
    }
    twist.addEventListener('click', (e) => {
      if (!branch || where !== undefined) return
      e.stopPropagation()
      toggle()
    })
    b.addEventListener('click', () => {
      if (item === null) return o.pick(null)
      if (item.pickable) return o.pick(item.key)
      if (branch) toggle()
    })
    return b
  }

  const draw = (): void => {
    rows.replaceChildren()
    const q = search.value.trim().toLowerCase()
    if (q !== '') {
      const hits = all.filter(({ item }) => item.pickable && item.label.toLowerCase().includes(q))
      for (const { item, path } of hits) rows.append(row(item, 0, path.map((p) => p.label).join(' › ')))
      if (hits.length === 0) rows.append(el('div', 'tp-empty', 'nothing matches'))
      return
    }
    if (o.none !== undefined) rows.append(row(null, 0))
    const down = (items: readonly TreeItem[], depth: number): void => {
      for (const item of items) {
        rows.append(row(item, depth))
        if (item.children !== undefined && open.has(item.key)) down(item.children, depth + 1)
      }
    }
    down(o.items, 0)
    if (o.items.length === 0) rows.append(el('div', 'tp-empty', 'nothing here'))
  }

  search.addEventListener('input', draw)
  // Enter takes the first match, as a search box in a picker does.
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || search.value.trim() === '') return
    e.preventDefault()
    rows.querySelector<HTMLButtonElement>('.tp-row:not(.tp-folder)')?.click()
  })
  draw()
  // The lit row on screen, once the panel is placed.
  requestAnimationFrame(() => rows.querySelector('.tp-row.on')?.scrollIntoView({ block: 'nearest' }))
  return { root, focus: () => search.focus() }
}

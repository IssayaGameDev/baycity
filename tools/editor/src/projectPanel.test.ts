// @vitest-environment happy-dom
import { buildDatabase, nameForPath, type AssetEntry, type AssetKind } from '@mp/content'
import { beforeEach, describe, expect, it } from 'vitest'

import type { MenuItem } from './menu'
import { createProjectPanel, SIZE, type ProjectHost } from './projectPanel'

/**
 * The Project window (ADR 0163): two roots, the open game's library and Shared; folders only in the tree; one tile
 * for everything; going in by a double-click and up by the path; a search looking in every folder of both.
 */

const entry = (path: string, kind: AssetKind): AssetEntry => ({ id: `id-${path}`, kind, path, name: nameForPath(path) })

const DB = buildDatabase([
  entry('assets/materials/brick.mat.json', 'material'),
  entry('assets/materials/red.mat.json', 'material'),
  entry('assets/prefabs/pad.prefab.json', 'prefab'),
  entry('assets/textures/stone/brick.png', 'texture'),
  entry('assets/sounds/click.ogg', 'sound'),
  entry('keyboard/assets/materials/key.mat.json', 'material'),
])

// happy-dom has no IntersectionObserver: previews are the host's, and nothing here scrolls.
beforeEach(() => {
  if (!('IntersectionObserver' in globalThis)) {
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    })
  }
  try {
    localStorage.clear()
  } catch {
    // none
  }
})

const rig = (over: Partial<ProjectHost> = {}) => {
  document.body.replaceChildren()
  const container = document.createElement('div')
  document.body.append(container)
  const calls: string[] = []
  let menu: readonly MenuItem[] = []
  let dragged: readonly string[] = []
  const host: ProjectHost = {
    db: () => DB,
    game: () => ({ name: 'keyboard', label: 'Keyboard' }),
    folders: () => ['assets/empty'],
    menu: {
      open: (_at, items) => void (menu = items),
      close: () => {},
      isOpen: () => false,
    },
    selectedAsset: () => null,
    openers: (id) => (id === 'id-assets/materials/red.mat.json' ? [{ name: 'Ana Lima', colour: '#f00' }] : []),
    unplaceableWhy: () => null,
    onSelectAsset: (id) => calls.push(`select ${id}`),
    onOpenPrefab: (id) => calls.push(`open ${id}`),
    onDragAsset: (id) => calls.push(`drag ${id ?? 'over'}`),
    onDragAssets: (ids) => void (dragged = ids),
    dataTypes: (folder) => (folder.startsWith('keyboard/') ? [{ type: 'KeyboardStyle', path: ['Keyboard', 'Keyboard Style'] }] : []),
    onCreateData: (type, folder) => calls.push(`new data ${type} in ${folder}`),
    onCreateAsset: (kind, folder) => calls.push(`new ${kind} in ${folder}`),
    onMkdir: (parent, name) => calls.push(`mkdir ${name} in ${parent}`),
    onContext: () => {},
    onMove: (froms, to) => calls.push(`move ${froms.join(' ')} to ${to}`),
    onDelete: (paths) => calls.push(`delete ${paths.join(' ')}`),
    onRename: (path) => calls.push(`rename ${path}`),
    fileOf: (path) => (path.endsWith('red.mat.json') ? { bytes: 1, modified: 2000 } : path.endsWith('brick.mat.json') ? { bytes: 1, modified: 1000 } : undefined),
    onUpload: (files, to) => calls.push(`upload ${files.map((f) => f.name).join(' ')} to ${to}`),
    requestPreview: () => {},
    ...over,
  }
  const project = createProjectPanel(container, host)
  const $$ = (sel: string): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(sel)]
  const tiles = (): string[] => $$('.ex-grid .pt .pt-name').map((n) => n.textContent ?? '')
  const tree = (): string[] => $$('.ex-tree .row').map((r) => r.querySelector('.name')!.textContent ?? '')
  const crumbs = (): string[] => $$('.ex-crumbs > *').map((c) => c.textContent ?? '')
  const tile = (name: string): HTMLElement => $$('.ex-grid .pt').find((t) => t.querySelector('.pt-name')?.textContent === name)!
  return { project, host, calls, $$, tiles, tree, crumbs, tile, menu: () => menu, container, dragged: () => dragged }
}

describe('the Project window', () => {
  it('has two roots, the game’s own then Shared, with folders only in the tree: an arrow only over subfolders, no counts', () => {
    const { tree, $$ } = rig()
    expect(tree()).toEqual(['Keyboard', 'materials', 'Shared', 'empty', 'materials', 'prefabs', 'sounds', 'textures', 'stone'])
    const rows = $$('.ex-tree .row')
    expect(rows.every((r) => r.querySelector('svg.ico') !== null), 'a folder icon on every row').toBe(true)
    const arrows = rows.map((r) => r.querySelector('.twist svg') !== null)
    expect(arrows).toEqual([true, false, true, false, false, false, false, true, false])
    expect($$('.ex-tree .badge')).toEqual([])
  })

  it('shows a folder’s subfolders then its files as tiles, goes in on a double-click, and back up by the path', () => {
    const { tiles, crumbs, tile, $$, project } = rig()
    expect(crumbs()).toEqual(['Shared'])
    expect(tiles()).toEqual(['empty', 'materials', 'prefabs', 'sounds', 'textures'])
    tile('textures').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(tiles(), 'a click only selects').toEqual(['empty', 'materials', 'prefabs', 'sounds', 'textures'])
    expect($$('.ex-foot-path')[0]!.textContent).toBe('Shared/textures')
    tile('textures').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(crumbs()).toEqual(['Shared', '›', 'textures'])
    expect(tiles()).toEqual(['stone'])
    tile('stone').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(tiles()).toEqual(['brick'])
    expect(project.folder()).toBe('assets/textures/stone')
    $$('.ex-crumb')[0]!.click()
    expect(project.folder()).toBe('assets')
    expect($$('.ex-tree .row.sel .name').map((n) => n.textContent)).toEqual(['Shared'])
  })

  it('goes to a folder clicked in the tree, and says so when it is empty', () => {
    const { $$, tiles, crumbs } = rig()
    $$('.ex-tree .row').find((r) => r.textContent === 'Keyboard')!.click()
    expect(crumbs()).toEqual(['Keyboard'])
    expect(tiles()).toEqual(['materials'])
    $$('.ex-tree .row').find((r) => r.textContent === 'empty')!.click()
    expect($$('.ex-grid .empty')[0]!.textContent).toBe('Shared/empty is empty')
  })

  it('searches every folder of both roots, by name and by kind, and stops on the ×', () => {
    const { $$, tiles, crumbs, menu } = rig()
    const input = $$('.ex-search-in')[0] as HTMLInputElement
    input.value = 'bri'
    input.dispatchEvent(new Event('input'))
    expect(crumbs()).toEqual(['Every folder'])
    expect(tiles()).toEqual(['brick', 'brick'])
    input.value = ''
    input.dispatchEvent(new Event('input'))
    $$('.ex-kind')[0]!.click()
    expect(menu().map((i) => i.label)[0]).toBe('All kinds')
    menu().find((i) => i.label === 'Materials')!.run!()
    expect(tiles(), 'a kind alone is a search too').toEqual(['brick', 'key', 'red'])
    expect($$('.ex-kind')[0]!.textContent).toBe('Materials')
    $$('.ex-search-x')[0]!.click()
    expect(crumbs()).toEqual(['Shared'])
  })

  it('makes a folder or a material in the folder you are in, from the + menu', async () => {
    const { $$, calls, menu, tile } = rig()
    tile('materials').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    $$('.ex-plus')[0]!.click()
    expect(menu().map((i) => i.label)).toEqual(['New folder…', 'New material', 'New data', 'Upload files…'])
    menu().find((i) => i.label === 'New material')!.run!()
    expect(calls).toEqual(['new material in assets/materials'])
    // Shared holds no data (ADR 0181): the entry is there, greyed, with why.
    const data = menu().find((i) => i.label === 'New data')!
    expect(data.enabled).toBe(false)
    expect(data.why).toBe('data belongs to a game: open a game’s library')
  })

  // Unity's CreateAssetMenu (ADR 0181): each type at its menu path, in the game's library.
  it('makes a data asset of one of the game’s types, by its menu path, in the game’s library', () => {
    const { $$, calls, menu } = rig()
    $$('.ex-tree .row').find((r) => r.textContent === 'Keyboard')!.click()
    $$('.ex-plus')[0]!.click()
    const data = menu().find((i) => i.label === 'New data')!
    expect(data.items!.map((i) => i.label)).toEqual(['Keyboard'])
    const style = data.items![0]!.items!.find((i) => i.label === 'Keyboard Style')!
    style.run!()
    expect(calls).toEqual(['new data KeyboardStyle in keyboard/assets'])
  })

  it('opens a file on a click, names it in the bottom bar, and shows who has it open', () => {
    const { calls, tile, $$ } = rig()
    tile('materials').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    tile('red').click()
    expect(calls).toEqual(['select id-assets/materials/red.mat.json'])
    expect($$('.ex-foot-path')[0]!.textContent).toBe('Shared/materials/red.mat.json')
    const face = tile('red').querySelector('.pt-people .pp')!
    expect(face.textContent).toBe('AL')
    expect(face.getAttribute('title')).toBe('Ana Lima has this open')
  })

  it('selects a prefab on a click, opens it on a double-click, and says when it is dragged — the Unity way', () => {
    const { calls, tile } = rig()
    tile('prefabs').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    tile('pad').click()
    tile('pad').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    tile('pad').dispatchEvent(new Event('dragstart', { bubbles: true }))
    tile('pad').dispatchEvent(new Event('dragend', { bubbles: true }))
    expect(calls).toEqual(['select id-assets/prefabs/pad.prefab.json', 'open id-assets/prefabs/pad.prefab.json', 'drag id-assets/prefabs/pad.prefab.json', 'drag over'])
  })

  it('selects one that cannot go into this game too, greyed with why, and still lets it be dragged', () => {
    const { calls, tile } = rig({ unplaceableWhy: () => 'uses Treadmill, which this game does not have' })
    tile('prefabs').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(tile('pad').classList.contains('foreign')).toBe(true)
    expect(tile('pad').title).toBe('Shared/prefabs/pad.prefab.json — uses Treadmill, which this game does not have')
    tile('pad').click()
    expect(calls).toEqual(['select id-assets/prefabs/pad.prefab.json'])
  })

  it('turns into a one-line list at the slider’s smallest, and remembers the size', () => {
    const { $$ } = rig()
    const slider = $$('.ex-size')[0] as HTMLInputElement
    expect(slider.value).toBe(String(SIZE.start))
    slider.value = String(SIZE.min)
    slider.dispatchEvent(new Event('input'))
    expect($$('.ex-grid')[0]!.classList.contains('list')).toBe(true)
    const again = rig()
    expect((again.$$('.ex-size')[0] as HTMLInputElement).value).toBe(String(SIZE.min))
  })

  it('goes to a file the Inspector names, and names it in the bottom bar', () => {
    const { project, crumbs, $$ } = rig()
    project.reveal('assets/textures/stone/brick.png')
    expect(crumbs()).toEqual(['Shared', '›', 'textures', '›', 'stone'])
    expect($$('.ex-foot-path')[0]!.textContent).toBe('Shared/textures/stone/brick.png')
    expect(project.named('keyboard/assets/materials/key.mat.json')).toBe('Keyboard/materials/key.mat.json')
  })

  it('selects several with Ctrl and Shift, the Inspector showing the last, and says how many', () => {
    const { tile, calls, $$ } = rig()
    tile('materials').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    tile('brick').click()
    tile('red').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    expect($$('.pt.on .pt-name').map((n) => n.textContent)).toEqual(['brick', 'red'])
    expect($$('.ex-foot-path')[0]!.textContent).toBe('2 items selected')
    expect(calls).toEqual(['select id-assets/materials/brick.mat.json', 'select id-assets/materials/red.mat.json'])
    tile('brick').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    expect($$('.pt.on .pt-name').map((n) => n.textContent)).toEqual(['red'])
    const up = rig()
    up.tile('empty').click()
    up.tile('sounds').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    expect(up.$$('.pt.on .pt-name').map((n) => n.textContent)).toEqual(['empty', 'materials', 'prefabs', 'sounds'])
  })

  it('drags all of what is selected into a folder, and one not selected alone', () => {
    const { tile, calls } = rig()
    const carrier = () => {
      const data = new Map<string, string>()
      return { setData: (t: string, v: string) => void data.set(t, v), getData: (t: string) => data.get(t) ?? '', files: [], effectAllowed: '', dropEffect: '' }
    }
    const drag = (from: HTMLElement, onto: HTMLElement): void => {
      const dt = carrier()
      from.dispatchEvent(Object.assign(new Event('dragstart', { bubbles: true }), { dataTransfer: dt }))
      onto.dispatchEvent(Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: dt }))
    }
    tile('prefabs').click()
    tile('sounds').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    drag(tile('sounds'), tile('textures'))
    drag(tile('materials'), tile('textures'))
    expect(calls.filter((c) => c.startsWith('move'))).toEqual(['move assets/prefabs assets/sounds to assets/textures', 'move assets/materials to assets/textures'])
  })

  // So the Inspector keeps showing the object whose reference field the tile is being dragged onto (ADR 0176).
  it('drags a tile that is not selected without selecting it, and says what a drag carries', () => {
    const { tile, calls, dragged } = rig()
    tile('materials').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    tile('red').dispatchEvent(new Event('dragstart', { bubbles: true }))
    expect(dragged()).toEqual(['id-assets/materials/red.mat.json'])
    expect(calls, 'nothing selected').toEqual([])
    tile('red').dispatchEvent(new Event('dragend', { bubbles: true }))
    expect(dragged()).toEqual([])
  })

  it('uploads files dragged in from outside, and never a picture dragged within the page', () => {
    const { tile, calls } = rig()
    const png = new File(['x'], 'download.png', { type: 'image/png' })
    const drop = (onto: HTMLElement): void =>
      void onto.dispatchEvent(Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: { files: [png], getData: () => '' } }))
    // A tile's thumbnail, dragged on its own: the browser hands it over as a file.
    tile('textures').dispatchEvent(new Event('dragstart', { bubbles: true }))
    drop(tile('materials'))
    expect(calls, 'nothing uploaded, nothing moved').toEqual([])
    document.dispatchEvent(new Event('dragend'))
    drop(tile('materials'))
    expect(calls).toEqual(['upload download.png to assets/materials'])
  })

  it('takes Unity’s keys while it has the focus, and keeps them from the level behind', () => {
    const { tile, calls, $$, crumbs, project } = rig()
    let reached = 0
    const behind = (): void => void reached++
    window.addEventListener('keydown', behind)
    const press = (key: string, extra: KeyboardEventInit = {}): void => void document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }))
    tile('empty').click()
    tile('empty').focus()
    press('ArrowRight')
    expect($$('.pt.on .pt-name').map((n) => n.textContent)).toEqual(['materials'])
    press('Enter')
    expect(crumbs()).toEqual(['Shared', '›', 'materials'])
    press('ArrowRight')
    press('F2')
    press('Delete')
    press('a', { ctrlKey: true })
    expect($$('.pt.on .pt-name').map((n) => n.textContent)).toEqual(['brick', 'red'])
    press('Backspace')
    expect(project.folder()).toBe('assets')
    expect($$('.pt.on .pt-name').map((n) => n.textContent), 'the folder it left, selected').toEqual(['materials'])
    expect(calls.filter((c) => !c.startsWith('select'))).toEqual(['rename assets/materials/brick.mat.json', 'delete assets/materials/brick.mat.json'])
    expect(reached, 'none of them reached the level').toBe(0)
    const input = $$('.ex-search-in')[0] as HTMLInputElement
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }))
    expect(reached, 'typing in the search box is the search box’s').toBe(1)
    window.removeEventListener('keydown', behind)
  })

  it('sorts by name, kind or date, folders first, and remembers it', () => {
    const { tile, tiles, $$, menu } = rig()
    tile('materials').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(tiles()).toEqual(['brick', 'red'])
    $$('.ex-sort')[0]!.click()
    expect(menu().map((i) => i.label)).toEqual(['Name', 'Kind', 'Date changed'])
    menu().find((i) => i.label === 'Date changed')!.run!()
    expect(tiles(), 'the newest first').toEqual(['red', 'brick'])
    expect($$('.ex-sort')[0]!.textContent).toBe('Date changed')
    expect(rig().$$('.ex-sort')[0]!.textContent, 'remembered').toBe('Date changed')
  })

  it('leaves a folder that is gone for the nearest one still there', () => {
    let db = DB
    const { tile, project, crumbs } = rig({ db: () => db })
    tile('textures').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    tile('stone').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    db = buildDatabase(DB.entries.filter((e) => !e.path.startsWith('assets/textures/')))
    project.render()
    expect(crumbs()).toEqual(['Shared'])
  })
})

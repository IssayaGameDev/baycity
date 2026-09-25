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
  const host: ProjectHost = {
    db: () => DB,
    game: () => ({ name: 'keyboard', label: 'Keyboard' }),
    folders: () => ['assets/empty'],
    urlOf: (p) => `/content/${p}`,
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
    onCreateAsset: (kind, folder) => calls.push(`new ${kind} in ${folder}`),
    onMkdir: (parent, name) => calls.push(`mkdir ${name} in ${parent}`),
    onContext: () => {},
    onMove: (from, to) => calls.push(`move ${from} to ${to}`),
    onUpload: () => {},
    requestPreview: () => {},
    ...over,
  }
  const project = createProjectPanel(container, host)
  const $$ = (sel: string): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(sel)]
  const tiles = (): string[] => $$('.ex-grid .pt .pt-name').map((n) => n.textContent ?? '')
  const tree = (): string[] => $$('.ex-tree .row').map((r) => r.querySelector('.name')!.textContent ?? '')
  const crumbs = (): string[] => $$('.ex-crumbs > *').map((c) => c.textContent ?? '')
  const tile = (name: string): HTMLElement => $$('.ex-grid .pt').find((t) => t.querySelector('.pt-name')?.textContent === name)!
  return { project, host, calls, $$, tiles, tree, crumbs, tile, menu: () => menu, container }
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
    expect(menu().map((i) => i.label)).toEqual(['New folder…', 'New material', 'Upload files…'])
    menu().find((i) => i.label === 'New material')!.run!()
    expect(calls).toEqual(['new material in assets/materials'])
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

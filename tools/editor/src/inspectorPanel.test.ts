// @vitest-environment happy-dom
import { COLLIDER, RENDERER, type ComponentData, type Node } from '@mp/content'
import { vec3, type Vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import { levelDoc, type Doc } from './editorDoc'
import { createInspector, type InspectorHost, type TransformValues } from './inspector'
import type { MenuItem } from './menu'

/**
 * What the Inspector draws (ADR 0152): a card per component with its icon, every field ours, a drag that
 * writes as it goes and is one history entry, the prefab bar, and nothing at the bottom but Add Component.
 */

const comp = (id: string, type: string, params: Record<string, unknown> = {}): ComponentData => ({ id, type, params })
const node = (id: string, components: ComponentData[], children: Node[] = []): Node => ({
  id,
  name: id,
  transform: { position: vec3(0, 0, 0) },
  components,
  ...(children.length === 0 ? {} : { children }),
})
const box = (id: string, center: Vec3): Node =>
  node(id, [comp(`${id}-col`, COLLIDER, { shape: { kind: 'box', halfExtents: vec3(1, 1, 1) }, center }), comp(`${id}-vis`, RENDERER, { material: '' })])
const TOWER: Node = node('root', [], [box('slab', vec3(0, 0, 0))])
const TOWER_ID = 't'.repeat(16)

interface Rig {
  readonly head: HTMLElement
  readonly panel: HTMLElement
  readonly sync: () => void
  readonly refresh: () => void
  readonly t: { current: TransformValues }
  readonly calls: { begins: number; drags: string[]; transforms: TransformValues[]; menus: { items: readonly MenuItem[]; title: string }[] }
}

const rig = (doc: Doc, selection: readonly number[], transform: Partial<TransformValues> = {}): Rig => {
  const head = document.createElement('div')
  const panel = document.createElement('div')
  document.body.replaceChildren(head, panel)
  const t = { current: { position: vec3(0, 26.68, 48.18), rotationDeg: vec3(-15.9, 0, 0), scale: vec3(10, 10, 10), ...transform } }
  const calls: Rig['calls'] = { begins: 0, drags: [], transforms: [], menus: [] }
  const host: InspectorHost = {
    doc: () => doc,
    adoptable: () => [],
    adopt: async () => {},
    selected: () => selection.at(-1) ?? null,
    envSelected: () => false,
    levelSelected: () => false,
    onEnvironmentChanged: () => {},
    onSetEnabled: () => {},
    boundsBoxShown: () => false,
    showBoundsBox: () => {},
    onNetBoundsChanged: () => {},
    boundsReach: () => null,
    selectionCount: () => selection.length,
    selectionIndices: () => selection,
    readTransform: () => t.current,
    writeTransform: (v) => void calls.transforms.push(structuredClone(v)),
    selectionTransforms: () => selection.map(() => t.current),
    writeAxis: () => {},
    beginDrag: () => void calls.begins++,
    endDrag: (label) => void calls.drags.push(label),
    onPropsChanged: () => {},
    onRenamed: () => {},
    prefabName: (id) => (id === TOWER_ID ? 'Tower' : null),
    openPrefab: () => {},
    assetOptions: () => ({ '(none)': '' }),
    revertOverride: () => {},
    unlinkPrefab: () => {},
    applyOverrides: () => {},
    revertPlacement: () => {},
    applyPlacementOverrides: async () => {},
    menu: { open: (_at, items, title) => void calls.menus.push({ items, title: title ?? '' }), close: () => {}, isOpen: () => false },
    pointsChanged: () => {},
  }
  const inspector = createInspector(head, panel, host)
  inspector.rebuild()
  return { head, panel, sync: inspector.sync, refresh: inspector.refresh, t, calls }
}

const card = (panel: HTMLElement, title: string): HTMLElement =>
  [...panel.querySelectorAll<HTMLElement>('.isec')].find((c) => c.querySelector('.isec-t')?.textContent === title)!
const line = (at: HTMLElement, label: string): HTMLElement =>
  [...at.querySelectorAll<HTMLElement>('.irow')].find((r) => r.querySelector('.irow-l')?.textContent === label)!
const fields = (at: HTMLElement): HTMLElement[] => [...at.querySelectorAll<HTMLElement>('.sf')]
const shownIn = (field: HTMLElement): string => field.querySelector('input')!.value

const press = (at: HTMLElement, type: string, x: number): void => {
  at.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientX: x, pointerId: 1 }))
}
/** A click opens the field for typing; blur is what commits. */
const type = (field: HTMLElement, text: string): void => {
  press(field, 'pointerdown', 0)
  press(field, 'pointerup', 0)
  const input = field.querySelector('input')!
  input.value = text
  input.dispatchEvent(new Event('blur'))
}

const paramOf = (doc: Doc, at: number, type: string, key: string): unknown => doc.components(at).find((c) => c.type === type)?.params[key]

describe('the Inspector’s cards', () => {
  it('draws every field itself — nothing of Tweakpane’s — with X Y Z on the transform', () => {
    const { panel } = rig(levelDoc({ id: 'l', config: {}, nodes: [box('a', vec3(0, 0, 0))] }), [0])
    expect(panel.querySelector('[class^="tp-"], [class*=" tp-"]')).toBeNull()
    const transform = card(panel, 'Transform')
    expect(['position', 'rotation °', 'scale'].map((l) => fields(line(transform, l)).length)).toEqual([3, 3, 3])
    expect(fields(line(transform, 'position')).map((f) => f.querySelector('.sf-l')!.textContent)).toEqual(['X', 'Y', 'Z'])
    expect(fields(line(transform, 'position')).map(shownIn)).toEqual(['0', '26.68', '48.18'])
  })

  it('puts an icon on every card, and a component with nothing to edit is its header alone', () => {
    const doc = levelDoc({ id: 'l', config: {}, nodes: [node('a', [comp('h', 'Hazard'), comp('b', 'Bumper', { power: 26 })])] })
    const { panel } = rig(doc, [0])
    expect([...panel.querySelectorAll('.isec')].every((c) => c.querySelector('svg.isec-i') !== null)).toBe(true)
    const header = [...card(panel, 'Bumper').querySelector('.isec-h')!.children].map((e) => e.classList[e.classList.length - 1])
    expect(header.slice(0, 4), 'twist, enable, icon, name').toEqual(['isec-tw', 'isec-en', 'isec-i', 'isec-t'])
    const hazard = card(panel, 'Hazard')
    expect(hazard.classList.contains('isec-bare')).toBe(true)
    expect(hazard.querySelector<HTMLElement>('.isec-body')!.hidden).toBe(true)
    expect(panel.textContent).not.toContain('no parameters')
  })

  it('draws the Renderer as one Mesh Renderer card: its model, then its material (ADR 0153)', () => {
    const doc = levelDoc({ id: 'l', config: {}, nodes: [box('a', vec3(0, 0, 0))] })
    doc.setParams(0, 'a-vis', { model: 'builtin:sphere' })
    const { panel } = rig(doc, [0])
    const renderer = card(panel, 'Mesh Renderer')
    expect([...renderer.querySelectorAll('.irow-l')].map((l) => l.textContent)).toEqual(['model', 'material'])
    expect(line(card(panel, 'Collider'), 'shape').textContent, 'the built-in holds the collider').toContain('unit ball')
  })

  it('ends with Add Component, and no Duplicate or Delete', () => {
    const { panel } = rig(levelDoc({ id: 'l', config: {}, nodes: [box('a', vec3(0, 0, 0))] }), [0])
    expect(panel.lastElementChild!.classList.contains('iadd')).toBe(true)
    expect([...panel.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Duplicate')
    expect([...panel.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Delete')
  })
})

describe('a number field', () => {
  it('writes as it is dragged, inside one history entry', () => {
    const doc = levelDoc({ id: 'l', config: {}, nodes: [node('a', [comp('b', 'Bumper', { power: 26 })])] })
    const { panel, calls } = rig(doc, [0])
    const power = fields(line(card(panel, 'Bumper'), 'launch (m/s)'))[0]!
    press(power, 'pointerdown', 100)
    press(power, 'pointermove', 110)
    expect(calls.begins, 'the entry opens when the press becomes a drag').toBe(1)
    expect(paramOf(doc, 0, 'Bumper', 'power'), 'the level follows the pointer').toBe(36)
    press(power, 'pointermove', 120)
    press(power, 'pointerup', 120)
    expect(paramOf(doc, 0, 'Bumper', 'power')).toBe(46)
    expect(calls.drags, 'and closes once, when it lets go').toEqual(['launch (m/s)'])
    expect(shownIn(power)).toBe('46')
  })

  it('takes a typed value as it is, never snapped to the drag’s step (ADR 0113)', () => {
    // Tweakpane's step snapped typing to multiples of 0.05 counted from the value the field was built with.
    const { panel, calls } = rig(levelDoc({ id: 'l', config: {}, nodes: [box('a', vec3(0, 0, 0))] }), [0], { scale: vec3(32.98, 1, 1) })
    type(fields(line(card(panel, 'Transform'), 'scale'))[0]!, '33')
    expect(calls.transforms.at(-1)!.scale.x).toBe(33)
    expect(calls.begins, 'typing is not a drag').toBe(0)
  })

  it('follows the gizmo without a rebuild', () => {
    const { panel, t, sync } = rig(levelDoc({ id: 'l', config: {}, nodes: [box('a', vec3(0, 0, 0))] }), [0])
    const y = fields(line(card(panel, 'Transform'), 'position'))[1]!
    t.current = { ...t.current, position: vec3(0, 30, 48.18) }
    sync()
    expect(y.isConnected).toBe(true)
    expect(shownIn(y)).toBe('30')
  })
})

describe('the prefab bar', () => {
  const placed = (): Doc => {
    const doc = levelDoc({ id: 'l', config: {}, nodes: [box('plain', vec3(0, 0, 0))] })
    doc.placePrefab(TOWER_ID, structuredClone(TOWER), vec3(0, 0, 0))
    doc.placePrefab(TOWER_ID, structuredClone(TOWER), vec3(4, 0, 0))
    return doc
  }
  const indexOf = (doc: Doc, test: (i: number) => boolean): number => [...Array(doc.count()).keys()].find(test)!

  it('is not there on a plain object', () => {
    const { head } = rig(placed(), [0])
    expect(head.querySelector<HTMLElement>('.ipre')!.hidden).toBe(true)
  })

  it('names the prefab and its placements on a placement, with Open and the overrides behind one button', () => {
    const doc = placed()
    const at = indexOf(doc, (i) => doc.kindOf(i) === 'own' && doc.refOf(i) !== null)
    const { head, calls } = rig(doc, [at])
    const bar = head.querySelector<HTMLElement>('.ipre')!
    expect(bar.hidden).toBe(false)
    expect(bar.querySelector('.ipre-t')!.textContent).toBe('Tower')
    expect(bar.querySelector<HTMLElement>('.ipre-c')!.textContent, 'counted as the Hierarchy counts').toBe('×2')
    const [open, overrides] = [...bar.querySelectorAll<HTMLButtonElement>('.ipre-b')]
    expect(open!.hidden).toBe(false)
    overrides!.click()
    const menu = calls.menus.at(-1)!
    expect(menu.items.map((m) => m.label)).toEqual(['Revert all', 'Apply all', 'Unlink from prefab'])
    expect(menu.items.slice(0, 2).map((m) => m.enabled), 'nothing to revert or apply yet').toEqual([false, false])
    expect(menu.title).toBe('matches the prefab')
  })

  it('says which prefab a piece is part of, with only the piece’s own overrides', () => {
    const doc = placed()
    const at = indexOf(doc, (i) => doc.kindOf(i) === 'inherited')
    const { head, calls } = rig(doc, [at])
    const bar = head.querySelector<HTMLElement>('.ipre')!
    expect(bar.querySelector('.ipre-t')!.textContent).toBe('part of Tower')
    const [open, overrides] = [...bar.querySelectorAll<HTMLButtonElement>('.ipre-b')]
    expect(open!.hidden).toBe(true)
    overrides!.click()
    expect(calls.menus.at(-1)!.items.map((m) => m.label)).toEqual(['Revert all', 'Apply'])
  })
})

describe('several selected (ADR 0112)', () => {
  it('writes one axis of a vec3 they disagree about over each one’s own other axes', () => {
    const doc = levelDoc({ id: 'l', config: {}, nodes: [box('a', vec3(1, 0, 0)), box('b', vec3(2, 0, 3))] })
    const { panel } = rig(doc, [0, 1])
    const center = line(card(panel, 'Collider'), 'center')
    const [x, y] = fields(center)
    expect(center.classList.contains('mixed')).toBe(true)
    expect([shownIn(x!), shownIn(y!)], 'x differs, y agrees').toEqual(['', '0'])
    type(x!, '5')
    expect(paramOf(doc, 0, COLLIDER, 'center')).toEqual({ x: 5, y: 0, z: 0 })
    expect(paramOf(doc, 1, COLLIDER, 'center')).toEqual({ x: 5, y: 0, z: 3 })
  })
})

describe('the Transform', () => {
  it('is always open: no twist, and a click on its header does not shut it', () => {
    const { panel } = rig(levelDoc({ id: 'l', config: {}, nodes: [box('a', vec3(0, 0, 0))] }), [0])
    const transform = card(panel, 'Transform')
    expect(transform.classList.contains('isec-fixed')).toBe(true)
    transform.querySelector<HTMLElement>('.isec-t')!.click()
    const after = card(panel, 'Transform')
    expect(after.classList.contains('shut')).toBe(false)
    expect(after.querySelector<HTMLElement>('.isec-body')!.hidden).toBe(false)
    expect(after.classList.contains('movable'), 'and it never moves').toBe(false)
  })
})

describe('reordering components by dragging a card’s header', () => {
  /** Cards stacked 100 px apart, 80 tall — happy-dom lays nothing out. */
  const stack = (panel: HTMLElement): void => {
    ;[...panel.querySelectorAll<HTMLElement>('.isec')].forEach((c, i) => {
      c.getBoundingClientRect = () => ({ top: i * 100, bottom: i * 100 + 80, left: 0, right: 280, width: 280, height: 80, x: 0, y: i * 100, toJSON: () => ({}) })
    })
  }
  const pointer = (type: string, y: number): PointerEvent => new PointerEvent(type, { bubbles: true, button: 0, clientX: 10, clientY: y, pointerId: 1 })
  const withBumper = (): Doc => {
    const a = box('a', vec3(0, 0, 0))
    a.components.push(comp('a-bump', 'Bumper', { power: 26 }))
    return levelDoc({ id: 'l', config: {}, nodes: [a] })
  }
  const types = (doc: Doc): string[] => doc.components(0).map((c) => c.type)

  it('moves a component to where it is dropped', () => {
    const doc = withBumper()
    const { panel } = rig(doc, [0])
    stack(panel)
    // Transform 0–80, Collider 100–180, Renderer 200–280, Bumper 300–380.
    card(panel, 'Bumper').querySelector('.isec-t')!.dispatchEvent(pointer('pointerdown', 330))
    window.dispatchEvent(pointer('pointermove', 50))
    window.dispatchEvent(pointer('pointerup', 50))
    expect(types(doc)).toEqual(['Bumper', COLLIDER, RENDERER])
  })

  it('does nothing for a press that does not move, or a drag Escape takes back', () => {
    const doc = withBumper()
    const { panel } = rig(doc, [0])
    stack(panel)
    card(panel, 'Bumper').querySelector('.isec-t')!.dispatchEvent(pointer('pointerdown', 330))
    window.dispatchEvent(pointer('pointerup', 330))
    expect(types(doc)).toEqual([COLLIDER, RENDERER, 'Bumper'])
    card(panel, 'Collider').querySelector('.isec-t')!.dispatchEvent(pointer('pointerdown', 130))
    window.dispatchEvent(pointer('pointermove', 370))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    window.dispatchEvent(pointer('pointerup', 370))
    expect(types(doc)).toEqual([COLLIDER, RENDERER, 'Bumper'])
  })

  it('leaves a prefab’s components where the prefab has them', () => {
    const doc = levelDoc({ id: 'l', config: {}, nodes: [] })
    doc.placePrefab(TOWER_ID, structuredClone(TOWER), vec3(0, 0, 0))
    const piece = [...Array(doc.count()).keys()].find((i) => doc.kindOf(i) === 'inherited')!
    const { panel } = rig(doc, [piece])
    expect(panel.querySelectorAll('.isec.movable')).toHaveLength(0)
  })
})

describe('someone else’s edit to the object shown (ADR 0168)', () => {
  const shown = () => {
    const doc = levelDoc({ id: 'l', config: {}, nodes: [box('a', vec3(0, 0, 0))] })
    return { doc, ...rig(doc, [0]) }
  }

  it('shows the new values in the same fields, drawing nothing again', () => {
    const { doc, panel, refresh } = shown()
    const centre = fields(line(card(panel, 'Collider'), 'center'))
    const half = fields(line(card(panel, 'Collider'), 'half extents'))
    doc.setParams(0, 'a-col', { center: vec3(1, 2, 3), shape: { kind: 'box', halfExtents: vec3(2, 0.5, 2) } })
    refresh()
    expect(fields(line(card(panel, 'Collider'), 'center')), 'the same fields').toEqual(centre)
    expect(centre.map(shownIn)).toEqual(['1', '2', '3'])
    expect(half.map(shownIn)).toEqual(['2', '0.5', '2'])
  })

  it('keeps what you are typing, and writes it when you are done — the other axes as they are now', () => {
    const { doc, panel, refresh } = shown()
    const [x, y] = fields(line(card(panel, 'Collider'), 'center'))
    press(x!, 'pointerdown', 0)
    press(x!, 'pointerup', 0)
    x!.querySelector('input')!.value = '5'
    doc.setParams(0, 'a-col', { center: vec3(9, 9, 9) })
    refresh()
    expect([shownIn(x!), shownIn(y!)], 'the one being typed in keeps it').toEqual(['5', '9'])
    x!.querySelector('input')!.dispatchEvent(new Event('blur'))
    expect(paramOf(doc, 0, COLLIDER, 'center')).toEqual({ x: 5, y: 9, z: 9 })
  })

  it('draws the panel again when what it is made of changed', () => {
    const { doc, panel, refresh } = shown()
    const before = card(panel, 'Collider')
    doc.setParams(0, 'a-col', { shape: { kind: 'ball', radius: 2 } })
    refresh()
    const after = card(panel, 'Collider')
    expect(after).not.toBe(before)
    expect(line(after, 'radius')).toBeDefined()
    expect(line(after, 'half extents')).toBeUndefined()
  })
})

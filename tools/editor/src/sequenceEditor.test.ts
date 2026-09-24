// @vitest-environment happy-dom
import { compileSequence, type Sequence, type Stage, type Step } from '@mp/content'
import { vec3 } from '@mp/core'
import { describe, expect, it } from 'vitest'

import type { MenuItem } from './menu'
import { sequenceEditor, type SequenceEditorHost } from './sequenceEditor'

/**
 * The sequence editor's DOM (ADR 0143): what it draws, and what each gesture commits. Every gesture is one
 * `commit` of the stages as they should now be, so that is what these read.
 */

const move = (id: string, x: number, target?: string): Step => ({ id, kind: 'move', to: vec3(x, 0, 0), timing: { by: 'seconds', seconds: 1 }, ease: 'linear', ...(target === undefined ? {} : { target }) })
const wait = (id: string): Step => ({ id, kind: 'wait', seconds: 1 })
const STAGES: readonly Stage[] = [
  { id: 'A', steps: [move('a', 1), move('b', 2, 'left')] },
  { id: 'B', steps: [wait('c')] },
]
const sequenceOf = (stages: readonly Stage[]): Sequence => ({ name: '', clock: 'shared', axes: 'object', loop: 'restart', times: 0, offset: 0, stages })

interface Rig {
  readonly root: HTMLElement
  readonly commits: (readonly Stage[])[]
  readonly many: (readonly { componentId: string; stages: readonly Stage[] }[])[]
  readonly menus: { items: readonly MenuItem[]; title: string | undefined }[]
  readonly open: Set<string>
  rerenders: number
}

const rig = (stages: readonly Stage[] = STAGES, over: Partial<SequenceEditorHost> = {}): Rig => {
  let k = 0
  const r: Rig = { root: document.createElement('div'), commits: [], many: [], menus: [], open: new Set(), rerenders: 0 }
  const editor = sequenceEditor({
    node: 3,
    componentId: 'seq',
    stages,
    compiled: compileSequence(sequenceOf(stages)),
    targets: [{ id: 'left', label: 'Left half' }],
    commit: (s) => r.commits.push(s),
    stagesOf: () => null,
    commitMany: (changes) => r.many.push(changes),
    openMenu: (_at, items, title) => r.menus.push({ items, title }),
    open: r.open,
    rerender: () => (r.rerenders += 1),
    freshId: () => `new${++k}`,
    ...over,
  })
  r.root.append(editor)
  document.body.append(r.root)
  return r
}

const q = (r: Rig, sel: string): HTMLElement[] => [...r.root.querySelectorAll<HTMLElement>(sel)]
const ids = (stages: readonly Stage[]): string[][] => stages.map((s) => [s.id, ...s.steps.map((x) => x.id)])
const fire = (target: HTMLElement, type: string, extra: Record<string, unknown> = {}): void => {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(e, extra)
  target.dispatchEvent(e)
}
/** A drag as the grip starts one: pressed, then dragged. */
const startDrag = (item: HTMLElement): void => {
  fire(item.querySelector<HTMLElement>('.seq-grip')!, 'pointerdown')
  fire(item, 'dragstart')
}

describe('what it draws', () => {
  it('draws a box per stage, its length in the corner, and a line per step', () => {
    const r = rig()
    expect(q(r, '.seq-stage')).toHaveLength(2)
    expect(q(r, '.seq-len').map((e) => e.textContent)).toEqual(['1 s', '1 s'])
    expect(q(r, '.seq-line').map((e) => e.textContent)).toEqual(['move  (1, 0, 0)   1 s   linear', 'move → Left half  (2, 0, 0)   1 s   linear', 'wait   1 s'])
  })

  it('opens a step when its line is clicked, and keeps that across the rebuild', () => {
    const r = rig()
    q(r, '.seq-line')[0]!.click()
    expect(r.open.has('a')).toBe(true)
    expect(r.rerenders).toBe(1)
    const opened = rig(STAGES, { open: new Set(['a']) })
    expect(q(opened, '.seq-fields')).toHaveLength(1)
  })

  it('warns about a stage nothing ends and a target that is gone', () => {
    const stages: readonly Stage[] = [{ id: 'A', steps: [{ id: 'f', kind: 'fade', to: 0, timing: { by: 'stage' }, ease: 'linear' }] }, { id: 'B', steps: [move('m', 1, 'ghost')] }]
    const r = rig(stages)
    const warns = q(r, '.seq-warn')
    expect(warns).toHaveLength(2)
    expect(warns[0]!.title).toMatch(/lasts 0 s/)
    expect(warns[1]!.title).toMatch(/is gone/)
  })
})

describe('adding and removing', () => {
  it('adds a step to a stage from its + menu, which offers every kind', () => {
    const r = rig()
    q(r, '.seq-add')[1]!.click()
    const menu = r.menus[0]!
    expect(menu.items.map((i) => i.label)).toEqual(['move', 'turn', 'scale', 'fade', 'collider on', 'collider off', 'enable', 'disable', 'wait'])
    menu.items.find((i) => i.label === 'fade')!.run!()
    expect(ids(r.commits[0]!)[1]).toEqual(['B', 'c', 'new1'])
  })

  it('adds a stage of its own from + stage', () => {
    const r = rig()
    q(r, '.seq-add-stage')[0]!.click()
    r.menus[0]!.items[0]!.run!()
    expect(ids(r.commits[0]!).at(-1)).toEqual(['new2', 'new1'])
  })

  it('removes a step from its ×, and the stage it empties with it', () => {
    const r = rig()
    q(r, '.seq-x')[2]!.click()
    expect(ids(r.commits[0]!)).toEqual([['A', 'a', 'b']])
  })

  it('duplicates and deletes from a right-click', () => {
    const r = rig()
    fire(q(r, '.seq-step')[0]!, 'contextmenu')
    expect(r.menus[0]!.items.map((i) => i.label)).toEqual(['Duplicate', 'Delete'])
    r.menus[0]!.items[0]!.run!()
    expect(ids(r.commits[0]!)[0]).toEqual(['A', 'a', 'new1', 'b'])
  })
})

describe('editing a step', () => {
  it('commits the changed step when a field changes', () => {
    const r = rig(STAGES, { open: new Set(['a']) })
    const x = q(r, '.seq-fields .seq-n')[0]! as HTMLInputElement
    x.value = '7'
    fire(x, 'change')
    const changed = r.commits[0]![0]!.steps[0]!
    expect(changed.kind === 'move' && changed.to.x).toBe(7)
  })

  it('aims a step at a child, and back at the object itself', () => {
    const r = rig(STAGES, { open: new Set(['b']) })
    const target = q(r, '.seq-fields .seq-s')[0]! as HTMLSelectElement
    target.value = ''
    fire(target, 'change')
    expect(r.commits[0]![0]!.steps[1]!.target).toBeUndefined()
  })
})

describe('dragging', () => {
  it('makes a step its own stage when dropped between two boxes', () => {
    const r = rig()
    startDrag(q(r, '.seq-step-w')[0]!)
    const between = q(r, '.seq-gap')[1]! // before stage B
    fire(between, 'dragover')
    fire(between, 'drop')
    expect(ids(r.commits[0]!)).toEqual([['A', 'b'], ['new1', 'a'], ['B', 'c']])
  })

  it('joins a stage when dropped into its box', () => {
    const r = rig()
    startDrag(q(r, '.seq-step-w')[2]!)
    fire(q(r, '.seq-stage')[0]!, 'drop')
    expect(ids(r.commits[0]!)).toEqual([['A', 'a', 'b', 'c']])
  })

  it('moves a whole stage by its box', () => {
    const r = rig()
    startDrag(q(r, '.seq-stage')[1]!)
    fire(q(r, '.seq-gap')[0]!, 'drop')
    expect(ids(r.commits[0]!).map((s) => s[0])).toEqual(['B', 'A'])
  })

  it('moves a step into another sequence on the same object, as one edit', () => {
    const other: readonly Stage[] = [{ id: 'X', steps: [wait('x')] }]
    const source = rig()
    const target = rig(other, { componentId: 'other', stagesOf: (id) => (id === 'seq' ? STAGES : null) })
    startDrag(q(source, '.seq-step-w')[2]!)
    fire(q(target, '.seq-stage')[0]!, 'drop')
    expect(target.many).toHaveLength(1)
    const [from, to] = target.many[0]!
    expect(from!.componentId).toBe('seq')
    expect(ids(from!.stages)).toEqual([['A', 'a', 'b']])
    expect(ids(to!.stages)).toEqual([['X', 'x', 'c']])
  })

  it('refuses a drop from a sequence on another object', () => {
    const source = rig()
    const elsewhere = rig(STAGES, { node: 9 })
    startDrag(q(source, '.seq-step-w')[0]!)
    fire(q(elsewhere, '.seq-stage')[1]!, 'drop')
    expect(elsewhere.commits).toHaveLength(0)
    expect(elsewhere.many).toHaveLength(0)
  })
})

/** A placement's changed and added steps wear the bar every other override in the Inspector does (ADR 0143). */
describe('overrides', () => {
  it('marks the steps and stages it is told were changed or added, and nothing else', () => {
    const r = rig(STAGES, { marked: new Set(['b', 'B']) })
    expect(q(r, '.seq-step').map((e) => e.classList.contains('over'))).toEqual([false, true, false])
    expect(q(r, '.seq-stage').map((e) => e.classList.contains('over'))).toEqual([false, true])
  })
})

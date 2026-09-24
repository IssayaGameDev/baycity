// @vitest-environment happy-dom
import { compileSequence, type Sequence, type Stage, type Step } from '@mp/content'
import { vec3 } from '@mp/core'
import { afterEach, describe, expect, it } from 'vitest'

import { closePopover } from './controls'
import type { MenuItem } from './menu'
import { dropTargetOf } from './sequenceDrag'
import { sequenceEditor, type SequenceEditorHost } from './sequenceEditor'

/**
 * The sequence editor's DOM (ADR 0143, ADR 0147): what it draws, and what each gesture commits. Every gesture
 * is one `commit` of the stages as they should now be, so that is what these read.
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

afterEach(() => {
  closePopover()
  document.body.replaceChildren()
})

const q = (r: Rig | HTMLElement, sel: string): HTMLElement[] => [...('root' in r ? r.root : r).querySelectorAll<HTMLElement>(sel)]
const ids = (stages: readonly Stage[]): string[][] => stages.map((s) => [s.id, ...s.steps.map((x) => x.id)])
const text = (e: HTMLElement | undefined): string => e?.textContent ?? ''
const fire = (target: Element, type: string, extra: Record<string, unknown> = {}): void => {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(e, extra)
  target.dispatchEvent(e)
}
const popover = (): HTMLElement => document.querySelector<HTMLElement>('.pop')!

describe('what it draws', () => {
  it('draws a card per stage with its number and length, and a line per step', () => {
    const r = rig()
    expect(q(r, '.seq-card').map((c) => [text(c.querySelector<HTMLElement>('.seq-num')!), text(c.querySelector<HTMLElement>('.seq-card-len')!)])).toEqual([
      ['1', '1 s'],
      ['2', '1 s'],
    ])
    expect(q(r, '.seq-row').map((row) => [text(row.querySelector('.seq-name') as HTMLElement), text(row.querySelector('.seq-detail') as HTMLElement), text(row.querySelector('.seq-dur') as HTMLElement)])).toEqual([
      ['Move', '1, 0, 0', '1 s'],
      ['Move', '2, 0, 0', '1 s'],
      ['Wait', '', '1 s'],
    ])
    expect(text(q(r, '.seq-to')[0]), 'aimed at a child, by its name').toBe('→ Left half')
  })

  it('shows each stage’s length in proportion at the top, and the rail between cards', () => {
    const r = rig([{ id: 'A', steps: [wait('a')] }, { id: 'B', steps: [{ id: 'x', kind: 'collider', on: true }] }])
    const bar = q(r, '.seq-bar-s')
    expect(bar.map((s) => s.style.flexGrow)).toEqual(['1', '0'])
    expect(bar[1]!.classList.contains('instant')).toBe(true)
    expect(q(r, '.seq-link').map((l) => l.dataset.before ?? 'end')).toEqual(['A', 'B', 'end'])
  })

  it('opens a step on a click, keeps it open across the rebuild, and does not repeat its numbers', () => {
    const r = rig()
    q(r, '.seq-row')[0]!.click()
    expect([r.open.has('a'), r.rerenders]).toEqual([true, 1])
    const opened = rig(STAGES, { open: new Set(['a']) })
    const row = q(opened, '.seq-row')[0]!
    expect(row.classList.contains('open')).toBe(true)
    expect(row.querySelector('.seq-detail'), 'the fields say it; the line does not again').toBeNull()
    expect(q(opened, '.seq-fields')).toHaveLength(1)
  })

  it('warns about a stage nothing ends and a target that is gone', () => {
    const stages: readonly Stage[] = [{ id: 'A', steps: [{ id: 'f', kind: 'fade', to: 0, timing: { by: 'stage' }, ease: 'linear' }] }, { id: 'B', steps: [move('m', 1, 'ghost')] }]
    const warns = q(rig(stages), '.seq-warn')
    expect(warns).toHaveLength(2)
    expect(warns[0]!.title).toMatch(/lasts 0 s/)
    expect(warns[1]!.title).toMatch(/is gone/)
  })
})

describe('adding and removing', () => {
  it('adds a step to a stage from its palette, and opens it to be set', () => {
    const r = rig()
    q(r, '.seq-card-add')[1]!.click()
    const tiles = q(popover(), '.seq-tile')
    expect(tiles.map((t) => text(t))).toEqual(['Move', 'Turn', 'Scale', 'Fade', 'Collider on', 'Collider off', 'Enable', 'Disable', 'Wait'])
    tiles[3]!.click()
    expect(ids(r.commits[0]!)[1]).toEqual(['B', 'c', 'new1'])
    expect(r.open.has('new1'), 'a new step is open').toBe(true)
    expect(document.querySelector('.pop'), 'and the palette has gone').toBeNull()
  })

  it('inserts a stage between two from the rail', () => {
    const r = rig()
    q(r, '.seq-link[data-before="B"] .seq-link-add')[0]!.click()
    q(popover(), '.seq-tile')[8]!.click()
    expect(ids(r.commits[0]!).map((s) => s[0])).toEqual(['A', 'new2', 'B'])
  })

  it('adds a stage at the end', () => {
    const r = rig()
    q(r, '.seq-add-stage')[0]!.click()
    q(popover(), '.seq-tile')[0]!.click()
    expect(ids(r.commits[0]!).at(-1)).toEqual(['new2', 'new1'])
  })

  it('removes a step from its ×, and the stage it empties with it', () => {
    const r = rig()
    q(r, '.seq-x')[2]!.click()
    expect(ids(r.commits[0]!)).toEqual([['A', 'a', 'b']])
    expect(r.rerenders, 'the × is not also a click on the line').toBe(0)
  })

  it('duplicates and deletes from a right-click', () => {
    const r = rig()
    fire(q(r, '.seq-row')[0]!, 'contextmenu')
    expect(r.menus[0]!.items.map((i) => i.label)).toEqual(['Duplicate', 'Delete'])
    r.menus[0]!.items[0]!.run!()
    expect(ids(r.commits[0]!)[0]).toEqual(['A', 'a', 'new1', 'b'])
  })
})

describe('editing a step', () => {
  const opened = (step: Step, stages: readonly Stage[] = [{ id: 'A', steps: [step] }]) => rig(stages, { open: new Set([step.id]) })
  const lastStep = (r: Rig): Step => r.commits.at(-1)![0]!.steps[0]!

  it('commits a number typed into a field', () => {
    const r = opened(move('a', 1))
    const x = q(r, '.seq-fields .sf')[0]!
    fire(x, 'pointerdown', { button: 0, clientX: 10, pointerId: 1 })
    fire(x, 'pointerup', { button: 0, clientX: 10, pointerId: 1 })
    expect(x.classList.contains('editing'), 'a click opens it for typing').toBe(true)
    const input = x.querySelector('input')!
    input.value = '7'
    fire(input, 'blur')
    const s = lastStep(r)
    expect(s.kind === 'move' && s.to.x).toBe(7)
  })

  it('keeps the focus on the next field clicked, though the edit before it rebuilds the panel', async () => {
    const r = opened(move('a', 1))
    const [x, y] = q(r, '.seq-fields .sf')
    const click = (f: HTMLElement): void => {
      fire(f, 'pointerdown', { button: 0, clientX: 0, pointerId: 1 })
      fire(f, 'pointerup', { button: 0, clientX: 0, pointerId: 1 })
    }
    click(x!)
    x!.querySelector('input')!.value = '5'
    // Focusing the next field is what blurs the first, and that blur is its edit.
    click(y!)
    expect(r.commits).toHaveLength(1)
    // The Inspector rebuilds on that commit; a fresh editor stands in for its rebuild.
    const again = rig([{ id: 'A', steps: [move('a', 5)] }], { open: new Set(['a']) })
    await Promise.resolve()
    const y2 = q(again, '.seq-fields .sf')[1]!
    expect(y2.classList.contains('editing')).toBe(true)
    expect(document.activeElement).toBe(y2.querySelector('input'))
  })

  it('commits a number dragged sideways, once, when the drag ends', () => {
    const r = opened(move('a', 1))
    const y = q(r, '.seq-fields .sf')[1]!
    fire(y, 'pointerdown', { button: 0, clientX: 100, pointerId: 1 })
    fire(y, 'pointermove', { clientX: 150, pointerId: 1 })
    fire(y, 'pointermove', { clientX: 200, pointerId: 1 })
    expect(r.commits, 'nothing mid-drag').toHaveLength(0)
    fire(y, 'pointerup', { button: 0, clientX: 200, pointerId: 1 })
    const s = lastStep(r)
    // 100 px at 2 cm a pixel.
    expect(s.kind === 'move' && s.to.y).toBeCloseTo(2, 9)
    expect(r.commits).toHaveLength(1)
  })

  it('switches how a step is timed with its switch', () => {
    const r = opened(move('a', 1))
    const speed = q(r, '.seq-fields .seg-b').find((b) => text(b) === 'Speed')!
    speed.click()
    const s = lastStep(r)
    expect(s.kind === 'move' && s.timing).toEqual({ by: 'speed', speed: 2 })
  })

  it('picks an ease from the grid of curves', () => {
    const r = opened(move('a', 1))
    q(r, '.seq-ease')[0]!.click()
    const cells = q(popover(), '.seq-ec')
    expect(cells, 'linear, then ten families in, out and in-out').toHaveLength(31)
    cells.find((c) => c.title === 'Bounce out')!.click()
    const s = lastStep(r)
    expect(s.kind === 'move' && s.ease).toBe('out-bounce')
  })

  it('switches a collider or the object with a switch, not a dropdown', () => {
    const r = opened({ id: 'c', kind: 'enabled', on: false })
    q(r, '.seq-fields .seg-b').find((b) => text(b) === 'Enable')!.click()
    expect(lastStep(r)).toEqual({ id: 'c', kind: 'enabled', on: true })
  })

  it('shows an opacity as a percentage and stores it as a fraction', () => {
    const r = opened({ id: 'f', kind: 'fade', to: 0.3, timing: { by: 'seconds', seconds: 1 }, ease: 'linear' })
    const field = q(r, '.seq-fields .sf')[0]!
    expect(field.querySelector('input')!.value).toBe('30')
    fire(field, 'pointerdown', { button: 0, clientX: 0, pointerId: 1 })
    fire(field, 'pointerup', { button: 0, clientX: 0, pointerId: 1 })
    const input = field.querySelector('input')!
    input.value = '75'
    fire(input, 'blur')
    const s = lastStep(r)
    expect(s.kind === 'fade' && s.to).toBeCloseTo(0.75, 9)
  })

  it('aims a step at a child, and back at the object itself', () => {
    const r = opened(move('b', 2, 'left'))
    const target = q(r, '.seq-fields .seq-sel')[0]! as HTMLSelectElement
    target.value = ''
    fire(target, 'change')
    expect(lastStep(r).target).toBeUndefined()
  })
})

/** Where a drag lands is `placeFor`'s (tested apart); here, what landing does. */
describe('dropping', () => {
  const dropOn = (r: Rig, source: { kind: 'step' | 'stage'; id: string; componentId?: string; node?: number }, place: Parameters<NonNullable<ReturnType<typeof dropTargetOf>>['drop']>[1]): void =>
    dropTargetOf(q(r, '.seq')[0]!)!.drop({ node: source.node ?? 3, componentId: source.componentId ?? 'seq', kind: source.kind, id: source.id }, place)

  it('makes a step its own stage, dropped between two', () => {
    const r = rig()
    dropOn(r, { kind: 'step', id: 'a' }, { kind: 'step', place: { kind: 'new-stage', before: 'B' } })
    expect(ids(r.commits[0]!)).toEqual([['A', 'b'], ['new1', 'a'], ['B', 'c']])
  })

  it('joins a stage, dropped into it', () => {
    const r = rig()
    dropOn(r, { kind: 'step', id: 'c' }, { kind: 'step', place: { kind: 'into', stage: 'A', before: 'b' } })
    expect(ids(r.commits[0]!)).toEqual([['A', 'a', 'c', 'b']])
  })

  it('moves a whole stage', () => {
    const r = rig()
    dropOn(r, { kind: 'stage', id: 'B' }, { kind: 'stage', before: 'A' })
    expect(ids(r.commits[0]!).map((s) => s[0])).toEqual(['B', 'A'])
  })

  it('moves a step into another sequence on the same object, as one edit', () => {
    const other: readonly Stage[] = [{ id: 'X', steps: [wait('x')] }]
    const target = rig(other, { componentId: 'other', stagesOf: (id) => (id === 'seq' ? STAGES : null) })
    dropOn(target, { kind: 'step', id: 'c' }, { kind: 'step', place: { kind: 'into', stage: 'X' } })
    expect(target.many).toHaveLength(1)
    const [from, to] = target.many[0]!
    expect([from!.componentId, ids(from!.stages), ids(to!.stages)]).toEqual(['seq', [['A', 'a', 'b']], [['X', 'x', 'c']]])
  })

  it('refuses a drop from a sequence on another object', () => {
    const r = rig()
    dropOn(r, { kind: 'step', id: 'a', node: 9 }, { kind: 'step', place: { kind: 'new-stage' } })
    expect([r.commits, r.many]).toEqual([[], []])
  })
})

/** A placement's changed and added steps wear the bar every other override in the Inspector does (ADR 0143). */
describe('overrides', () => {
  it('marks the steps and stages it is told were changed or added, and nothing else', () => {
    const r = rig(STAGES, { marked: new Set(['b', 'B']) })
    expect(q(r, '.seq-row').map((e) => e.classList.contains('over'))).toEqual([false, true, false])
    expect(q(r, '.seq-card').map((e) => e.classList.contains('over'))).toEqual([false, true])
  })
})

import type { CompiledSequence, Ease, SequenceProblem, Stage, Step, Timing } from '@mp/content'
import type { Vec3 } from '@mp/core'

import type { MenuItem } from './menu'
import {
  EASE_OPTIONS,
  STEP_CHOICES,
  addStep,
  duplicateStage,
  duplicateStep,
  moveStage,
  moveStageAcross,
  moveStep,
  moveStepAcross,
  newStep,
  num,
  removeStage,
  removeStep,
  replaceStep,
  stepLine,
  type StepPlace,
} from './sequenceEdit'

/**
 * The stages of one `Sequence`, as boxes in the Inspector (ADR 0143): the brief's layout, drawn with our own
 * DOM rather than Tweakpane, which has no list and no drag.
 *
 * Every change is one call to `commit` with the stages as they should now be — the editor's document works out
 * where they are stored and, on a prefab's piece, what differs (ADR 0139). One gesture, one edit, one Ctrl+Z.
 */

export interface SequenceEditorHost {
  /** The node, so a drag from a sequence on another node can be refused. */
  readonly node: number
  readonly componentId: string
  readonly stages: readonly Stage[]
  readonly compiled: CompiledSequence
  /** The node's children a step may aim at. */
  readonly targets: readonly { readonly id: string; readonly label: string }[]
  readonly commit: (stages: readonly Stage[]) => void
  /** Another sequence on the same node, for a step or stage dragged between them. */
  readonly stagesOf: (componentId: string) => readonly Stage[] | null
  readonly commitMany: (changes: readonly { readonly componentId: string; readonly stages: readonly Stage[] }[]) => void
  readonly openMenu: (at: { x: number; y: number }, items: readonly MenuItem[], title?: string) => void
  /** Which steps are open. Kept by the Inspector so it survives the rebuild every edit causes. */
  readonly open: Set<string>
  readonly rerender: () => void
  readonly freshId: () => string
  /** Steps and stages this placement changed or added (ADR 0143): marked with the override bar. */
  readonly marked?: ReadonlySet<string>
}

/** What is being dragged, across every sequence editor on screen, since a drop can land in another one. */
let dragging: { readonly node: number; readonly componentId: string; readonly kind: 'step' | 'stage'; readonly id: string } | null = null

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Why a step or a stage is marked, in words a person can act on. */
const reasonOf = (p: SequenceProblem): string => {
  switch (p.kind) {
    case 'stage-has-no-end':
      return 'nothing in this stage ends by itself, so it lasts 0 s — give one step its own time'
    case 'goes-nowhere':
      return 'this goes nowhere: a move to the point it is already at, or a turn with no angle or no axis'
    case 'speed-not-positive':
      return 'a speed of 0 or less cannot time this step'
    case 'speed-not-allowed':
      return 'a scale or a fade cannot be timed by a speed'
  }
}

const MARKS = ['drop-before', 'drop-after', 'drop-into', 'drop-gap'] as const

export const sequenceEditor = (host: SequenceEditorHost): HTMLElement => {
  const root = el('div', 'seq')
  const warnings = new Map<string, string>()
  for (const p of host.compiled.problems) warnings.set(p.kind === 'stage-has-no-end' ? p.stage : p.step, reasonOf(p))
  const names = new Map(host.targets.map((t) => [t.id, t.label]))

  const clearMarks = (): void => {
    for (const mark of MARKS) for (const e of root.querySelectorAll(`.${mark}`)) e.classList.remove(mark)
  }
  /** A drag this editor can take: same node, and a stage only where stages go. */
  const takes = (kind: 'step' | 'stage'): boolean => dragging !== null && dragging.node === host.node && dragging.kind === kind

  const dropStep = (place: StepPlace): void => {
    const d = dragging
    dragging = null
    clearMarks()
    if (d === null || d.kind !== 'step' || d.node !== host.node) return
    if (d.componentId === host.componentId) {
      host.commit(moveStep(host.stages, d.id, place, host.freshId))
      return
    }
    const from = host.stagesOf(d.componentId)
    const moved = from === null ? null : moveStepAcross(from, host.stages, d.id, place, host.freshId)
    if (moved !== null)
      host.commitMany([
        { componentId: d.componentId, stages: moved.from },
        { componentId: host.componentId, stages: moved.to },
      ])
  }

  const dropStage = (before?: string): void => {
    const d = dragging
    dragging = null
    clearMarks()
    if (d === null || d.kind !== 'stage' || d.node !== host.node) return
    if (d.componentId === host.componentId) {
      host.commit(moveStage(host.stages, d.id, before))
      return
    }
    const from = host.stagesOf(d.componentId)
    const moved = from === null ? null : moveStageAcross(from, host.stages, d.id, before)
    if (moved !== null)
      host.commitMany([
        { componentId: d.componentId, stages: moved.from },
        { componentId: host.componentId, stages: moved.to },
      ])
  }

  /**
   * Draggable only by its grip: `draggable` is switched on while the grip is held, so a click on a line still
   * opens it and a drag across a number field still selects its text.
   */
  const dragBy = (item: HTMLElement, grip: HTMLElement, kind: 'step' | 'stage', id: string): void => {
    grip.addEventListener('pointerdown', () => (item.draggable = true))
    grip.addEventListener('pointerup', () => (item.draggable = false))
    item.addEventListener('dragstart', (e) => {
      if (!item.draggable) return
      e.stopPropagation() // a step's drag must not also start its box's
      dragging = { node: host.node, componentId: host.componentId, kind, id }
      const carried = e.dataTransfer ?? null
      if (carried !== null) {
        carried.setData('text/plain', id) // Firefox will not drag without it
        carried.effectAllowed = 'move'
      }
      item.classList.add('dragging')
    })
    item.addEventListener('dragend', () => {
      item.draggable = false
      item.classList.remove('dragging')
      dragging = null
      clearMarks()
    })
  }

  /** The `+` menus: every kind of step, and what to do with the one picked. */
  const kindsMenu = (anchor: HTMLElement, put: (step: Step) => void): void => {
    const r = anchor.getBoundingClientRect()
    host.openMenu(
      { x: Math.round(r.left), y: Math.round(r.bottom + 2) },
      STEP_CHOICES.map((c) => ({ label: c.label, run: () => put(newStep(c.choice, host.freshId())) })),
      'add a step',
    )
  }

  const warn = (reason: string): HTMLElement => {
    const w = el('span', 'seq-warn', '⚠')
    w.title = reason
    return w
  }

  /**
   * A drop target between boxes, and above the first and below the last: a step dropped here becomes a stage of
   * its own, and a stage dropped here moves to here.
   */
  const gap = (before?: string): HTMLElement => {
    const g = el('div', 'seq-gap')
    g.addEventListener('dragover', (e) => {
      if (!takes('step') && !takes('stage')) return
      e.preventDefault()
      clearMarks()
      g.classList.add('drop-gap')
    })
    g.addEventListener('drop', (e) => {
      e.preventDefault()
      if (dragging?.kind === 'stage') dropStage(before)
      else dropStep(before === undefined ? { kind: 'new-stage' } : { kind: 'new-stage', before })
    })
    return g
  }

  // --- one step's fields ----------------------------------------------------------------------------

  const change = (step: Step): void => host.commit(replaceStep(host.stages, step))

  const field = (label: string, ...controls: HTMLElement[]): HTMLElement => {
    const row = el('div', 'seq-f')
    row.append(el('span', 'seq-f-l', label), ...controls)
    return row
  }

  const numberBox = (value: number, set: (v: number) => void, title: string): HTMLInputElement => {
    const box = el('input', 'seq-n')
    box.type = 'number'
    box.step = 'any'
    box.value = num(value)
    box.title = title
    box.addEventListener('change', () => {
      const v = Number(box.value)
      if (box.value.trim() !== '' && Number.isFinite(v)) set(v)
    })
    return box
  }

  const vecBoxes = (v: Vec3, set: (v: Vec3) => void): HTMLElement[] =>
    (['x', 'y', 'z'] as const).map((axis) => numberBox(v[axis], (n) => set({ ...v, [axis]: n }), axis))

  const picker = <T extends string>(options: readonly { readonly value: T; readonly label: string }[], value: T, set: (v: T) => void): HTMLSelectElement => {
    const select = el('select', 'seq-s')
    for (const o of options) {
      const opt = el('option', undefined, o.label)
      opt.value = o.value
      select.append(opt)
    }
    select.value = value
    select.addEventListener('change', () => set(select.value as T))
    return select
  }

  const easeField = (ease: Ease, set: (e: Ease) => void): HTMLElement => field('ease', picker(EASE_OPTIONS, ease, set))

  /**
   * How long a step lasts. What a timing *can* be depends on the step: a speed only for moves and turns, and
   * for a turn, "as long as its stage" either turns its angle over the stage or spins at a rate for it.
   */
  type Mode = 'seconds' | 'speed' | 'stage' | 'spin'
  const modeOf = (t: Timing): Mode => (t.by === 'stage' ? (t.speed === undefined ? 'stage' : 'spin') : t.by)
  const timingField = (t: Timing, unit: string, modes: readonly Mode[], set: (t: Timing) => void): HTMLElement => {
    const labels: Record<Mode, string> = { seconds: 'seconds', speed: `speed (${unit})`, stage: 'as long as its stage', spin: `spin for its stage (${unit})` }
    const mode = modeOf(t)
    const choose = picker(
      modes.map((m) => ({ value: m, label: labels[m] })),
      mode,
      (m) => {
        const seconds = t.by === 'seconds' ? t.seconds : 1
        const speed = t.by === 'speed' ? t.speed : t.by === 'stage' && t.speed !== undefined ? t.speed : unit === 'm/s' ? 2 : 90
        set(m === 'seconds' ? { by: 'seconds', seconds } : m === 'speed' ? { by: 'speed', speed } : m === 'spin' ? { by: 'stage', speed } : { by: 'stage' })
      },
    )
    const value =
      t.by === 'seconds'
        ? [numberBox(t.seconds, (v) => set({ by: 'seconds', seconds: Math.max(0, v) }), 'seconds')]
        : t.by === 'speed'
          ? [numberBox(t.speed, (v) => set({ by: 'speed', speed: v }), unit)]
          : t.speed !== undefined
            ? [numberBox(t.speed, (v) => set({ by: 'stage', speed: v }), unit)]
            : []
    return field('timing', choose, ...value)
  }

  const withTarget = (step: Step, target: string): Step => {
    const { target: _was, ...rest } = step
    return (target === '' ? rest : { ...rest, target }) as Step
  }

  const fields = (step: Step): HTMLElement => {
    const box = el('div', 'seq-fields')
    const gone = step.target !== undefined && !names.has(step.target)
    if (host.targets.length > 0 || step.target !== undefined) {
      const options = [
        { value: '', label: 'this object' },
        ...host.targets.map((t) => ({ value: t.id, label: t.label })),
        ...(gone && step.target !== undefined ? [{ value: step.target, label: '(a child that is gone)' }] : []),
      ]
      box.append(field('target', picker(options, step.target ?? '', (v) => change(withTarget(step, v)))))
    }
    switch (step.kind) {
      case 'move':
        box.append(
          field('to', ...vecBoxes(step.to, (to) => change({ ...step, to }))),
          timingField(step.timing, 'm/s', ['seconds', 'speed', 'stage'], (timing) => change({ ...step, timing })),
          easeField(step.ease, (ease) => change({ ...step, ease })),
        )
        break
      case 'turn': {
        const spin = modeOf(step.timing) === 'spin'
        box.append(field('axis', ...vecBoxes(step.axis, (axis) => change({ ...step, axis }))))
        if (!spin) box.append(field('angle °', numberBox(step.angle, (angle) => change({ ...step, angle }), 'degrees')))
        box.append(timingField(step.timing, '°/s', ['seconds', 'speed', 'stage', 'spin'], (timing) => change({ ...step, timing })))
        if (!spin) box.append(easeField(step.ease, (ease) => change({ ...step, ease })))
        break
      }
      case 'scale':
        box.append(
          field('×', ...vecBoxes(step.to, (to) => change({ ...step, to }))),
          timingField(step.timing, '', ['seconds', 'stage'], (timing) => change({ ...step, timing })),
          easeField(step.ease, (ease) => change({ ...step, ease })),
        )
        break
      case 'fade':
        box.append(
          field('to', numberBox(step.to, (to) => change({ ...step, to: Math.min(1, Math.max(0, to)) }), '1 = as its material is, 0 = invisible')),
          timingField(step.timing, '', ['seconds', 'stage'], (timing) => change({ ...step, timing })),
          easeField(step.ease, (ease) => change({ ...step, ease })),
        )
        break
      case 'collider':
        box.append(field('colliders', picker([{ value: 'on', label: 'on' }, { value: 'off', label: 'off' }], step.on ? 'on' : 'off', (v) => change({ ...step, on: v === 'on' }))))
        break
      case 'enabled':
        box.append(field('object', picker([{ value: 'on', label: 'enable' }, { value: 'off', label: 'disable' }], step.on ? 'on' : 'off', (v) => change({ ...step, on: v === 'on' }))))
        break
      case 'wait':
        box.append(field('seconds', numberBox(step.seconds, (seconds) => change({ ...step, seconds: Math.max(0, seconds) }), 'seconds')))
        break
    }
    return box
  }

  // --- a step's row ---------------------------------------------------------------------------------

  const stepRow = (stage: Stage, step: Step, next: Step | undefined): HTMLElement => {
    const wrap = el('div', 'seq-step-w')
    const row = el('div', 'seq-step')
    const grip = el('span', 'seq-grip', '⋮⋮')
    grip.title = 'drag to move this step'
    const aimed = step.target === undefined ? undefined : (names.get(step.target) ?? '?')
    const line = el('span', 'seq-line', stepLine(step, aimed))
    const isOpen = host.open.has(step.id)
    line.title = isOpen ? 'close' : 'open'
    line.addEventListener('click', () => {
      if (isOpen) host.open.delete(step.id)
      else host.open.add(step.id)
      host.rerender()
    })
    row.append(grip, line)
    const reason = warnings.get(step.id) ?? (step.target !== undefined && !names.has(step.target) ? 'the child this is aimed at is gone' : undefined)
    if (reason !== undefined) row.append(warn(reason))
    const x = el('button', 'seq-x', '×')
    x.title = 'remove this step'
    x.addEventListener('click', () => host.commit(removeStep(host.stages, step.id)))
    row.append(x)
    row.classList.toggle('open', isOpen)
    // Unity's cue, the bar every other overridden row in the Inspector wears.
    if (host.marked?.has(step.id) === true) row.classList.add('over')

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      host.openMenu({ x: e.clientX, y: e.clientY }, [
        { label: 'Duplicate', run: () => host.commit(duplicateStep(host.stages, step.id, host.freshId)) },
        { label: 'Delete', run: () => host.commit(removeStep(host.stages, step.id)) },
      ], 'step')
    })

    // Dropped on a row: before it in the upper half, after it in the lower — the line shows which.
    const upper = (e: DragEvent): boolean => {
      const r = row.getBoundingClientRect()
      return e.clientY < r.top + r.height / 2
    }
    row.addEventListener('dragover', (e) => {
      if (!takes('step')) return
      e.preventDefault()
      e.stopPropagation()
      clearMarks()
      row.classList.add(upper(e) ? 'drop-before' : 'drop-after')
    })
    row.addEventListener('drop', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const before = upper(e) ? step.id : next?.id
      dropStep(before === undefined ? { kind: 'into', stage: stage.id } : { kind: 'into', stage: stage.id, before })
    })
    dragBy(wrap, grip, 'step', step.id)

    wrap.append(row)
    if (isOpen) wrap.append(fields(step))
    return wrap
  }

  // --- the boxes ------------------------------------------------------------------------------------

  host.stages.forEach((stage, n) => {
    root.append(gap(stage.id))
    const box = el('div', 'seq-stage')
    if (host.marked?.has(stage.id) === true) box.classList.add('over')
    const head = el('div', 'seq-stage-h')
    const grip = el('span', 'seq-grip', '⋮⋮')
    grip.title = 'drag to move this stage and everything in it'
    head.append(grip)
    const reason = warnings.get(stage.id)
    if (reason !== undefined) head.append(warn(reason))
    head.append(el('span', 'seq-len', `${num(host.compiled.stages[n]?.duration ?? 0)} s`))
    box.append(head)
    stage.steps.forEach((step, k) => box.append(stepRow(stage, step, stage.steps[k + 1])))

    const add = el('button', 'seq-add', '+')
    add.title = 'add a step to this stage — it runs together with the others'
    add.addEventListener('click', () => kindsMenu(add, (step) => host.commit(addStep(host.stages, step, { kind: 'into', stage: stage.id }, host.freshId))))
    box.append(add)

    box.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      host.openMenu({ x: e.clientX, y: e.clientY }, [
        { label: 'Duplicate stage', run: () => host.commit(duplicateStage(host.stages, stage.id, host.freshId)) },
        { label: 'Delete stage', run: () => host.commit(removeStage(host.stages, stage.id)) },
      ], 'stage')
    })
    // Anywhere in the box that is not a row joins the stage, at its end.
    box.addEventListener('dragover', (e) => {
      if (!takes('step')) return
      e.preventDefault()
      clearMarks()
      box.classList.add('drop-into')
    })
    box.addEventListener('drop', (e) => {
      e.preventDefault()
      dropStep({ kind: 'into', stage: stage.id })
    })
    dragBy(box, grip, 'stage', stage.id)
    root.append(box)
  })
  root.append(gap())

  if (host.stages.length === 0) root.append(el('div', 'seq-empty', 'no stages yet'))
  const addStage = el('button', 'seq-add-stage', '+ stage')
  addStage.title = 'a new stage at the end — it starts when the one before it ends'
  addStage.addEventListener('click', () => kindsMenu(addStage, (step) => host.commit(addStep(host.stages, step, { kind: 'new-stage' }, host.freshId))))
  root.append(addStage)
  root.addEventListener('dragleave', (e) => {
    if (!root.contains(e.relatedTarget as Node | null)) clearMarks()
  })
  return root
}

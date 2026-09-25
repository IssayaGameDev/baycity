import type { CompiledSequence, Ease, SequenceProblem, Stage, Step, Timing } from '@mp/content'
import type { Vec3 } from '@mp/core'

import { closePopover, installPopoverDismissal, openPopover, popoverOpenFor, scrubField, segmented, type ScrubSpec, type Segment } from './controls'
import { EASE_FAMILIES, EASE_MODES, easeCurve, easeName, easeOf } from './easeCurve'
import type { MenuItem } from './menu'
import { icon } from './icons'
import { justDragged, pressToDrag, registerDropTarget, type DragSource, type DropPlace } from './sequenceDrag'
import {
  STEP_CHOICES,
  addStep,
  duplicateStage,
  duplicateStep,
  isInstant,
  moveStage,
  moveStageAcross,
  moveStep,
  moveStepAcross,
  newStep,
  removeStage,
  removeStep,
  replaceStep,
  seconds,
  stepFace,
  type StepPlace,
} from './sequenceEdit'

/**
 * The stages of one `Sequence`, in the Inspector (ADR 0143, ADR 0147): cards on a rail, one line per step,
 * the fields under a step while it is open. Our own DOM throughout, in one look.
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

/** How each kind of number drags: metres by the centimetre, degrees by the degree, and so on. */
const METRES: ScrubSpec = { perPixel: 0.02, grain: 0.01 }
const FACTOR: ScrubSpec = { perPixel: 0.01, grain: 0.01, min: 0 }
const DIRECTION: ScrubSpec = { perPixel: 0.01, grain: 0.01 }
const DEGREES: ScrubSpec = { perPixel: 1, grain: 1 }
const SECONDS: ScrubSpec = { perPixel: 0.01, grain: 0.05, min: 0 }
const PERCENT: ScrubSpec = { perPixel: 0.5, grain: 1, min: 0, max: 100 }

const button = (className: string, title: string, ...content: (Node | string)[]): HTMLButtonElement => {
  const b = el('button', className)
  b.type = 'button'
  b.title = title
  b.append(...content)
  return b
}

export const sequenceEditor = (host: SequenceEditorHost): HTMLElement => {
  installPopoverDismissal()
  const root = el('div', 'seq')
  root.dataset.node = String(host.node)
  root.dataset.component = host.componentId
  const warnings = new Map<string, string>()
  for (const p of host.compiled.problems) warnings.set(p.kind === 'stage-has-no-end' ? p.stage : p.step, reasonOf(p))
  const names = new Map(host.targets.map((t) => [t.id, t.label]))

  const warn = (reason: string): HTMLElement => {
    const w = el('span', 'seq-warn')
    w.append(icon('warn'))
    w.title = reason
    return w
  }

  /** A step's icon on its tinted chip. */
  const chip = (name: Parameters<typeof icon>[0], tint: string): HTMLElement => {
    const c = el('span', `seq-chip tint-${tint}`)
    c.append(icon(name))
    return c
  }

  // --- adding ---------------------------------------------------------------------------------------

  /** The palette of step kinds, icons and names, under whatever opened it. */
  const palette = (anchor: HTMLElement, place: StepPlace): void => {
    if (popoverOpenFor(anchor)) {
      closePopover(true)
      return
    }
    const grid = el('div', 'seq-palette')
    for (const c of STEP_CHOICES) {
      const tile = button('seq-tile', `add ${c.label.toLowerCase()}`, chip(c.icon, c.tint), el('span', 'seq-tile-l', c.label))
      tile.addEventListener('click', () => {
        closePopover()
        const step = newStep(c.choice, host.freshId())
        // New, so it is what you are about to set: open it.
        host.open.add(step.id)
        host.commit(addStep(host.stages, step, place, host.freshId))
      })
      grid.append(tile)
    }
    openPopover(anchor, grid, { className: 'pop-palette' })
  }

  // --- one step's fields ----------------------------------------------------------------------------

  const change = (step: Step): void => host.commit(replaceStep(host.stages, step))

  const field = (label: string, ...controls: HTMLElement[]): HTMLElement => {
    const row = el('div', 'seq-f')
    const c = el('div', 'seq-fc')
    c.append(...controls)
    row.append(el('span', 'seq-fl', label), c)
    return row
  }

  /** A field's key across rebuilds, so the one clicked keeps the focus (`ScrubFieldOptions.key`). */
  const keyOf = (step: Step, name: string): string => `${host.componentId}:${step.id}:${name}`

  const vecFields = (step: Step, name: string, v: Vec3, spec: ScrubSpec, set: (v: Vec3) => void, title: string): HTMLElement[] =>
    (['x', 'y', 'z'] as const).map((axis) =>
      scrubField({ value: v[axis], label: axis.toUpperCase(), axis, spec, key: keyOf(step, `${name}.${axis}`), title: `${title} ${axis} — drag sideways, or click to type`, commit: (n) => set({ ...v, [axis]: n }) }),
    )

  /** The ease, as its curve and name; a click opens every ease as a grid of curves. */
  const easeField = (ease: Ease, set: (e: Ease) => void): HTMLElement => {
    const b = button('seq-ease', 'choose how it speeds up and slows down', easeCurve(ease, 22, 14), el('span', 'seq-ease-l', easeName(ease)), icon('chevron', 'ic ic-s'))
    b.addEventListener('click', () => {
      if (popoverOpenFor(b)) {
        closePopover(true)
        return
      }
      const grid = el('div', 'seq-eases')
      const pick = (e: Ease): HTMLButtonElement => {
        const cell = button(`seq-ec${e === ease ? ' on' : ''}`, easeName(e), easeCurve(e, 34, 22))
        cell.addEventListener('click', () => {
          closePopover()
          if (e !== ease) set(e)
        })
        return cell
      }
      const linear = pick('linear')
      linear.classList.add('seq-ec-linear')
      linear.append(el('span', 'seq-ec-l', 'Linear'))
      grid.append(linear, el('span'), ...EASE_MODES.map((m) => el('span', 'seq-eh', m === 'in-out' ? 'In-out' : m === 'in' ? 'In' : 'Out')))
      for (const f of EASE_FAMILIES) {
        grid.append(el('span', 'seq-ef', `${f.charAt(0).toUpperCase()}${f.slice(1)}`), ...EASE_MODES.map((m) => pick(easeOf(f, m))))
      }
      openPopover(b, grid, { className: 'pop-eases' })
    })
    return field('Ease', b)
  }

  /**
   * How long a step lasts, as a switch and a number. What a timing *can* be depends on the step: a speed only
   * for moves and turns, and for a turn, "as long as its stage" either turns its angle over the stage or spins
   * at a rate for it.
   */
  type Mode = 'seconds' | 'speed' | 'stage' | 'spin'
  const modeOf = (t: Timing): Mode => (t.by === 'stage' ? (t.speed === undefined ? 'stage' : 'spin') : t.by)
  const timingField = (step: Step, t: Timing, unit: 'm/s' | '°/s' | '', modes: readonly Mode[], set: (t: Timing) => void): HTMLElement => {
    const labels: Record<Mode, Segment<Mode>> = {
      seconds: { value: 'seconds', label: 'Seconds', title: 'lasts a set time' },
      speed: { value: 'speed', label: 'Speed', title: `at an average speed, in ${unit}` },
      stage: { value: 'stage', label: 'Stage', title: 'as long as its stage' },
      spin: { value: 'spin', label: 'Spin', title: `spins at a rate for as long as its stage, in ${unit}` },
    }
    const mode = modeOf(t)
    const rate: ScrubSpec = unit === 'm/s' ? { perPixel: 0.05, grain: 0.1, min: 0 } : { perPixel: 1, grain: 1 }
    const switcher = segmented(
      modes.map((m) => labels[m]),
      mode,
      (m) => {
        const secs = t.by === 'seconds' ? t.seconds : 1
        const speed = t.by === 'speed' ? t.speed : t.by === 'stage' && t.speed !== undefined ? t.speed : unit === 'm/s' ? 2 : 90
        set(m === 'seconds' ? { by: 'seconds', seconds: secs } : m === 'speed' ? { by: 'speed', speed } : m === 'spin' ? { by: 'stage', speed } : { by: 'stage' })
      },
    )
    const value =
      t.by === 'seconds'
        ? scrubField({ value: t.seconds, unit: 's', spec: SECONDS, key: keyOf(step, 'time'), title: 'seconds', commit: (v) => set({ by: 'seconds', seconds: v }) })
        : t.by === 'speed'
          ? scrubField({ value: t.speed, unit, spec: rate, key: keyOf(step, 'time'), title: unit, commit: (v) => set({ by: 'speed', speed: v }) })
          : t.speed !== undefined
            ? scrubField({ value: t.speed, unit, spec: rate, key: keyOf(step, 'time'), title: unit, commit: (v) => set({ by: 'stage', speed: v }) })
            : null
    return value === null ? field('Time', switcher) : field('Time', switcher, value)
  }

  const withTarget = (step: Step, target: string): Step => {
    const { target: _was, ...rest } = step
    return (target === '' ? rest : { ...rest, target }) as Step
  }

  const targetField = (step: Step): HTMLElement | null => {
    if (host.targets.length === 0 && step.target === undefined) return null
    const gone = step.target !== undefined && !names.has(step.target)
    const select = el('select', 'seq-sel')
    const options = [
      { value: '', label: 'This object' },
      ...host.targets.map((t) => ({ value: t.id, label: t.label })),
      ...(gone && step.target !== undefined ? [{ value: step.target, label: '(a child that is gone)' }] : []),
    ]
    for (const o of options) {
      const opt = el('option', undefined, o.label)
      opt.value = o.value
      select.append(opt)
    }
    select.value = step.target ?? ''
    select.addEventListener('change', () => change(withTarget(step, select.value)))
    return field('Target', select)
  }

  const fields = (step: Step): HTMLElement => {
    const box = el('div', 'seq-fields')
    const target = targetField(step)
    if (target !== null) box.append(target)
    switch (step.kind) {
      case 'move':
        box.append(
          field('Point', ...vecFields(step, 'point', step.to, METRES, (to) => change({ ...step, to }), 'point')),
          timingField(step, step.timing, 'm/s', ['seconds', 'speed', 'stage'], (timing) => change({ ...step, timing })),
          easeField(step.ease, (ease) => change({ ...step, ease })),
        )
        break
      case 'turn': {
        const spin = modeOf(step.timing) === 'spin'
        box.append(field('Axis', ...vecFields(step, 'axis', step.axis, DIRECTION, (axis) => change({ ...step, axis }), 'axis')))
        if (!spin) box.append(field('Angle', scrubField({ value: step.angle, unit: '°', spec: DEGREES, key: keyOf(step, 'angle'), title: 'degrees — negative turns the other way', commit: (angle) => change({ ...step, angle }) })))
        box.append(timingField(step, step.timing, '°/s', ['seconds', 'speed', 'stage', 'spin'], (timing) => change({ ...step, timing })))
        if (!spin) box.append(easeField(step.ease, (ease) => change({ ...step, ease })))
        break
      }
      case 'scale':
        box.append(
          field('Factor', ...vecFields(step, 'factor', step.to, FACTOR, (to) => change({ ...step, to }), 'times the scale it was placed at,')),
          timingField(step, step.timing, '', ['seconds', 'stage'], (timing) => change({ ...step, timing })),
          easeField(step.ease, (ease) => change({ ...step, ease })),
        )
        break
      case 'fade':
        box.append(
          field(
            'Opacity',
            scrubField({
              value: step.to,
              unit: '%',
              spec: PERCENT,
              key: keyOf(step, 'opacity'),
              title: '100% = as its material is, 0% = invisible',
              toShown: (v) => v * 100,
              fromShown: (v) => v / 100,
              commit: (to) => change({ ...step, to: Math.min(1, Math.max(0, to)) }),
            }),
          ),
          timingField(step, step.timing, '', ['seconds', 'stage'], (timing) => change({ ...step, timing })),
          easeField(step.ease, (ease) => change({ ...step, ease })),
        )
        break
      case 'collider':
        box.append(field('Colliders', segmented([{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], step.on ? 'on' : 'off', (v) => change({ ...step, on: v === 'on' }))))
        break
      case 'enabled':
        box.append(field('Object', segmented([{ value: 'on', label: 'Enable' }, { value: 'off', label: 'Disable' }], step.on ? 'on' : 'off', (v) => change({ ...step, on: v === 'on' }))))
        break
      case 'wait':
        box.append(field('Time', scrubField({ value: step.seconds, unit: 's', spec: SECONDS, key: keyOf(step, 'time'), title: 'seconds', commit: (s) => change({ ...step, seconds: s }) })))
        break
    }
    return box
  }

  // --- a step's line --------------------------------------------------------------------------------

  const stepRow = (step: Step): HTMLElement => {
    const wrap = el('div', 'seq-step-w')
    wrap.dataset.step = step.id
    const isOpen = host.open.has(step.id)
    const face = stepFace(step)
    const row = el('div', `seq-row${isOpen ? ' open' : ''}`)
    // Unity's cue, the bar every other overridden row in the Inspector wears.
    if (host.marked?.has(step.id) === true) row.classList.add('over')
    row.title = isOpen ? 'close — or drag to move it' : 'open — or drag to move it'
    row.append(chip(face.icon, face.tint), el('span', 'seq-name', face.name))
    if (step.target !== undefined) row.append(el('span', 'seq-to', `→ ${names.get(step.target) ?? '?'}`))
    if (!isOpen) {
      row.append(el('span', 'seq-detail', face.detail))
      const span = host.compiled.steps.get(step.id)
      const dur = el('span', 'seq-dur', isInstant(step) || span === undefined ? '' : seconds(span.duration))
      if (!isInstant(step) && 'timing' in step && step.timing.by === 'stage') dur.title = 'as long as its stage'
      row.append(dur)
      const ease = el('span', 'seq-ec-row')
      if (face.ease !== undefined) {
        ease.append(easeCurve(face.ease, 16, 12))
        ease.title = easeName(face.ease)
      }
      row.append(ease)
    } else row.append(el('span', 'seq-fill'))
    const reason = warnings.get(step.id) ?? (step.target !== undefined && !names.has(step.target) ? 'the child this is aimed at is gone' : undefined)
    if (reason !== undefined) row.append(warn(reason))
    const x = button('seq-x', 'remove this step', icon('close'))
    x.addEventListener('click', (e) => {
      e.stopPropagation()
      host.commit(removeStep(host.stages, step.id))
    })
    row.append(x)

    row.addEventListener('click', () => {
      if (justDragged()) return
      if (isOpen) host.open.delete(step.id)
      else host.open.add(step.id)
      host.rerender()
    })
    row.addEventListener('pointerdown', (e) => {
      if ((e.target as Element).closest('button') !== null) return
      pressToDrag(e, { kind: 'step', id: step.id, node: host.node, componentId: host.componentId }, wrap)
    })
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      host.openMenu({ x: e.clientX, y: e.clientY }, [
        { label: 'Duplicate', run: () => host.commit(duplicateStep(host.stages, step.id, host.freshId)) },
        { label: 'Delete', run: () => host.commit(removeStep(host.stages, step.id)) },
      ], 'step')
    })
    wrap.append(row)
    if (isOpen) wrap.append(fields(step))
    return wrap
  }

  // --- the cards, on their rail ---------------------------------------------------------------------

  /** Between two cards, above the first and below the last: the rail, and a `+` that puts a stage there. */
  const link = (before?: string): HTMLElement => {
    const l = el('div', 'seq-link')
    if (before === undefined) l.dataset.end = ''
    else l.dataset.before = before
    const add = button('seq-link-add', before === undefined ? 'add a stage at the end' : 'insert a stage here', icon('plus'))
    add.addEventListener('click', () => palette(add, before === undefined ? { kind: 'new-stage' } : { kind: 'new-stage', before }))
    l.append(add)
    return l
  }

  host.stages.forEach((stage, n) => {
    root.append(link(stage.id))
    const card = el('div', 'seq-card')
    card.dataset.stage = stage.id
    if (host.marked?.has(stage.id) === true) card.classList.add('over')
    const head = el('div', 'seq-card-h')
    head.title = 'drag to move this stage and everything in it'
    head.append(el('span', 'seq-num', String(n + 1)))
    const reason = warnings.get(stage.id)
    if (reason !== undefined) head.append(warn(reason))
    head.append(el('span', 'seq-card-len', seconds(host.compiled.stages[n]?.duration ?? 0)))
    const add = button('seq-card-add', 'add a step that runs together with these', icon('plus'))
    add.addEventListener('click', () => palette(add, { kind: 'into', stage: stage.id }))
    head.append(add)
    head.addEventListener('pointerdown', (e) => {
      if ((e.target as Element).closest('button') !== null) return
      pressToDrag(e, { kind: 'stage', id: stage.id, node: host.node, componentId: host.componentId }, card)
    })
    card.append(head)
    const list = el('div', 'seq-steps')
    for (const step of stage.steps) list.append(stepRow(step))
    card.append(list)
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      host.openMenu({ x: e.clientX, y: e.clientY }, [
        { label: 'Duplicate stage', run: () => host.commit(duplicateStage(host.stages, stage.id, host.freshId)) },
        { label: 'Delete stage', run: () => host.commit(removeStage(host.stages, stage.id)) },
      ], 'stage')
    })
    root.append(card)
  })
  root.append(link())

  if (host.stages.length === 0) root.append(el('div', 'seq-empty', 'No steps yet'))
  const addStage = button('seq-add-stage', 'a new stage at the end — it starts when the one before it ends', icon('plus'), el('span', undefined, 'Add stage'))
  addStage.addEventListener('click', () => palette(addStage, { kind: 'new-stage' }))
  root.append(addStage)

  // --- where a drag lands ---------------------------------------------------------------------------

  const drop = (source: DragSource, place: DropPlace): void => {
    if (source.node !== host.node) return
    if (source.componentId === host.componentId) {
      if (source.kind === 'step' && place.kind === 'step') host.commit(moveStep(host.stages, source.id, place.place, host.freshId))
      else if (source.kind === 'stage' && place.kind === 'stage') host.commit(moveStage(host.stages, source.id, place.before))
      return
    }
    const from = host.stagesOf(source.componentId)
    if (from === null) return
    const moved =
      source.kind === 'step' && place.kind === 'step'
        ? moveStepAcross(from, host.stages, source.id, place.place, host.freshId)
        : source.kind === 'stage' && place.kind === 'stage'
          ? moveStageAcross(from, host.stages, source.id, place.before)
          : null
    if (moved !== null)
      host.commitMany([
        { componentId: source.componentId, stages: moved.from },
        { componentId: host.componentId, stages: moved.to },
      ])
  }
  registerDropTarget({ root, node: host.node, componentId: host.componentId, drop })
  return root
}

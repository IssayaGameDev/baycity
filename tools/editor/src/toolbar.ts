import type { Mode } from './editorDoc'

/**
 * The toolbar: file, transform tool, snap, play.
 *
 * Built once, then `render()` only *updates* values. That is the difference from the Tweakpane version,
 * which disposed and re-added its controls whenever anything changed — losing focus mid-edit and
 * flickering. Nothing here is recreated after construction except the two option lists.
 */
export type GizmoMode = 'translate' | 'rotate' | 'scale'
/** Which frame the gizmo handles point along — Unity's Local/Global button. */
export type GizmoSpace = 'world' | 'local'

export interface ToolbarState {
  mode: Mode
  name: string
  files: readonly string[]
  gizmo: GizmoMode
  space: GizmoSpace
  snap: boolean
  step: number
  playing: boolean
  /** Depth > 1 in the doc stack: a prefab is open on top of the file. */
  inPrefab: boolean
  grid: boolean
  markers: boolean
}

export interface ToolbarActions {
  setMode: (m: Mode) => void
  open: (name: string) => void
  setName: (name: string) => void
  save: () => void
  newBlank: () => void
  back: () => void
  setGizmo: (g: GizmoMode) => void
  setSpace: (s: GizmoSpace) => void
  setSnap: (on: boolean) => void
  setStep: (step: number) => void
  setPlaying: (on: boolean) => void
  setGrid: (on: boolean) => void
  setMarkers: (on: boolean) => void
}

export interface Toolbar {
  render: () => void
}

/**
 * `ctl` marks a control as *ours*, so the stylesheet can style these without reaching inside the
 * Tweakpane pane mounted in the Inspector — see the note in index.html.
 */
const OURS = new Set(['button', 'select', 'input'])

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  const base = OURS.has(tag) ? 'ctl' : ''
  node.className = className !== undefined ? `${base} ${className}`.trim() : base
  return node
}

const group = (...children: HTMLElement[]): HTMLDivElement => {
  const g = el('div', 'tb-group')
  g.append(...children)
  return g
}

const label = (text: string): HTMLSpanElement => {
  const s = el('span', 'tb-label')
  s.textContent = text
  return s
}

const setOptions = (select: HTMLSelectElement, names: readonly string[], selected: string): void => {
  const wanted = names.join(' ')
  // Rebuilding an open <select> closes its popup, so only touch it when the list actually changed.
  if (select.dataset['names'] !== wanted) {
    select.replaceChildren()
    for (const n of names) {
      const opt = el('option')
      opt.value = n
      opt.textContent = n
      select.append(opt)
    }
    select.dataset['names'] = wanted
  }
  if (names.length === 0) select.value = ''
  else if (select.value !== selected) select.value = names.includes(selected) ? selected : (names[0] ?? '')
}

export const createToolbar = (container: HTMLElement, state: () => ToolbarState, actions: ToolbarActions): Toolbar => {
  // --- file ---
  const modeSelect = el('select')
  for (const [value, text] of [
    ['level', 'Level'],
    ['prefab', 'Prefab'],
  ] as const) {
    const opt = el('option')
    opt.value = value
    opt.textContent = text
    modeSelect.append(opt)
  }
  modeSelect.addEventListener('change', () => actions.setMode(modeSelect.value === 'prefab' ? 'prefab' : 'level'))

  const openSelect = el('select')
  openSelect.addEventListener('change', () => {
    if (openSelect.value !== '') actions.open(openSelect.value)
  })

  const nameInput = el('input')
  nameInput.type = 'text'
  nameInput.title = 'file name — the document id follows it on save'
  nameInput.addEventListener('change', () => actions.setName(nameInput.value.trim()))

  const saveButton = el('button')
  saveButton.textContent = 'Save'
  saveButton.addEventListener('click', actions.save)

  const newButton = el('button')
  newButton.textContent = 'New'
  newButton.addEventListener('click', actions.newBlank)

  const backButton = el('button')
  backButton.textContent = '← Back'
  backButton.title = 'leave this prefab and return to the level'
  backButton.addEventListener('click', actions.back)

  // --- transform tool ---
  const seg = el('div', 'seg')
  const gizmoButtons = new Map<GizmoMode, HTMLButtonElement>()
  for (const [mode, text, key] of [
    ['translate', 'Move', 'T'],
    ['rotate', 'Rotate', 'R'],
    ['scale', 'Scale', 'S'],
  ] as const) {
    const b = el('button')
    b.textContent = text
    b.title = `${text} (${key})`
    b.addEventListener('click', () => actions.setGizmo(mode))
    gizmoButtons.set(mode, b)
    seg.append(b)
  }

  // Local/Global, like Unity's. Three overrides it where it cannot apply (scale is always local, the
  // free-rotate ring always world), so the button only ever claims what it delivers.
  const spaceButton = el('button')
  spaceButton.addEventListener('click', () => actions.setSpace(state().space === 'world' ? 'local' : 'world'))

  const snapBox = el('input')
  snapBox.type = 'checkbox'
  snapBox.id = 'tb-snap'
  snapBox.addEventListener('change', () => actions.setSnap(snapBox.checked))
  const snapLabel = el('label', 'tb-label')
  snapLabel.htmlFor = 'tb-snap'
  snapLabel.textContent = 'snap'

  const stepInput = el('input')
  stepInput.type = 'number'
  stepInput.min = '0.1'
  stepInput.max = '4'
  stepInput.step = '0.1'
  stepInput.title = 'grid step (m)'
  stepInput.addEventListener('change', () => {
    const v = Number.parseFloat(stepInput.value)
    if (Number.isFinite(v) && v > 0) actions.setStep(v)
  })

  // --- overlays ---
  const gridButton = el('button')
  gridButton.textContent = 'Grid'
  gridButton.addEventListener('click', () => actions.setGrid(!state().grid))

  const markerButton = el('button')
  markerButton.textContent = 'Markers'
  markerButton.title = 'spawn / checkpoint / goal / hazard gizmos'
  markerButton.addEventListener('click', () => actions.setMarkers(!state().markers))

  // --- play ---
  const playButton = el('button')
  playButton.addEventListener('click', () => actions.setPlaying(!state().playing))

  container.append(
    group(label('file'), modeSelect, openSelect, nameInput, saveButton, newButton, backButton),
    el('div', 'tb-sep'),
    group(seg, spaceButton, snapBox, snapLabel, stepInput),
    el('div', 'tb-sep'),
    group(gridButton, markerButton),
    el('div', 'tb-sep'),
    group(playButton),
  )

  const render = (): void => {
    const s = state()
    modeSelect.value = s.mode
    setOptions(openSelect, s.files, s.name)
    // Never fight the user's cursor: leave the field alone while it has focus.
    if (document.activeElement !== nameInput) nameInput.value = s.name
    backButton.hidden = !s.inPrefab

    for (const [mode, button] of gizmoButtons) button.classList.toggle('on', s.gizmo === mode)
    spaceButton.textContent = s.space === 'local' ? 'Local' : 'Global'
    spaceButton.title = 'the frame the handles point along (Unity: Local/Global)'
    snapBox.checked = s.snap
    if (document.activeElement !== stepInput) stepInput.value = String(s.step)

    gridButton.classList.toggle('on', s.grid)
    markerButton.classList.toggle('on', s.markers)

    playButton.textContent = s.playing ? '■ Stop' : '▶ Play'
    playButton.classList.toggle('on', s.playing)
    // Editing is suspended during play; the controls would lie about what they do.
    for (const control of [modeSelect, openSelect, nameInput, saveButton, newButton, stepInput, snapBox]) {
      control.disabled = s.playing
    }
    for (const button of gizmoButtons.values()) button.disabled = s.playing
    spaceButton.disabled = s.playing
  }

  render()
  return { render }
}

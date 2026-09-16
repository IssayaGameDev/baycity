
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
  /**
   * The name of the open document, without its game: a level's file name, or a prefab's.
   *
   * The **game picker and the level list are gone** (ADR 0108). A game is a folder holding its levels, so
   * both are the Project panel's tree: choosing a game in one dropdown and a level in another put the game in
   * a control nowhere near the file it governed, and made it possible to be authoring for one game while
   * looking at another's level.
   */
  name: string
  gizmo: GizmoMode
  space: GizmoSpace
  snap: boolean
  /**
   * The **active tool's** snap increment, and what it is measured in (ADR 0114).
   *
   * One field rather than three, because a grid in metres, one in degrees and one for scale are three
   * different numbers and only one tool is in use at a time. Switching tool switches which of the three this
   * field is editing, and the unit beside it says which.
   */
  step: number
  stepUnit: string
  stepLimits: { min: number; max: number; grain: number }
  playing: boolean
  /**
   * The preview clock is running (ADR 0103): every `Mover` and `Spinner` in the level is moving in the
   * viewport and editing carries on.
   *
   * Separate from `playing`, which is the real game loop with pointer lock. This is the cheap answer to "what
   * does this platform actually do", which used to need entering Play.
   */
  previewing: boolean
  /** Depth > 1 in the doc stack: a prefab is open on top of the file. */
  inPrefab: boolean
  /** Who holds this file's lock when it is not you — Save is off and says so (ADR 0083). `null` when yours. */
  readOnly: string | null
  /** The open level is edited live (ADR 0089): every edit is saved as it happens, so there is no Save. */
  live: boolean
  grid: boolean
  markers: boolean
}

export interface ToolbarActions {
  setName: (name: string) => void
  newBlank: () => void
  /** Copy the open level under a new name and open it. */
  duplicate: () => void
  back: () => void
  setGizmo: (g: GizmoMode) => void
  setSpace: (s: GizmoSpace) => void
  setSnap: (on: boolean) => void
  setStep: (step: number) => void
  setPlaying: (on: boolean) => void
  setPreviewing: (on: boolean) => void
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


export const createToolbar = (container: HTMLElement, state: () => ToolbarState, actions: ToolbarActions): Toolbar => {
  // --- file ---
  // Opening is the Project panel's tree (ADR 0108): a game is a folder of levels, so there is nothing here to
  // pick a game or a file with.
  const nameInput = el('input')
  nameInput.type = 'text'
  nameInput.title = 'file name — the document id follows it on save'
  nameInput.addEventListener('change', () => actions.setName(nameInput.value.trim()))

  const newButton = el('button')
  newButton.textContent = 'New'
  newButton.addEventListener('click', actions.newBlank)

  const duplicateButton = el('button')
  duplicateButton.textContent = 'Duplicate'
  duplicateButton.title = 'copy this level under a new name'
  duplicateButton.addEventListener('click', actions.duplicate)

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
  // min/max/grain follow the active tool: see `render`.
  const stepUnitLabel = el('span', 'tb-label')
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
  markerButton.title = 'spawn and gameplay-rule gizmos'
  markerButton.addEventListener('click', () => actions.setMarkers(!state().markers))

  // --- preview and play ---
  /**
   * One toggle for the whole level, not one per object: motion is timed against other motion, so a staggered
   * row of platforms is the thing you need to look at, and the panel this replaces could only ever show one.
   */
  const previewButton = el('button')
  previewButton.title = 'run the level’s movers and spinners in the viewport, without entering play'
  previewButton.addEventListener('click', () => actions.setPreviewing(!state().previewing))

  const playButton = el('button')
  playButton.addEventListener('click', () => actions.setPlaying(!state().playing))

  container.append(
    el('div', 'tb-sep'),
    group(label('file'), nameInput, newButton, duplicateButton, backButton),
    el('div', 'tb-sep'),
    group(seg, spaceButton, snapBox, snapLabel, stepInput, stepUnitLabel),
    el('div', 'tb-sep'),
    group(gridButton, markerButton),
    el('div', 'tb-sep'),
    group(previewButton, playButton),
  )

  const render = (): void => {
    const s = state()
    // Never fight the user's cursor: leave the field alone while it has focus.
    if (document.activeElement !== nameInput) nameInput.value = s.name
    backButton.hidden = !s.inPrefab

    for (const [mode, button] of gizmoButtons) button.classList.toggle('on', s.gizmo === mode)
    spaceButton.textContent = s.space === 'local' ? 'Local' : 'Global'
    spaceButton.title = 'the frame the handles point along (Unity: Local/Global)'
    snapBox.checked = s.snap
    if (document.activeElement !== stepInput) stepInput.value = String(s.step)
    // The bounds belong to the tool, not to the field: 0.05–10 m, 1–90°, 0.05–5× (ADR 0114).
    stepInput.min = String(s.stepLimits.min)
    stepInput.max = String(s.stepLimits.max)
    stepInput.step = String(s.stepLimits.grain)
    stepUnitLabel.textContent = s.stepUnit
    stepInput.title = `snap increment for the ${s.gizmo} tool, in ${s.stepUnit === '×' ? 'multiples' : s.stepUnit}`

    gridButton.classList.toggle('on', s.grid)
    markerButton.classList.toggle('on', s.markers)

    playButton.textContent = s.playing ? '■ Stop' : '▶ Play'
    playButton.classList.toggle('on', s.playing)
    previewButton.textContent = s.previewing ? '❙❙ Motion' : '▶ Motion'
    previewButton.classList.toggle('on', s.previewing)
    previewButton.disabled = s.playing // the game clock is already running everything
    // Editing is suspended during play; the controls would lie about what they do.
    for (const control of [nameInput, newButton, stepInput, snapBox]) {
      control.disabled = s.playing
    }
    for (const button of gizmoButtons.values()) button.disabled = s.playing
    spaceButton.disabled = s.playing
    /**
     * There is no Save. Levels and prefabs are both live rooms (ADR 0089, ADR 0091), so every edit is already
     * on the server, and the name is the document the whole room has open rather than something to type.
     */
    nameInput.disabled = true
    nameInput.title = s.inPrefab ? 'a prefab is renamed in the Project panel, where its id follows it' : 'the level this room has open'
    duplicateButton.hidden = s.inPrefab
    duplicateButton.disabled = s.playing
    newButton.disabled = s.playing || s.inPrefab
    newButton.title = s.inPrefab ? 'leave the prefab first' : 'a new level in the open game, named now'
  }

  render()
  return { render }
}

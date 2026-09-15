
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
   * The **game** being authored for, by `ModeDescriptor.name`, or `''` for none (ADR 0052).
   *
   * Called `game` and not `mode` on purpose: `mode` in this editor already means level-versus-prefab, and two
   * meanings for one word in the same interface is how the wrong one gets read.
   */
  game: string
  /** The installed games, for the picker. */
  games: readonly { name: string; label: string }[]
  name: string
  files: readonly string[]
  gizmo: GizmoMode
  space: GizmoSpace
  snap: boolean
  step: number
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
  /** Author for this game from now on: narrows the level list and decides what a new level is for. */
  setGame: (name: string) => void
  open: (name: string) => void
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
  /**
   * Which game is being authored for. The level list narrows to it and a new level is made for it — it does
   * **not** retag the open level, which happens in the Game row where the consequences are visible.
   */
  const gameSelect = el('select')
  gameSelect.title = 'the game being authored for — narrows the level list and decides what a new level is for'
  gameSelect.addEventListener('change', () => actions.setGame(gameSelect.value))

  const openSelect = el('select')
  openSelect.addEventListener('change', () => {
    if (openSelect.value !== '') actions.open(openSelect.value)
  })

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
    group(label('game'), gameSelect),
    el('div', 'tb-sep'),
    group(label('file'), openSelect, nameInput, newButton, duplicateButton, backButton),
    el('div', 'tb-sep'),
    group(seg, spaceButton, snapBox, snapLabel, stepInput),
    el('div', 'tb-sep'),
    group(gridButton, markerButton),
    el('div', 'tb-sep'),
    group(previewButton, playButton),
  )

  const render = (): void => {
    const s = state()
    /**
     * `(none)` is offered and is not a placeholder: a level may legitimately belong to no game, and picking it
     * is how you see every level at once. A build with one game still shows the picker, because *which* game
     * you are authoring for should never be something you have to infer.
     */
    if (gameSelect.dataset['games'] !== s.games.map((g) => g.name).join(' ')) {
      gameSelect.replaceChildren()
      for (const g of [{ name: '', label: '(none)' }, ...s.games]) {
        const opt = el('option')
        opt.value = g.name
        opt.textContent = g.label
        gameSelect.append(opt)
      }
      gameSelect.dataset['games'] = s.games.map((g) => g.name).join(' ')
    }
    gameSelect.value = s.game
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
    previewButton.textContent = s.previewing ? '❙❙ Motion' : '▶ Motion'
    previewButton.classList.toggle('on', s.previewing)
    previewButton.disabled = s.playing // the game clock is already running everything
    // Editing is suspended during play; the controls would lie about what they do.
    for (const control of [gameSelect, openSelect, nameInput, newButton, stepInput, snapBox]) {
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
    newButton.title = s.inPrefab ? 'leave the prefab first' : 'a new level, named now'
    openSelect.disabled = s.playing || s.inPrefab
    openSelect.title = s.inPrefab ? 'leave the prefab first' : ''
    gameSelect.disabled = s.playing || s.inPrefab
  }

  render()
  return { render }
}

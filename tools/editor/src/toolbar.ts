import { scrubField } from './controls'
import { icon, type IconName } from './icons'

/**
 * The top bar and the viewport's overlays (ADR 0149), Unity's split: the bar holds what the document is and
 * running it — its name, Motion, Play — and the tools and what the viewport shows float over the viewport,
 * where the work is.
 *
 * | where | what |
 * | --- | --- |
 * | top bar | the game button, `game › level ▾`, which opens the games window (ADR 0162) — or `game ▾ › level › prefab` inside a
 *   prefab, the level being the way back; Motion, with its
 *   clock, and Play; undo, redo, Admin for an admin (ADR 0200), the bell and who is in the room (ADR 0155) |
 * | viewport, left edge | Move, Rotate, Scale, Face |
 * | viewport, top left | Global / Local; snap and the active tool's increment |
 * | viewport, top right | Grid, Markers, Keys, Reveal — beside the navigation gizmo |
 *
 * Icons only, each named with its key in its tooltip. New and Duplicate went: the Project panel makes and
 * copies levels (ADR 0108, ADR 0110).
 *
 * Built once, then `render()` only *updates* values — except the snap increment's field, which is rebuilt
 * when the tool or the number changes, and never while it is being typed into.
 */
/**
 * The transform tools. `face` is the push/pull of ADR 0119 — grab one face of a box and drag it, the opposite
 * face staying put. Not a `TransformControls` mode: the faces are the handles, so it runs its own drag.
 */
export type GizmoMode = 'translate' | 'rotate' | 'scale' | 'face'
/** Which frame the gizmo handles point along — Unity's Local/Global button. */
export type GizmoSpace = 'world' | 'local'

export interface ToolbarState {
  /**
   * The name of the open document, without its game: a level's file name, or a prefab's.
   *
   * The **game picker and the level list are gone** (ADR 0108). A game is a folder holding its levels, so
   * both are the Project panel's tree.
   */
  name: string
  /** The game being edited, by its label; `null` for none. */
  game: string | null
  /** A prefab open on top of a level: which level it goes back to, and its own name. `null` on a level. */
  prefab: { level: string; name: string } | null
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
   * The preview clock is running (ADR 0142): every sequence in the level is playing in the viewport and
   * editing carries on.
   *
   * Separate from `playing`, which is the real game loop with pointer lock. This is the cheap answer to "what
   * does this platform actually do", which used to need entering Play.
   */
  previewing: boolean
  grid: boolean
  markers: boolean
  /**
   * The cells a game would generate on a surface, drawn in place (ADR 0120).
   *
   * Its own toggle rather than riding `markers`: fitting platforms together is exactly when spawn discs and
   * rule pillars are clutter, so the two are wanted at different times. `null` when the open level's game
   * describes no surface grid, and the button is then hidden rather than dead.
   */
  surfaceCells: boolean | null
  /**
   * Reveal everything hidden, without forgetting it (ADR 0132).
   *
   * `null` when nothing is hidden, so the button is out of the way until it means something. Local and
   * momentary: a way to look, not a change, so it is not sent to the room and not remembered across a
   * reload. It is also the way out of somebody else's hiding, which is reachable now the set is shared.
   */
  showingAll: boolean | null
  /** What undo and redo would do, and how many steps each side holds — the buttons' state and tooltips. */
  history: { undo: string | null; redo: string | null; depth: { undo: number; redo: number } }
  /** Errors said since the log was last opened: the bell's count (ADR 0155). */
  unseen: number
  /** This person is an admin (ADR 0200): the button to the admin page shows. */
  admin: boolean
}

export interface ToolbarActions {
  /** Leave the prefab for the level it was opened from. */
  back: () => void
  /** Open the games window (ADR 0162). */
  openGames: () => void
  undo: () => void
  redo: () => void
  /** Open or close the log of messages under the bell. */
  toggleLog: (anchor: HTMLElement) => void
  /** Open the admin page in a tab of its own (ADR 0200). */
  openAdmin: () => void
  setGizmo: (g: GizmoMode) => void
  setSpace: (s: GizmoSpace) => void
  setSnap: (on: boolean) => void
  setStep: (step: number) => void
  setPlaying: (on: boolean) => void
  setPreviewing: (on: boolean) => void
  setGrid: (on: boolean) => void
  setSurfaceCells: (on: boolean) => void
  setShowingAll: (on: boolean) => void
  setMarkers: (on: boolean) => void
}

export interface Toolbar {
  render: () => void
  /**
   * The Motion clock beside its button, in seconds, or `null` to hide it. Every frame the preview runs, so it
   * only writes the text when the tenth it shows has changed.
   */
  setClock: (seconds: number | null) => void
  /** The place at the right end for who is in the room (ADR 0155). */
  people: HTMLElement
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** A button that is only its icon. The tooltip is its name, and the key when it has one. */
const iconButton = (className: string, name: IconName, onClick: () => void): HTMLButtonElement => {
  const b = el('button', className)
  b.type = 'button'
  b.append(icon(name))
  b.addEventListener('click', onClick)
  return b
}

const setIcon = (b: HTMLButtonElement, name: IconName): void => {
  if (b.dataset.icon === name) return
  b.dataset.icon = name
  b.replaceChildren(icon(name))
}

const setTitle = (b: HTMLElement, title: string): void => {
  b.title = title
  b.setAttribute('aria-label', title)
}

const TOOLS: readonly { mode: GizmoMode; icon: IconName; title: string }[] = [
  { mode: 'translate', icon: 'toolMove', title: 'Move (T)' },
  { mode: 'rotate', icon: 'toolRotate', title: 'Rotate (R)' },
  { mode: 'scale', icon: 'toolScale', title: 'Scale (S)' },
  // No shortcut, Kodjo's call: the letters worth having are taken and this is a button you reach for.
  { mode: 'face', icon: 'toolFace', title: 'Face: pull one face of a box, the opposite face stays put' },
]

/**
 * `bar` is the top bar; `overlays` is the layer over the viewport, which this fills and hides while playing —
 * the viewport is the game's then, and the navigation gizmo is not drawn either.
 */
export const createToolbar = (bar: HTMLElement, overlays: HTMLElement, state: () => ToolbarState, actions: ToolbarActions): Toolbar => {
  // --- the top bar: the document, and running it ---
  const doc = el('div', 'tb-doc')
  /** The games window's button: where you are, `game › level ▾`, and the way to every other level (ADR 0162). */
  const gameButton = el('button', 'tb-game')
  gameButton.type = 'button'
  const gameText = el('span', 'tb-game-l')
  gameButton.append(gameText, icon('chevron'))
  gameButton.addEventListener('click', () => actions.openGames())
  const gameSep = el('span', 'tb-crumb-sep', '›')
  const crumb = el('button', 'tb-crumb')
  crumb.type = 'button'
  crumb.title = 'back to the level'
  crumb.addEventListener('click', () => actions.back())
  const crumbSep = el('span', 'tb-crumb-sep', '›')
  const nameText = el('span', 'tb-name')
  doc.append(gameButton, gameSep, crumb, crumbSep, nameText)

  /**
   * One toggle for the whole level, not one per object: motion is timed against other motion, so a staggered
   * row of platforms is the thing you need to look at, and the panel this replaces could only ever show one.
   */
  const motionButton = iconButton('tb-b', 'motion', () => actions.setPreviewing(!state().previewing))
  const clockText = el('span', 'tb-clock')
  clockText.hidden = true
  const playButton = iconButton('tb-b tb-play', 'play', () => actions.setPlaying(!state().playing))
  const run = el('div', 'tb-run')
  run.append(motionButton, clockText, playButton)

  // The history, and what the editor has said (ADR 0155): the status bar's undo depth and its messages, moved.
  const undoButton = iconButton('tb-b', 'undo', () => actions.undo())
  const redoButton = iconButton('tb-b', 'redo', () => actions.redo())
  const bell = iconButton('tb-b tb-bell', 'bell', () => actions.toggleLog(bell))
  const badge = el('span', 'tb-badge')
  // Only an admin's (ADR 0200): hidden, not disabled, for everyone else.
  const adminButton = iconButton('tb-b', 'admin', () => actions.openAdmin())
  setTitle(adminButton, 'Admin: the assistant’s limits and each person’s day (a tab of its own)')
  /** Who is in the room, filled by `people.ts`: the bar only gives it its place, last. */
  const people = el('div', 'tb-people')
  const end = el('div', 'tb-end')
  end.append(undoButton, redoButton, el('span', 'tb-sep'), adminButton, bell, people)

  bar.append(doc, run, end)

  // --- over the viewport: the tools, down the left edge ---
  const toolStrip = el('div', 'ov ov-tools')
  const toolButtons = new Map<GizmoMode, HTMLButtonElement>()
  for (const t of TOOLS) {
    const b = iconButton('ov-b', t.icon, () => actions.setGizmo(t.mode))
    setTitle(b, t.title)
    toolButtons.set(t.mode, b)
    toolStrip.append(b)
  }

  // --- top left: the frame the handles point along, and snapping ---
  const settings = el('div', 'ov ov-settings')
  // Local/Global, like Unity's. Three overrides it where it cannot apply (scale is always local, the
  // free-rotate ring always world), so the button only ever claims what it delivers.
  const spaceButton = iconButton('ov-b', 'shared', () => actions.setSpace(state().space === 'world' ? 'local' : 'world'))
  const snapButton = iconButton('ov-b', 'magnet', () => actions.setSnap(!state().snap))
  const stepHolder = el('div', 'ov-step')
  settings.append(spaceButton, el('div', 'ov-sep'), snapButton, stepHolder)

  // --- top right, beside the navigation gizmo: what the viewport shows ---
  const view = el('div', 'ov ov-view')
  const gridButton = iconButton('ov-b', 'grid', () => actions.setGrid(!state().grid))
  setTitle(gridButton, 'Grid')
  const markerButton = iconButton('ov-b', 'flag', () => actions.setMarkers(!state().markers))
  setTitle(markerButton, 'Markers: spawn and gameplay-rule gizmos')
  const cellsButton = iconButton('ov-b', 'keycap', () => actions.setSurfaceCells(state().surfaceCells !== true))
  setTitle(cellsButton, 'Keys: where this game would generate cells on a surface, the keyboard’s caps (ADR 0120)')
  const revealButton = iconButton('ov-b', 'enable', () => actions.setShowingAll(state().showingAll !== true))
  setTitle(revealButton, 'Reveal: show everything hidden in the viewport, without un-hiding it (ADR 0132)')
  view.append(gridButton, markerButton, cellsButton, revealButton)

  overlays.append(toolStrip, settings, view)

  /** What the snap field was built for, so it is rebuilt only when that changes. */
  let stepBuilt: { gizmo: GizmoMode; step: number } | null = null
  const renderStep = (s: ToolbarState): void => {
    if (stepBuilt !== null && stepBuilt.gizmo === s.gizmo && stepBuilt.step === s.step) return
    // Never fight the cursor: a field being typed into keeps its text until the typing is done.
    if (stepHolder.contains(document.activeElement)) return
    stepBuilt = { gizmo: s.gizmo, step: s.step }
    // The bounds belong to the tool, not to the field: 0.05–10 m, 1–90°, 0.05–5× (ADR 0114).
    const field = scrubField({
      value: s.step,
      unit: s.stepUnit,
      spec: { perPixel: s.stepLimits.grain, grain: s.stepLimits.grain, min: s.stepLimits.min, max: s.stepLimits.max },
      title: `snap increment for the ${s.gizmo} tool, in ${s.stepUnit === '×' ? 'multiples' : s.stepUnit}: drag, or click to type`,
      key: 'toolbar:step',
      commit: (v) => {
        if (Number.isFinite(v) && v > 0) actions.setStep(v)
      },
    })
    stepHolder.replaceChildren(field)
  }

  const render = (): void => {
    const s = state()

    // On a level the button says both; inside a prefab it says the game, and the level is the way back.
    const inPrefab = s.prefab !== null
    gameText.textContent = inPrefab ? (s.game ?? 'No game') : `${s.game ?? 'No game'} › ${s.name}`
    gameButton.disabled = s.playing
    setTitle(gameButton, 'Games: every game and its levels, and who is in each')
    gameSep.hidden = !inPrefab
    crumb.hidden = !inPrefab
    crumbSep.hidden = !inPrefab
    nameText.hidden = !inPrefab
    crumb.textContent = s.prefab?.level ?? ''
    crumb.disabled = s.playing
    nameText.textContent = s.prefab?.name ?? ''
    nameText.title = 'the prefab open on top of the level'

    const h = s.history
    undoButton.disabled = s.playing || h.undo === null
    redoButton.disabled = s.playing || h.redo === null
    const more = (n: number): string => (n > 1 ? ` (${n - 1} more)` : '')
    setTitle(undoButton, h.undo === null ? 'Nothing to undo (Ctrl+Z)' : `Undo ${h.undo}${more(h.depth.undo)} (Ctrl+Z)`)
    setTitle(redoButton, h.redo === null ? 'Nothing to redo (Ctrl+Y)' : `Redo ${h.redo}${more(h.depth.redo)} (Ctrl+Y)`)
    setTitle(bell, s.unseen > 0 ? `Messages: ${s.unseen} error${s.unseen === 1 ? '' : 's'} you have not seen` : 'Messages')
    badge.textContent = s.unseen > 99 ? '99+' : String(s.unseen)
    if (s.unseen > 0) bell.append(badge)
    else badge.remove()
    adminButton.hidden = !s.admin

    setIcon(playButton, s.playing ? 'stop' : 'play')
    setTitle(playButton, s.playing ? 'Stop' : 'Play')
    playButton.classList.toggle('on', s.playing)
    setTitle(motionButton, s.previewing ? 'Stop the motion preview' : 'Motion: run the level’s sequences in the viewport, without entering play')
    motionButton.classList.toggle('on', s.previewing)
    motionButton.disabled = s.playing // the game clock is already running everything

    // Editing is suspended during play, and the viewport is the game's: none of this belongs over it.
    overlays.hidden = s.playing

    for (const [mode, button] of toolButtons) button.classList.toggle('on', s.gizmo === mode)
    setIcon(spaceButton, s.space === 'local' ? 'object' : 'shared')
    setTitle(
      spaceButton,
      s.space === 'local'
        ? 'Local: the handles point along the object’s own axes. Click for Global'
        : 'Global: the handles point along the level’s axes. Click for Local',
    )
    snapButton.classList.toggle('on', s.snap)
    setTitle(snapButton, s.snap ? 'Snap is on' : 'Snap is off')
    renderStep(s)

    gridButton.classList.toggle('on', s.grid)
    markerButton.classList.toggle('on', s.markers)
    // Hidden, not disabled: a game with nothing to preview has no use for the button.
    cellsButton.hidden = s.surfaceCells === null
    cellsButton.classList.toggle('on', s.surfaceCells === true)
    revealButton.hidden = s.showingAll === null
    revealButton.classList.toggle('on', s.showingAll === true)
  }

  /** What the clock shows now, so a frame that would not change it writes nothing. */
  let shownClock: string | null = null
  const setClock = (seconds: number | null): void => {
    const text = seconds === null ? null : `${seconds.toFixed(1)} s`
    if (text === shownClock) return
    shownClock = text
    clockText.hidden = text === null
    clockText.textContent = text ?? ''
  }

  render()
  return { render, setClock, people }
}

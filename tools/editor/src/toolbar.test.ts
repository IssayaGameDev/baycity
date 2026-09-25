// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { createToolbar, type GizmoMode, type GizmoSpace, type ToolbarActions, type ToolbarState } from './toolbar'

/**
 * The top bar and the viewport's overlays (ADR 0149): what is where, what is lit, and what each press asks for.
 */

const LIMITS: Record<GizmoMode, { min: number; max: number; grain: number; unit: string }> = {
  translate: { min: 0.05, max: 10, grain: 0.05, unit: 'm' },
  rotate: { min: 1, max: 90, grain: 1, unit: '°' },
  scale: { min: 0.05, max: 5, grain: 0.05, unit: '×' },
  face: { min: 0.05, max: 10, grain: 0.05, unit: 'm' },
}

const rig = (over: Partial<ToolbarState> = {}) => {
  const bar = document.createElement('div')
  const overlays = document.createElement('div')
  document.body.replaceChildren(bar, overlays)
  const s: ToolbarState = {
    name: 'World_1',
    game: 'Keyboard',
    prefab: null,
    gizmo: 'translate',
    space: 'world',
    snap: true,
    step: 0.5,
    stepUnit: 'm',
    stepLimits: LIMITS.translate,
    playing: false,
    previewing: false,
    grid: true,
    markers: false,
    surfaceCells: null,
    showingAll: null,
    lockedBy: null,
    history: { undo: null, redo: null, depth: { undo: 0, redo: 0 } },
    unseen: 0,
    ...over,
  }
  const calls: string[] = []
  const actions: ToolbarActions = {
    back: () => calls.push('back'),
    openGames: () => calls.push('games'),
    undo: () => calls.push('undo'),
    redo: () => calls.push('redo'),
    toggleLog: () => calls.push('log'),
    setGizmo: (g) => {
      calls.push(`gizmo:${g}`)
      s.gizmo = g
      s.stepUnit = LIMITS[g].unit
      s.stepLimits = LIMITS[g]
    },
    setSpace: (sp: GizmoSpace) => calls.push(`space:${sp}`),
    setSnap: (on) => calls.push(`snap:${on}`),
    setStep: (v) => calls.push(`step:${v}`),
    setPlaying: (on) => calls.push(`play:${on}`),
    setPreviewing: (on) => calls.push(`motion:${on}`),
    setGrid: (on) => calls.push(`grid:${on}`),
    setSurfaceCells: (on) => calls.push(`cells:${on}`),
    setShowingAll: (on) => calls.push(`reveal:${on}`),
    setMarkers: (on) => calls.push(`markers:${on}`),
  }
  const toolbar = createToolbar(bar, overlays, () => s, actions)
  const titled = (root: HTMLElement, start: string): HTMLButtonElement => {
    const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.title.startsWith(start))
    if (b === undefined) throw new Error(`no button titled ${start}`)
    return b
  }
  return { bar, overlays, s, calls, toolbar, titled }
}

describe('the top bar', () => {
  it('names the level, runs it, and holds the history and the messages', () => {
    const r = rig()
    expect(r.bar.querySelector('.tb-game-l')!.textContent, 'the game button says where you are (ADR 0162)').toBe('Keyboard › World_1')
    expect(r.bar.querySelector<HTMLElement>('.tb-crumb')!.hidden, 'no way back from a level').toBe(true)
    expect([...r.bar.querySelectorAll('button')].map((b) => b.title).filter((t) => t !== 'back to the level')).toEqual([
      'Games: every game and its levels, and who is in each',
      'Motion: run the level’s sequences in the viewport, without entering play',
      'Play',
      'Nothing to undo (Ctrl+Z)',
      'Nothing to redo (Ctrl+Y)',
      'Messages',
    ])
    r.titled(r.bar, 'Play').click()
    r.titled(r.bar, 'Motion').click()
    r.titled(r.bar, 'Games').click()
    expect(r.calls).toEqual(['play:true', 'motion:true', 'games'])
  })

  it('reads level › prefab inside a prefab, and the level is the way back', () => {
    const r = rig({ prefab: { level: 'World_1', name: 'Door' } })
    const crumb = r.bar.querySelector<HTMLButtonElement>('.tb-crumb')!
    expect(crumb.hidden).toBe(false)
    expect(crumb.textContent).toBe('World_1')
    expect(r.bar.querySelector('.tb-game-l')!.textContent, 'the game alone: the level is the way back').toBe('Keyboard')
    expect(r.bar.querySelector('.tb-name')!.textContent).toBe('Door')
    crumb.click()
    expect(r.calls).toEqual(['back'])
  })

  it('turns Play into Stop while playing, and the motion preview off', () => {
    const r = rig({ playing: true })
    expect(r.titled(r.bar, 'Stop').classList.contains('on')).toBe(true)
    expect(r.titled(r.bar, 'Motion').disabled).toBe(true)
  })
})

/** What moved up from the status bar (ADR 0155): the history, the lock, the bell, the Motion clock. */
describe('what the status bar used to say', () => {
  it('says what undo and redo would do, and greys out what there is none of', () => {
    const r = rig({ history: { undo: 'move', redo: null, depth: { undo: 3, redo: 0 } } })
    const undo = r.titled(r.bar, 'Undo move')
    expect(undo.title).toBe('Undo move (2 more) (Ctrl+Z)')
    expect(undo.disabled).toBe(false)
    expect(r.titled(r.bar, 'Nothing to redo').disabled).toBe(true)
    undo.click()
    expect(r.calls).toEqual(['undo'])
  })

  it('says who holds the level when it is read-only here', () => {
    const r = rig()
    const lock = r.bar.querySelector<HTMLElement>('.tb-lock')!
    expect(lock.hidden).toBe(true)
    r.s.lockedBy = 'Ana'
    r.toolbar.render()
    expect(lock.hidden).toBe(false)
    expect(lock.textContent).toBe('Read-only · Ana has it')
  })

  it('counts the errors not yet seen on the bell, and opens the log', () => {
    const r = rig({ unseen: 2 })
    const bell = r.titled(r.bar, 'Messages')
    expect(bell.querySelector('.tb-badge')!.textContent).toBe('2')
    bell.click()
    expect(r.calls).toEqual(['log'])
    r.s.unseen = 0
    r.toolbar.render()
    expect(bell.querySelector('.tb-badge')).toBeNull()
  })

  it('shows the Motion clock beside its button while it runs', () => {
    const r = rig()
    const clock = r.bar.querySelector<HTMLElement>('.tb-clock')!
    expect(clock.hidden).toBe(true)
    r.toolbar.setClock(1.26)
    expect([clock.hidden, clock.textContent]).toEqual([false, '1.3 s'])
    r.toolbar.setClock(null)
    expect(clock.hidden).toBe(true)
  })
})

describe('over the viewport', () => {
  it('lights the active tool, and a press picks another', () => {
    const r = rig()
    const tools = [...r.overlays.querySelectorAll<HTMLButtonElement>('.ov-tools button')]
    expect(tools.map((b) => b.title.split(/[ :(]/)[0])).toEqual(['Move', 'Rotate', 'Scale', 'Face'])
    expect(tools.map((b) => b.classList.contains('on'))).toEqual([true, false, false, false])
    tools[1]!.click()
    r.toolbar.render()
    expect(r.calls).toEqual(['gizmo:rotate'])
    expect(tools.map((b) => b.classList.contains('on'))).toEqual([false, true, false, false])
  })

  it('shows the active tool’s snap increment in its own unit', () => {
    const r = rig()
    expect(r.overlays.querySelector('.ov-step .sf-u')!.textContent).toBe('m')
    expect(r.overlays.querySelector<HTMLInputElement>('.ov-step .sf-v')!.value).toBe('0.5')
    r.s.gizmo = 'rotate'
    r.s.step = 15
    r.s.stepUnit = '°'
    r.s.stepLimits = LIMITS.rotate
    r.toolbar.render()
    expect(r.overlays.querySelector('.ov-step .sf-u')!.textContent).toBe('°')
    expect(r.overlays.querySelector<HTMLInputElement>('.ov-step .sf-v')!.value).toBe('15')
  })

  it('flips the frame and the snap', () => {
    const r = rig()
    r.titled(r.overlays, 'Global').click()
    r.titled(r.overlays, 'Snap is on').click()
    expect(r.calls).toEqual(['space:local', 'snap:false'])
    r.s.space = 'local'
    r.toolbar.render()
    expect(r.titled(r.overlays, 'Local').title).toMatch(/Click for Global/)
  })

  it('keeps Keys and Reveal out of the way until they mean something', () => {
    const r = rig()
    expect(r.titled(r.overlays, 'Keys').hidden).toBe(true)
    expect(r.titled(r.overlays, 'Reveal').hidden).toBe(true)
    r.s.surfaceCells = false
    r.s.showingAll = false
    r.toolbar.render()
    expect(r.titled(r.overlays, 'Keys').hidden).toBe(false)
    r.titled(r.overlays, 'Grid').click()
    r.titled(r.overlays, 'Markers').click()
    r.titled(r.overlays, 'Keys').click()
    r.titled(r.overlays, 'Reveal').click()
    expect(r.calls).toEqual(['grid:false', 'markers:true', 'cells:true', 'reveal:true'])
    expect(r.titled(r.overlays, 'Grid').classList.contains('on')).toBe(true)
  })

  it('goes away while playing: the viewport is the game’s', () => {
    const r = rig()
    expect(r.overlays.hidden).toBe(false)
    r.s.playing = true
    r.toolbar.render()
    expect(r.overlays.hidden).toBe(true)
  })
})

import { availableLocales, getLocale, isRtl, onLocaleChange, setLocale, t } from '@mp/i18n'
import { uiButton, uiGroup, uiLabel, uiList, uiPanel, uiSlider, type ListItem, type UiOverlay } from '@mp/render-pixi'

/**
 * The parkour pause screen (ADR 0015 — Pixi UI). Two views over a dim:
 *  - main: a Settings window (mouse sensitivity + a Language button) beside a Players window
 *    (the roster); footer Restart (at last checkpoint) + Resume; a ✕ resumes.
 *  - language: a grid of every language (endonyms, current highlighted); tapping one applies
 *    it and returns to main — no scroll, no back button (tap your current language to exit
 *    unchanged). Flags are deliberately avoided (flags aren't languages — ADR 0016).
 *
 * All text goes through `@mp/i18n` and re-reads live on locale change. Responsive: the active
 * view uniformly scales to fit (never cropped); RTL locales mirror the main layout. Placeholder-
 * skinned via the render-pixi widgets.
 */
export interface Range01 {
  get: () => number
  set: (t: number) => void
}
export interface PauseMenuHooks {
  onResume: () => void
  onRestart: () => void
  sensitivity: Range01
  players: () => ListItem[]
}
export interface PauseMenu {
  open: () => void
  close: () => void
  isOpen: () => boolean
  layout: () => void
}

const SETTINGS_W = 360
const SETTINGS_H = 250
const PLAYERS_W = 220
const GAP = 16
const MARGIN = 16

// Language picker grid.
const COLS = 3
const CELL_W = 150
const CELL_H = 44
const CELL_GAP = 12
const GRID_W = COLS * CELL_W + (COLS - 1) * CELL_GAP
const GRID_ROWS = Math.ceil(availableLocales().length / COLS)
const GRID_H = GRID_ROWS * CELL_H + (GRID_ROWS - 1) * CELL_GAP
const PICKER_W = GRID_W + 40
const PICKER_H = 64 + GRID_H + 20
const SELECTED = 0x3b82f6
const UNSELECTED = 0x475569

export const createPauseMenu = (overlay: UiOverlay, hooks: PauseMenuHooks): PauseMenu => {
  const dim = uiPanel({ width: 8192, height: 8192, color: 0x000000, alpha: 0.55, radius: 0 })
  let open = false
  let view: 'main' | 'language' = 'main'

  // --- main view: settings + players ---
  const content = uiGroup()

  const settings = uiPanel({ width: SETTINGS_W, height: SETTINGS_H })
  const title = uiLabel(t('pause.title'), { size: 22, weight: '700' })
  const close = uiButton({ label: '✕', width: 34, height: 34, color: UNSELECTED, onClick: hooks.onResume })
  const sensLabel = uiLabel(t('pause.sensitivity'), { size: 14, color: 0x9aa4b2 })
  const sens = uiSlider({ width: SETTINGS_W - 40, value: hooks.sensitivity.get(), onChange: hooks.sensitivity.set })
  sens.view.position.set(20, 80)
  const langLabel = uiLabel(t('pause.language'), { size: 14, color: 0x9aa4b2 })
  const langBtn = uiButton({ label: '', width: SETTINGS_W - 40, height: 36, color: UNSELECTED, onClick: () => setView('language') })
  langBtn.view.position.set(20, 146)
  const restart = uiButton({ label: t('pause.restart'), width: 150, color: UNSELECTED, onClick: hooks.onRestart })
  const resume = uiButton({ label: t('pause.resume'), width: 150, onClick: hooks.onResume })
  settings.addChild(title, close.view, sensLabel, sens.view, langLabel, langBtn.view, restart.view, resume.view)

  const players = uiPanel({ width: PLAYERS_W, height: SETTINGS_H })
  const pTitle = uiLabel(t('pause.players'), { size: 16, weight: '700' })
  const list = uiList({ width: PLAYERS_W - 24, height: SETTINGS_H - 52 })
  list.view.position.set(12, 42)
  players.addChild(pTitle, list.view)

  content.addChild(settings, players)

  // --- language view: a grid of endonyms ---
  const langView = uiGroup()
  const picker = uiPanel({ width: PICKER_W, height: PICKER_H })
  const pickerTitle = uiLabel(t('pause.language'), { size: 20, weight: '700' })
  picker.addChild(pickerTitle)
  const langCells = availableLocales().map((loc, i) => {
    const btn = uiButton({
      label: loc.name,
      width: CELL_W,
      height: CELL_H,
      color: UNSELECTED,
      onClick: () => {
        setLocale(loc.code) // same-locale is ignored; different fires onLocaleChange → refresh
        setView('main')
      },
    })
    btn.view.position.set(20 + (i % COLS) * (CELL_W + CELL_GAP), 64 + Math.floor(i / COLS) * (CELL_H + CELL_GAP))
    picker.addChild(btn.view)
    return { code: loc.code, btn }
  })
  langView.addChild(picker)

  const localeName = (): string => availableLocales().find((l) => l.code === getLocale())?.name ?? getLocale()
  const highlightCurrent = (): void => {
    for (const c of langCells) c.btn.setColor(c.code === getLocale() ? SELECTED : UNSELECTED)
  }

  // Mirror the main-view layout for RTL locales; right-align titles/labels.
  const applyDirection = (): void => {
    const rtl = isRtl()
    title.anchor.set(rtl ? 1 : 0, 0)
    title.position.set(rtl ? SETTINGS_W - 20 : 20, 16)
    close.view.position.set(rtl ? 12 : SETTINGS_W - 46, 14)
    sensLabel.anchor.set(rtl ? 1 : 0, 0)
    sensLabel.position.set(rtl ? SETTINGS_W - 20 : 20, 56)
    langLabel.anchor.set(rtl ? 1 : 0, 0)
    langLabel.position.set(rtl ? SETTINGS_W - 20 : 20, 122)
    restart.view.position.set(rtl ? SETTINGS_W - 170 : 20, SETTINGS_H - 56)
    resume.view.position.set(rtl ? 20 : SETTINGS_W - 170, SETTINGS_H - 56)
    pTitle.anchor.set(rtl ? 1 : 0, 0)
    pTitle.position.set(rtl ? PLAYERS_W - 16 : 16, 14)
    pickerTitle.anchor.set(rtl ? 1 : 0, 0)
    pickerTitle.position.set(rtl ? PICKER_W - 20 : 20, 16)
  }

  const layout = (): void => {
    applyDirection()
    const rtl = isRtl()
    const availW = overlay.width - MARGIN * 2
    const availH = overlay.height - MARGIN * 2
    let w: number
    let h: number
    if (view === 'language') {
      w = PICKER_W
      h = PICKER_H
    } else if (SETTINGS_W + GAP + PLAYERS_W <= availW) {
      settings.position.set(rtl ? PLAYERS_W + GAP : 0, 0)
      players.position.set(rtl ? 0 : SETTINGS_W + GAP, 0)
      w = SETTINGS_W + GAP + PLAYERS_W
      h = SETTINGS_H
    } else {
      settings.position.set(0, 0)
      players.position.set(0, SETTINGS_H + GAP)
      w = Math.max(SETTINGS_W, PLAYERS_W)
      h = SETTINGS_H * 2 + GAP
    }
    const group = view === 'language' ? langView : content
    const scale = Math.min(1, availW / w, availH / h)
    group.scale.set(scale)
    group.position.set((overlay.width - w * scale) / 2, (overlay.height - h * scale) / 2)
  }

  const setView = (v: 'main' | 'language'): void => {
    view = v
    if (!open) return
    overlay.root.removeChild(content, langView)
    overlay.root.addChild(v === 'language' ? langView : content)
    if (v === 'language') highlightCurrent()
    layout()
  }

  const refresh = (): void => {
    title.text = t('pause.title')
    sensLabel.text = t('pause.sensitivity')
    langLabel.text = t('pause.language')
    langBtn.setLabel(localeName())
    restart.setLabel(t('pause.restart'))
    resume.setLabel(t('pause.resume'))
    pTitle.text = t('pause.players')
    pickerTitle.text = t('pause.language')
    list.setItems(hooks.players())
    highlightCurrent()
    layout()
  }
  onLocaleChange(refresh)

  return {
    open: () => {
      if (open) return
      open = true
      view = 'main'
      langBtn.setLabel(localeName())
      sens.setValue(hooks.sensitivity.get())
      list.setItems(hooks.players())
      overlay.root.addChild(dim, content)
      layout()
    },
    close: () => {
      if (!open) return
      open = false
      view = 'main'
      overlay.root.removeChild(dim, content, langView)
    },
    isOpen: () => open,
    layout,
  }
}

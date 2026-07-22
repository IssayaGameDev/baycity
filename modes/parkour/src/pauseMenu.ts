import { availableLocales, getLocale, onLocaleChange, setLocale, t } from '@mp/i18n'
import { uiButton, uiGroup, uiLabel, uiList, uiPanel, uiSlider, type ListItem, type UiOverlay } from '@mp/render-pixi'

/**
 * The parkour pause screen (ADR 0015 — Pixi UI). A Settings window (mouse sensitivity +
 * language) beside a Players window (the roster), over a dim. Footer: Restart (at last
 * checkpoint) + Resume; a ✕ also resumes. All text goes through `@mp/i18n`; the language
 * selector cycles locales and the menu refreshes live. Placeholder-skinned via the render-pixi
 * widgets (Layer Lab sprite skin is a later step).
 *
 * Responsive: windows sit side by side when there's room, stack when narrow, and the whole
 * group uniformly scales to fit — never cropped. Sliders speak 0..1; the host maps the range.
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

const localeName = (): string => availableLocales().find((l) => l.code === getLocale())?.name ?? getLocale()
const cycleLocale = (): void => {
  const locs = availableLocales()
  const i = locs.findIndex((l) => l.code === getLocale())
  setLocale(locs[(i + 1) % locs.length]!.code)
}

export const createPauseMenu = (overlay: UiOverlay, hooks: PauseMenuHooks): PauseMenu => {
  const dim = uiPanel({ width: 8192, height: 8192, color: 0x000000, alpha: 0.55, radius: 0 })
  const content = uiGroup() // both windows; scaled/centered as one unit

  // --- settings window ---
  const settings = uiPanel({ width: SETTINGS_W, height: SETTINGS_H })
  const title = uiLabel(t('pause.title'), { size: 22, weight: '700' })
  title.position.set(20, 16)
  const close = uiButton({ label: '✕', width: 34, height: 34, color: 0x475569, onClick: hooks.onResume })
  close.view.position.set(SETTINGS_W - 46, 14)

  const sensLabel = uiLabel(t('pause.sensitivity'), { size: 14, color: 0x9aa4b2 })
  sensLabel.position.set(20, 56)
  const sens = uiSlider({ width: SETTINGS_W - 40, value: hooks.sensitivity.get(), onChange: hooks.sensitivity.set })
  sens.view.position.set(20, 80)

  const langLabel = uiLabel(t('pause.language'), { size: 14, color: 0x9aa4b2 })
  langLabel.position.set(20, 122)
  const lang = uiButton({ label: localeName(), width: SETTINGS_W - 40, height: 36, color: 0x475569, onClick: cycleLocale })
  lang.view.position.set(20, 146)

  const restart = uiButton({ label: t('pause.restart'), width: 150, color: 0x475569, onClick: hooks.onRestart })
  restart.view.position.set(20, SETTINGS_H - 56)
  const resume = uiButton({ label: t('pause.resume'), width: 150, onClick: hooks.onResume })
  resume.view.position.set(SETTINGS_W - 170, SETTINGS_H - 56)
  settings.addChild(title, close.view, sensLabel, sens.view, langLabel, lang.view, restart.view, resume.view)

  // --- players window ---
  const players = uiPanel({ width: PLAYERS_W, height: SETTINGS_H })
  const pTitle = uiLabel(t('pause.players'), { size: 16, weight: '700' })
  pTitle.position.set(16, 14)
  const list = uiList({ width: PLAYERS_W - 24, height: SETTINGS_H - 52 })
  list.view.position.set(12, 42)
  players.addChild(pTitle, list.view)

  content.addChild(settings, players)

  let open = false
  const layout = (): void => {
    const availW = overlay.width - MARGIN * 2
    const availH = overlay.height - MARGIN * 2
    let w: number
    let h: number
    if (SETTINGS_W + GAP + PLAYERS_W <= availW) {
      settings.position.set(0, 0)
      players.position.set(SETTINGS_W + GAP, 0)
      w = SETTINGS_W + GAP + PLAYERS_W
      h = SETTINGS_H
    } else {
      settings.position.set(0, 0)
      players.position.set(0, SETTINGS_H + GAP)
      w = Math.max(SETTINGS_W, PLAYERS_W)
      h = SETTINGS_H * 2 + GAP
    }
    const scale = Math.min(1, availW / w, availH / h)
    content.scale.set(scale)
    content.position.set((overlay.width - w * scale) / 2, (overlay.height - h * scale) / 2)
  }

  // Re-read every label when the locale changes (and refresh the roster's localized "(you)").
  const refresh = (): void => {
    title.text = t('pause.title')
    sensLabel.text = t('pause.sensitivity')
    langLabel.text = t('pause.language')
    lang.setLabel(localeName())
    restart.setLabel(t('pause.restart'))
    resume.setLabel(t('pause.resume'))
    pTitle.text = t('pause.players')
    list.setItems(hooks.players())
    layout()
  }
  onLocaleChange(refresh)

  return {
    open: () => {
      if (open) return
      open = true
      sens.setValue(hooks.sensitivity.get())
      list.setItems(hooks.players())
      overlay.root.addChild(dim, content)
      layout()
    },
    close: () => {
      if (!open) return
      open = false
      overlay.root.removeChild(dim, content)
    },
    isOpen: () => open,
    layout,
  }
}

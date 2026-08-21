import { getLocale, matchLocale, onLocaleChange, setLocale, t, type TranslationKey } from '@mp/i18n'

/**
 * The status line, and the locale it is written in (ADR 0016).
 *
 * One thing rather than two, because they are the same thing: the line is **state-driven** — it holds a
 * translation key, not a string — so switching language has to re-render whatever is currently showing.
 * A `textContent =` at the call site could not do that.
 *
 * Locale is detected once (stored override, else browser) and persisted on change, best-effort: storage
 * throws in a locked-down browser and a language that does not persist beats a page that does not load.
 */
const LOCALE_KEY = 'mp.locale'

export interface StatusLine {
  /** Show this message, and keep showing it across a locale change. */
  set: (key: TranslationKey, params?: Record<string, string | number>) => void
}

export const createStatusLine = (el: HTMLElement): StatusLine => {
  let current: { key: TranslationKey; params?: Record<string, string | number> } = { key: 'status.connecting' }
  const render = (): void => {
    el.textContent = t(current.key, current.params)
  }

  try {
    setLocale(localStorage.getItem(LOCALE_KEY) ?? matchLocale(navigator.language))
  } catch {
    setLocale(matchLocale(navigator.language))
  }
  onLocaleChange(() => {
    try {
      localStorage.setItem(LOCALE_KEY, getLocale())
    } catch {
      // best-effort persistence
    }
    render()
  })
  render()

  return {
    set: (key, params) => {
      current = params !== undefined ? { key, params } : { key }
      render()
    },
  }
}

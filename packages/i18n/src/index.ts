import { ar, en, es, fr, ja, ko, nl, pt, zh, type TranslationKey } from './locales'

/**
 * @mp/i18n — tiny, dependency-free localization for the stack (ADR 0016). Typed string
 * keys (English is the source of truth), `{param}` interpolation, browser-locale matching,
 * a runtime locale switch, and a change subscription. Headless (no DOM): the browser
 * consumer does detection/persistence and calls `setLocale`. Rich features (plurals, dates)
 * would justify a library later; this covers the UI now.
 */
export const I18N_VERSION = '0.0.0' as const
export type { TranslationKey } from './locales'

export interface LocaleInfo {
  code: string
  /** Endonym — the language's own name, for a selector. */
  name: string
  /** Right-to-left script (layout mirroring is the consumer's concern). */
  rtl?: boolean
}

export const LOCALES: readonly LocaleInfo[] = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'pt', name: 'Português' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'zh', name: '中文' },
  { code: 'ar', name: 'العربية', rtl: true },
]

const tables: Record<string, Partial<Record<TranslationKey, string>>> = { en, es, fr, nl, pt, ja, ko, zh, ar }

let current = 'en'
const listeners = new Set<() => void>()

export const availableLocales = (): readonly LocaleInfo[] => LOCALES
export const getLocale = (): string => current
export const isRtl = (code: string = current): boolean => LOCALES.some((l) => l.code === code && l.rtl === true)

/** Switch locale and notify subscribers. Ignores unknown or unchanged codes. */
export const setLocale = (code: string): void => {
  if (tables[code] === undefined || code === current) return
  current = code
  for (const fn of listeners) fn()
}

/** Subscribe to locale changes; returns an unsubscribe. */
export const onLocaleChange = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Best supported locale for a preferred tag (e.g. `pt-BR` → `pt`); English if none match. */
export const matchLocale = (preferred: string): string => {
  const p = preferred.toLowerCase()
  return LOCALES.find((l) => p.startsWith(l.code))?.code ?? 'en'
}

/** Translate `key` in the current locale (falling back to English), interpolating `{param}`s. */
export const t = (key: TranslationKey, params?: Record<string, string | number>): string => {
  let s = tables[current]?.[key] ?? en[key] ?? key
  if (params !== undefined) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v))
  return s
}

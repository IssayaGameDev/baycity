import { afterEach, describe, expect, it } from 'vitest'

import { getLocale, matchLocale, setLocale, t } from './index'

afterEach(() => setLocale('en'))

describe('i18n', () => {
  it('returns the current locale string and switches', () => {
    expect(t('pause.resume')).toBe('Resume')
    setLocale('fr')
    expect(getLocale()).toBe('fr')
    expect(t('pause.resume')).toBe('Reprendre')
  })

  it('interpolates params', () => {
    expect(t('pause.self', { name: 'Lynx' })).toBe('Lynx (you)')
    setLocale('es')
    expect(t('pause.self', { name: 'Lynx' })).toBe('Lynx (tú)')
  })

  it('ignores an unknown locale (stays put)', () => {
    setLocale('fr')
    setLocale('klingon')
    expect(getLocale()).toBe('fr')
  })

  it('matchLocale maps browser tags to supported codes, else English', () => {
    expect(matchLocale('pt-BR')).toBe('pt')
    expect(matchLocale('JA')).toBe('ja')
    expect(matchLocale('de-DE')).toBe('en') // unsupported → fallback
  })
})

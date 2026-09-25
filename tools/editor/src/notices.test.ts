// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createNotices, LOG_SIZE, logNotice, MAX_TOASTS, toastToDrop, TOAST_MS, type Notice } from './notices'

/**
 * What the editor says (ADR 0155): toasts that go by kind, a log that keeps everything, a banner for what stays
 * broken, and a count on the bell for errors not yet seen.
 */

describe('the log', () => {
  it('counts the same message said again rather than stacking copies', () => {
    const log: Notice[] = []
    logNotice(log, 'warn', 'nothing to undo', 1, 1)
    const again = logNotice(log, 'warn', 'nothing to undo', 2, 2)
    expect(again.repeated).toBe(true)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ count: 2, at: 2 })
  })

  it('keeps a different kind or text apart, newest first, and only so many', () => {
    const log: Notice[] = []
    logNotice(log, 'ok', 'saved', 1, 1)
    logNotice(log, 'error', 'saved', 2, 2)
    logNotice(log, 'ok', 'undid: move', 3, 3)
    expect(log.map((n) => n.id)).toEqual([3, 2, 1])
    for (let i = 0; i < LOG_SIZE + 10; i += 1) logNotice(log, 'ok', `m${i}`, i, 10 + i)
    expect(log).toHaveLength(LOG_SIZE)
  })

  it('drops the oldest toast that is not an error first', () => {
    expect(toastToDrop([{ kind: 'error' }, { kind: 'ok' }, { kind: 'warn' }])).toBe(1)
    expect(toastToDrop([{ kind: 'error' }, { kind: 'error' }])).toBe(0)
  })
})

describe('the toasts, the bell and the banner', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const rig = () => {
    const toasts = document.createElement('div')
    const banner = document.createElement('div')
    document.body.replaceChildren(toasts, banner)
    let changes = 0
    const notices = createNotices(toasts, banner, () => void (changes += 1))
    const texts = (): string[] => [...toasts.querySelectorAll('.toast:not(.gone) .toast-t')].map((t) => t.textContent ?? '')
    return { toasts, banner, notices, texts, changes: () => changes }
  }

  it('fades a confirmation, keeps a refusal a little longer, and an error until it is closed', () => {
    const r = rig()
    r.notices.ok('saved')
    r.notices.warn('nowhere to put that')
    r.notices.error('save failed')
    expect(r.texts()).toEqual(['saved', 'nowhere to put that', 'save failed'])
    vi.advanceTimersByTime(TOAST_MS.ok! + 1)
    expect(r.texts()).toEqual(['nowhere to put that', 'save failed'])
    vi.advanceTimersByTime(TOAST_MS.warn!)
    expect(r.texts()).toEqual(['save failed'])
    vi.advanceTimersByTime(60_000)
    expect(r.texts(), 'an error stays').toEqual(['save failed'])
    r.toasts.querySelector<HTMLButtonElement>('.toast-x')!.click()
    expect(r.texts()).toEqual([])
  })

  it('counts a repeat on the toast still showing, and keeps it up', () => {
    const r = rig()
    r.notices.warn('nothing to undo')
    vi.advanceTimersByTime(TOAST_MS.warn! - 100)
    r.notices.warn('nothing to undo')
    vi.advanceTimersByTime(200)
    expect(r.texts()).toEqual(['nothing to undo'])
    expect(r.toasts.querySelector('.toast-n')!.textContent).toBe('×2')
  })

  it('shows only so many at once', () => {
    const r = rig()
    for (let i = 0; i < MAX_TOASTS + 3; i += 1) r.notices.ok(`m${i}`)
    expect(r.texts()).toHaveLength(MAX_TOASTS)
    expect(r.texts().at(-1)).toBe(`m${MAX_TOASTS + 2}`)
    expect(r.notices.log(), 'the log keeps every one').toHaveLength(MAX_TOASTS + 3)
  })

  it('counts the errors not yet seen, until the log is opened', () => {
    const r = rig()
    r.notices.ok('saved')
    r.notices.error('load failed')
    r.notices.error('save failed')
    expect(r.notices.unseen()).toBe(2)
    const bell = document.createElement('button')
    document.body.append(bell)
    r.notices.toggleLog(bell)
    expect(r.notices.unseen()).toBe(0)
    expect(r.changes(), 'the bell was told each time').toBe(3)
    expect([...document.querySelectorAll('.nlog-t')].map((t) => t.textContent)).toEqual(['save failed', 'load failed', 'saved'])
  })

  it('keeps a banner line per problem until it is cleared', () => {
    const r = rig()
    expect(r.banner.hidden).toBe(true)
    r.notices.setProblem('main', 'assets did not load')
    r.notices.setProblem('push', 'not on GitHub yet: rejected')
    expect([...r.banner.querySelectorAll('.banner-l')].map((l) => l.textContent)).toEqual(['assets did not load', 'not on GitHub yet: rejected'])
    r.notices.setProblem('main', '')
    r.notices.setProblem('push', '')
    expect(r.banner.hidden).toBe(true)
  })
})

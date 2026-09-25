import { openPopover, popoverOpenFor, closePopover } from './controls'
import { icon, type IconName } from './icons'

/**
 * What the editor says (ADR 0155): toasts in the viewport's corner, a log of everything behind the top bar's
 * bell, and a banner for what stays broken. They replaced the status bar, one line that carried eighty messages,
 * the selection, the room, the undo depth and the clipboard, each pushing the next off its end.
 *
 * A message has a **kind**, and the kind decides how long it is in the way:
 *
 * | kind | for | toast |
 * | --- | --- | --- |
 * | `ok` | it happened: saved, undid, applied | fades after `TOAST_MS.ok` |
 * | `warn` | it did not, and why: nowhere to put that, Ana has it | fades after `TOAST_MS.warn` |
 * | `error` | something failed: save, load, the server | stays until closed |
 *
 * The same message again, straight after, is one entry counting up rather than a stack of copies.
 */

export type NoticeKind = 'ok' | 'warn' | 'error'

/** How the rest of the editor speaks: one call per kind, so the kind is chosen where the message is written. */
export interface Notify {
  readonly ok: (text: string) => void
  readonly warn: (text: string) => void
  readonly error: (text: string) => void
}

export interface Notice {
  readonly id: number
  readonly kind: NoticeKind
  readonly text: string
  /** When it was last said, ms since the epoch — a repeat moves it. */
  at: number
  /** How many times in a row. */
  count: number
}

/** How long a toast stays, by kind; `null` stays until it is closed. */
export const TOAST_MS: Readonly<Record<NoticeKind, number | null>> = { ok: 2500, warn: 5000, error: null }
/** Toasts on screen at once; past it the oldest goes, an error last. */
export const MAX_TOASTS = 4
/** Entries the log keeps. */
export const LOG_SIZE = 200

/**
 * Add to the log, newest first: the newest entry again (same kind, same text) counts up instead. Returns the
 * entry and whether it was a repeat. Pure, so the rule has a test.
 */
export const logNotice = (log: Notice[], kind: NoticeKind, text: string, at: number, id: number): { notice: Notice; repeated: boolean } => {
  const last = log[0]
  if (last !== undefined && last.kind === kind && last.text === text) {
    last.count += 1
    last.at = at
    return { notice: last, repeated: true }
  }
  const notice: Notice = { id, kind, text, at, count: 1 }
  log.unshift(notice)
  if (log.length > LOG_SIZE) log.length = LOG_SIZE
  return { notice, repeated: false }
}

/** Which toast goes when there are too many: the oldest that is not an error, else the oldest. */
export const toastToDrop = (shown: readonly Pick<Notice, 'kind'>[]): number => {
  const i = shown.findIndex((n) => n.kind !== 'error')
  return i < 0 ? 0 : i
}

const ICON: Readonly<Record<NoticeKind, IconName>> = { ok: 'check', warn: 'warn', error: 'close' }

/** Problems that stay until fixed, by slot. `main` is the editor's own, `push` the server's content push. */
export type ProblemSlot = 'main' | 'push'

export interface Notices extends Notify {
  /** Set or clear (`''`) a lasting problem: the banner shows every one that is set. */
  readonly setProblem: (slot: ProblemSlot, text: string) => void
  /** Errors said since the log was last opened — the bell's count. */
  readonly unseen: () => number
  /** Open the log under `anchor`, or close it if it is open there. */
  readonly toggleLog: (anchor: HTMLElement) => void
  readonly log: () => readonly Notice[]
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const clock = (at: number): string => {
  const d = new Date(at)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/**
 * `toasts` is the corner the toasts stack in, `banner` the strip over the viewport. `onChange` runs when the
 * bell's count changes.
 */
export const createNotices = (toasts: HTMLElement, banner: HTMLElement, onChange: () => void): Notices => {
  const log: Notice[] = []
  let nextId = 1
  let unseen = 0
  /** On screen now, oldest first, with the timer that takes each away. */
  const shown: { notice: Notice; el: HTMLElement; timer: number | null }[] = []

  const dismiss = (id: number): void => {
    const i = shown.findIndex((s) => s.notice.id === id)
    if (i < 0) return
    const [s] = shown.splice(i, 1)
    if (s!.timer !== null) clearTimeout(s!.timer)
    s!.el.classList.add('gone')
    setTimeout(() => s!.el.remove(), 180)
  }

  const schedule = (s: (typeof shown)[number]): void => {
    if (s.timer !== null) clearTimeout(s.timer)
    const ms = TOAST_MS[s.notice.kind]
    s.timer = ms === null ? null : window.setTimeout(() => dismiss(s.notice.id), ms)
  }

  const draw = (s: (typeof shown)[number]): void => {
    const n = s.notice
    s.el.replaceChildren(icon(ICON[n.kind], 'ic toast-i'), el('span', 'toast-t', n.text))
    if (n.count > 1) s.el.append(el('span', 'toast-n', `×${n.count}`))
    if (n.kind === 'error') {
      const close = el('button', 'toast-x')
      close.type = 'button'
      close.title = 'close'
      close.append(icon('close'))
      s.el.append(close)
    }
  }

  const say = (kind: NoticeKind, text: string): void => {
    const { notice, repeated } = logNotice(log, kind, text, Date.now(), nextId)
    if (!repeated) nextId += 1
    if (kind === 'error') {
      unseen += 1
      onChange()
    }
    const on = shown.find((s) => s.notice.id === notice.id)
    if (on !== undefined) {
      // Said again while still up: count it, keep it up, and bring it to the front.
      draw(on)
      schedule(on)
      shown.splice(shown.indexOf(on), 1)
      shown.push(on)
      toasts.append(on.el)
      return
    }
    const node = el('div', `toast toast-${kind}`)
    node.setAttribute('role', kind === 'error' ? 'alert' : 'status')
    const s = { notice, el: node, timer: null as number | null }
    node.addEventListener('click', () => dismiss(notice.id))
    draw(s)
    shown.push(s)
    toasts.append(node)
    schedule(s)
    while (shown.length > MAX_TOASTS) dismiss(shown[toastToDrop(shown.map((x) => x.notice))]!.notice.id)
  }

  const problems: Record<ProblemSlot, string> = { main: '', push: '' }
  const drawBanner = (): void => {
    const lines = (Object.values(problems) as string[]).filter((t) => t !== '')
    banner.hidden = lines.length === 0
    banner.replaceChildren(
      ...lines.map((t) => {
        const line = el('div', 'banner-l')
        line.append(icon('warn', 'ic'), el('span', undefined, t))
        return line
      }),
    )
  }
  drawBanner()

  const logView = (): HTMLElement => {
    const box = el('div', 'nlog')
    const head = el('div', 'nlog-h')
    head.append(el('span', 'nlog-title', 'Messages'))
    const clear = el('button', 'nlog-clear', 'Clear')
    clear.type = 'button'
    clear.addEventListener('click', () => {
      log.length = 0
      box.replaceWith(logView())
    })
    head.append(clear)
    box.append(head)
    const list = el('div', 'nlog-list')
    if (log.length === 0) list.append(el('div', 'nlog-empty', 'Nothing yet'))
    for (const n of log) {
      const row = el('div', `nlog-r nlog-${n.kind}`)
      row.append(el('span', 'nlog-at', clock(n.at)), icon(ICON[n.kind], 'ic nlog-i'), el('span', 'nlog-t', n.text))
      if (n.count > 1) row.append(el('span', 'toast-n', `×${n.count}`))
      list.append(row)
    }
    box.append(list)
    return box
  }

  return {
    ok: (text) => say('ok', text),
    warn: (text) => say('warn', text),
    error: (text) => say('error', text),
    setProblem: (slot, text) => {
      if (problems[slot] === text) return
      problems[slot] = text
      drawBanner()
    },
    unseen: () => unseen,
    toggleLog: (anchor) => {
      if (popoverOpenFor(anchor)) {
        closePopover()
        return
      }
      openPopover(anchor, logView(), { className: 'pop-log' })
      if (unseen !== 0) {
        unseen = 0
        onChange()
      }
    },
    log: () => log,
  }
}

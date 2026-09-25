import type { Connection } from './collab'
import { closePopover, openPopover, popoverOpenFor } from './controls'
import { icon } from './icons'

/**
 * Who is in the room, at the top bar's right end (ADR 0155): everyone's icon in their colour — the colour of
 * their outline in the viewport and their badge in the Hierarchy — and yours last, with a dot for how this tab
 * is connected. Clicking someone opens a card: what they have selected, **Focus** (frame it, open the
 * Hierarchy down to it) and **Follow** (your camera copies theirs until you move it).
 *
 * One icon per connection rather than per person: two tabs are two holders with two colours, and one icon
 * could not say which outline is which.
 */

export interface Person {
  connId: string
  name: string
  /** CSS colour. */
  colour: string
}

export interface PeopleState {
  /** This tab. `colour` is the one the others see it in; `null` outside a live room. */
  me: { name: string; colour: string | null; connection: Connection | null } | null
  /** Everyone else in the room, in the order they came. */
  others: readonly Person[]
  /** Whose camera this tab copies. */
  following: string | null
  /** The labels of what someone has selected. Asked only when their card opens: it walks the document. */
  selected: (connId: string) => readonly string[]
}

export interface PeopleActions {
  focus: (connId: string) => void
  follow: (connId: string | null) => void
}

/** Up to two letters: the first of the first two words, or the first of one. */
export const initials = (name: string): string => {
  const words = name.trim().split(/[\s._-]+/).filter((w) => w !== '')
  if (words.length === 0) return '?'
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')
}

/** What someone has selected, in a line: nothing, one or two names, or two and how many more. */
export const selectedText = (names: readonly string[]): string => {
  if (names.length === 0) return 'Nothing selected'
  if (names.length <= 2) return `Selected: ${names.join(', ')}`
  return `Selected: ${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}

const CONNECTION_TEXT: Record<Connection, string> = {
  live: 'connected',
  connecting: 'connecting…',
  lost: 'not connected: reload the page',
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export interface People {
  /** Redraw the icons. Cheap when nothing changed: they are rebuilt only when what they show did. */
  render: () => void
}

export const createPeople = (slot: HTMLElement, state: () => PeopleState, actions: PeopleActions): People => {
  /** What the icons were last drawn from, so a render that would change nothing touches nothing. */
  let drawn = ''
  /** The icon whose card is open, and whose it is. */
  let carded: { anchor: HTMLElement; connId: string } | null = null

  const card = (person: Person, selected: readonly string[], following: boolean): HTMLElement => {
    const root = el('div', 'pcard')
    root.style.setProperty('--pc', person.colour)
    const head = el('div', 'pcard-h')
    head.append(el('span', 'pcard-dot'), el('span', 'pcard-name', person.name))
    const sel = el('div', 'pcard-sel', selectedText(selected))
    const buttons = el('div', 'pcard-b')
    const focus = el('button', 'pcard-btn')
    focus.type = 'button'
    focus.append(icon('focus'), el('span', undefined, 'Focus'))
    focus.disabled = selected.length === 0
    focus.title = focus.disabled ? 'They have nothing selected' : 'Frame what they have selected, and open the Hierarchy down to it'
    focus.addEventListener('click', () => {
      closePopover()
      carded = null
      actions.focus(person.connId)
    })
    const follow = el('button', `pcard-btn${following ? ' on' : ''}`)
    follow.type = 'button'
    follow.append(icon(following ? 'stop' : 'enable'), el('span', undefined, following ? 'Stop following' : 'Follow'))
    follow.title = following ? 'Stop copying their camera' : 'Your camera copies theirs until you move it'
    follow.addEventListener('click', () => {
      closePopover()
      carded = null
      actions.follow(following ? null : person.connId)
    })
    buttons.append(focus, follow)
    root.append(head, sel, buttons)
    return root
  }

  const openCard = (anchor: HTMLElement, connId: string): void => {
    if (popoverOpenFor(anchor)) {
      closePopover()
      carded = null
      return
    }
    const s = state()
    const person = s.others.find((p) => p.connId === connId)
    if (person === undefined) return
    openPopover(anchor, card(person, s.selected(connId), s.following === connId), { className: 'pop-person', onDismiss: () => (carded = null) })
    carded = { anchor, connId }
  }

  const render = (): void => {
    const s = state()
    const key = JSON.stringify([s.me, s.others.map((p) => [p.connId, p.name, p.colour]), s.following])
    if (key === drawn) return
    drawn = key

    // Someone whose card is open left, or the icons are about to be rebuilt under it: the card goes too.
    if (carded !== null && popoverOpenFor(carded.anchor)) closePopover()
    carded = null

    const icons: HTMLElement[] = []
    for (const p of s.others) {
      const b = el('button', `pp${s.following === p.connId ? ' on' : ''}`, initials(p.name))
      b.type = 'button'
      b.style.setProperty('--pc', p.colour)
      b.title = s.following === p.connId ? `${p.name} · you are following them` : p.name
      b.setAttribute('aria-label', b.title)
      b.addEventListener('click', () => openCard(b, p.connId))
      icons.push(b)
    }
    if (s.me !== null) {
      const mine = el('span', 'pp me', initials(s.me.name))
      if (s.me.colour !== null) mine.style.setProperty('--pc', s.me.colour)
      const c = s.me.connection
      mine.title = c === null ? `You (${s.me.name})` : `You (${s.me.name}) · ${CONNECTION_TEXT[c]}`
      if (c !== null) mine.append(el('span', `pp-dot pp-${c}`))
      icons.push(mine)
    }
    slot.replaceChildren(...icons)
  }

  render()
  return { render }
}

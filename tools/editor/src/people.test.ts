// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { createPeople, initials, selectedText, type PeopleState } from './people'

/**
 * Who is in the room (ADR 0155): an icon each in their colour, yours last with how you are connected, and a
 * card on click with what they have selected, Focus and Follow.
 */

describe('what an icon and a card say', () => {
  it('draws up to two initials', () => {
    expect(initials('Ana Lopez')).toBe('AL')
    expect(initials('kodjo')).toBe('K')
    expect(initials('jean-paul marie claude')).toBe('JP')
    expect(initials('  ')).toBe('?')
  })
  it('says what someone has selected in one line', () => {
    expect(selectedText([])).toBe('Nothing selected')
    expect(selectedText(['Ramp'])).toBe('Selected: Ramp')
    expect(selectedText(['Ramp', 'Door'])).toBe('Selected: Ramp, Door')
    expect(selectedText(['Ramp', 'Door', 'Key', 'Wall'])).toBe('Selected: Ramp, Door and 2 more')
  })
})

describe('the icons', () => {
  const rig = (initial: Partial<PeopleState> = {}) => {
    const slot = document.createElement('div')
    document.body.replaceChildren(slot)
    let s: PeopleState = {
      me: { name: 'Kodjo', colour: '#ff0000', connection: 'live' },
      others: [
        { connId: 'a', name: 'Ana', colour: '#00ff00' },
        { connId: 'b', name: 'Bob', colour: '#0000ff' },
      ],
      following: null,
      selected: (connId) => (connId === 'a' ? ['Ramp'] : []),
      ...initial,
    }
    const calls: string[] = []
    const people = createPeople(slot, () => s, {
      focus: (id) => void calls.push(`focus ${id}`),
      follow: (id) => void calls.push(`follow ${id}`),
    })
    return {
      slot,
      people,
      calls,
      set: (next: Partial<PeopleState>) => void (s = { ...s, ...next }),
      icon: (n: number) => slot.children[n] as HTMLElement,
      card: () => document.querySelector('.pcard'),
    }
  }

  it('shows everyone in their colour and you last, with your connection', () => {
    const r = rig()
    expect([...r.slot.children].map((c) => c.textContent)).toEqual(['A', 'B', 'K'])
    expect(r.icon(0).style.getPropertyValue('--pc')).toBe('#00ff00')
    expect(r.icon(2).classList.contains('me')).toBe(true)
    expect(r.icon(2).querySelector('.pp-dot')!.classList.contains('pp-live')).toBe(true)
    expect(r.icon(2).title).toBe('You (Kodjo) · connected')
  })

  it('touches nothing when nothing it shows changed', () => {
    const r = rig()
    const first = r.icon(0)
    r.people.render()
    expect(r.icon(0)).toBe(first)
    r.set({ me: { name: 'Kodjo', colour: '#ff0000', connection: 'connecting' } })
    r.people.render()
    expect(r.icon(2).querySelector('.pp-dot')!.classList.contains('pp-connecting')).toBe(true)
  })

  it('opens a card with what they have selected, and Focus and Follow', () => {
    const r = rig()
    r.icon(0).click()
    expect(r.card()!.querySelector('.pcard-name')!.textContent).toBe('Ana')
    expect(r.card()!.querySelector('.pcard-sel')!.textContent).toBe('Selected: Ramp')
    const [focus, follow] = [...r.card()!.querySelectorAll<HTMLButtonElement>('.pcard-btn')]
    focus!.click()
    expect(r.card(), 'a button closes the card').toBeNull()
    r.icon(0).click()
    r.card()!.querySelectorAll<HTMLButtonElement>('.pcard-btn')[1]!.click()
    expect(r.calls).toEqual(['focus a', 'follow a'])
    expect(follow!.textContent).toBe('Follow')
  })

  it('cannot focus someone with nothing selected, and offers to stop a follow', () => {
    const r = rig({ following: 'b' })
    expect(r.icon(1).classList.contains('on')).toBe(true)
    r.icon(1).click()
    const [focus, follow] = [...r.card()!.querySelectorAll<HTMLButtonElement>('.pcard-btn')]
    expect(focus!.disabled).toBe(true)
    expect(follow!.textContent).toBe('Stop following')
    follow!.click()
    expect(r.calls).toEqual(['follow null'])
  })

  it('closes the card of someone who left', () => {
    const r = rig()
    r.icon(0).click()
    expect(r.card()).not.toBeNull()
    r.set({ others: [{ connId: 'b', name: 'Bob', colour: '#0000ff' }] })
    r.people.render()
    expect(r.card()).toBeNull()
  })
})

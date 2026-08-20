import { describe, expect, it, vi } from 'vitest'

import { chordLabel, chordOf, createShortcuts, isEditable, normalizeChord, resolveKey, type Binding } from './shortcuts'

/** A keydown as the resolver sees it. `key` is what the layout produced; `code` is the physical position. */
const ev = (key: string, code: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}) => ({
  key,
  code,
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
})

describe('resolveKey', () => {
  it('takes the character typed, not the physical position', () => {
    expect(resolveKey(ev('z', 'KeyZ'))).toBe('z')
  })

  /**
   * The bug this module exists for. On AZERTY the key marked Z is where QWERTY puts W, so it reports
   * `code: 'KeyW'` — and a shortcut layer reading `code` would fire undo for the key marked W instead.
   */
  it('resolves the key marked Z on AZERTY to z, though it sits at KeyW', () => {
    expect(resolveKey(ev('z', 'KeyW'))).toBe('z')
    expect(resolveKey(ev('w', 'KeyZ')), 'and the key marked W is w, not z').toBe('w')
  })

  it('resolves A and Q on AZERTY, which are also swapped', () => {
    expect(resolveKey(ev('a', 'KeyQ'))).toBe('a')
    expect(resolveKey(ev('q', 'KeyA'))).toBe('q')
  })

  it('resolves Dvorak, where almost every letter moves', () => {
    // Dvorak's key marked S sits at QWERTY's semicolon.
    expect(resolveKey(ev('s', 'Semicolon'))).toBe('s')
    expect(resolveKey(ev('r', 'KeyP'))).toBe('r')
  })

  it('is case-insensitive, so a shifted letter is still that letter', () => {
    expect(resolveKey(ev('Z', 'KeyZ'))).toBe('z')
  })

  it('passes named keys through, since those are layout-independent already', () => {
    expect(resolveKey(ev('Delete', 'Delete'))).toBe('delete')
    expect(resolveKey(ev('Escape', 'Escape'))).toBe('escape')
    expect(resolveKey(ev('ArrowUp', 'ArrowUp'))).toBe('arrowup')
    expect(resolveKey(ev('F2', 'F2'))).toBe('f2')
  })

  // French AZERTY's digit row unshifted produces punctuation, so `key` cannot answer and position must.
  it('falls back to the physical digit when the layout types punctuation there', () => {
    expect(resolveKey(ev('&', 'Digit1'))).toBe('1')
    expect(resolveKey(ev('é', 'Digit2'))).toBe('2')
  })

  it('falls back to position for a non-Latin layout, so the binding stays reachable', () => {
    expect(resolveKey(ev('я', 'KeyZ')), 'Cyrillic ya sits on the Z key').toBe('z')
    expect(resolveKey(ev('ω', 'KeyV'))).toBe('v')
  })

  it('reads the numpad digits by position, since they produce the same characters', () => {
    expect(resolveKey(ev('1', 'Numpad1'))).toBe('1')
  })

  it('keeps a punctuation character it cannot place, rather than inventing one', () => {
    expect(resolveKey(ev('/', 'Slash'))).toBe('/')
  })
})

describe('chordOf', () => {
  it('folds Ctrl and Cmd into one modifier, so one table serves every platform', () => {
    expect(chordOf(ev('z', 'KeyZ', { ctrl: true }))).toBe('mod+z')
    expect(chordOf(ev('z', 'KeyZ', { meta: true }))).toBe('mod+z')
  })

  it('orders modifiers canonically whatever order they were held', () => {
    expect(chordOf(ev('Z', 'KeyZ', { ctrl: true, shift: true }))).toBe('mod+shift+z')
    expect(chordOf(ev('z', 'KeyZ', { ctrl: true, alt: true, shift: true }))).toBe('mod+alt+shift+z')
  })

  it('is the bare key with no modifiers', () => {
    expect(chordOf(ev('Delete', 'Delete'))).toBe('delete')
  })

  it('reads Ctrl+Z on AZERTY from the key marked Z', () => {
    expect(chordOf(ev('z', 'KeyW', { ctrl: true }))).toBe('mod+z')
  })
})

describe('normalizeChord', () => {
  it('accepts every spelling a person might transcribe from a menu', () => {
    for (const spelling of ['mod+z', 'ctrl+z', 'Control+Z', 'cmd+z', 'meta+z', ' MOD + Z ']) {
      expect(normalizeChord(spelling), spelling).toBe('mod+z')
    }
  })

  it('orders modifiers, so two spellings of one chord collide instead of both registering', () => {
    expect(normalizeChord('shift+mod+z')).toBe(normalizeChord('mod+shift+z'))
  })

  it('treats option as alt', () => {
    expect(normalizeChord('option+d')).toBe('alt+d')
  })
})

/** An event target as `isEditable` reads it. Duck-typed there, so no DOM is needed here. */
const node = (tagName: string, contentEditable = false): EventTarget =>
  ({ tagName, isContentEditable: contentEditable }) as unknown as EventTarget

describe('isEditable', () => {
  it('is true for the fields that own the keyboard', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) expect(isEditable(node(tag)), tag).toBe(true)
  })

  it('is false for anything else, and for nothing', () => {
    expect(isEditable(node('DIV'))).toBe(false)
    expect(isEditable(node('BUTTON'))).toBe(false)
    expect(isEditable(null)).toBe(false)
  })

  it('is true for a contenteditable element', () => {
    expect(isEditable(node('DIV', true))).toBe(true)
  })
})

/** A keydown that records whether it was suppressed. */
const keydown = (key: string, code: string, mods: Parameters<typeof ev>[2] = {}, target?: EventTarget): KeyboardEvent => {
  const base = ev(key, code, mods)
  let prevented = false
  return {
    ...base,
    target: target ?? node('DIV'),
    preventDefault: () => void (prevented = true),
    get defaultPrevented() {
      return prevented
    },
  } as unknown as KeyboardEvent
}

describe('createShortcuts', () => {
  const bind = (over: Partial<Binding> = {}): Binding => ({ id: 'undo', chords: ['mod+z'], label: 'Undo', run: () => {}, ...over })

  it('runs the binding whose chord matches', () => {
    const run = vi.fn()
    const shortcuts = createShortcuts([bind({ run })])
    expect(shortcuts.handle(keydown('z', 'KeyZ', { ctrl: true }))?.id).toBe('undo')
    expect(run).toHaveBeenCalledOnce()
  })

  it('runs it from an AZERTY keyboard too', () => {
    const run = vi.fn()
    const shortcuts = createShortcuts([bind({ run })])
    shortcuts.handle(keydown('z', 'KeyW', { ctrl: true }))
    expect(run).toHaveBeenCalledOnce()
  })

  it('ignores a chord nothing is bound to, and leaves the event alone', () => {
    const shortcuts = createShortcuts([bind()])
    const e = keydown('k', 'KeyK', { ctrl: true })
    expect(shortcuts.handle(e)).toBeNull()
    expect(e.defaultPrevented, 'an unbound key belongs to the browser').toBe(false)
  })

  it('suppresses the browser default for a chord it handled', () => {
    const shortcuts = createShortcuts([bind()])
    const e = keydown('z', 'KeyZ', { ctrl: true })
    shortcuts.handle(e)
    expect(e.defaultPrevented).toBe(true)
  })

  it('leaves the default alone for a passthrough binding', () => {
    const shortcuts = createShortcuts([bind({ passthrough: true })])
    const e = keydown('z', 'KeyZ', { ctrl: true })
    shortcuts.handle(e)
    expect(e.defaultPrevented).toBe(false)
  })

  // Typing in a rename box must not delete the selection, and Ctrl+C in a number field has to reach the
  // browser's own copy.
  it('stays out of text fields entirely', () => {
    const run = vi.fn()
    const shortcuts = createShortcuts([bind({ chords: ['delete'], run })])
    const e = keydown('Delete', 'Delete', {}, node('INPUT'))
    expect(shortcuts.handle(e)).toBeNull()
    expect(run).not.toHaveBeenCalled()
    expect(e.defaultPrevented, 'and does not swallow the keystroke either').toBe(false)
  })

  it('skips a disabled binding without swallowing the key', () => {
    const run = vi.fn()
    const shortcuts = createShortcuts([bind({ run, enabled: () => false })])
    const e = keydown('z', 'KeyZ', { ctrl: true })
    expect(shortcuts.handle(e)).toBeNull()
    expect(run).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('supports a second spelling for one command', () => {
    const run = vi.fn()
    const shortcuts = createShortcuts([bind({ id: 'redo', chords: ['mod+y', 'mod+shift+z'], run })])
    shortcuts.handle(keydown('y', 'KeyY', { ctrl: true }))
    shortcuts.handle(keydown('Z', 'KeyZ', { ctrl: true, shift: true }))
    expect(run).toHaveBeenCalledTimes(2)
  })

  // The loser of a collision would silently never fire, which is a bug nobody would find by using it.
  it('refuses a chord bound twice, however it was spelled', () => {
    expect(() => createShortcuts([bind(), bind({ id: 'other', chords: ['ctrl+z'] })])).toThrow(/bound twice/)
  })

  it('lists every binding with canonical chords, for a cheat sheet', () => {
    const shortcuts = createShortcuts([bind({ id: 'redo', chords: ['ctrl+y', 'shift+mod+z'] })])
    expect(shortcuts.list()).toEqual([{ id: 'redo', label: 'Undo', chords: ['mod+y', 'mod+shift+z'] }])
  })
})

describe('chordLabel', () => {
  it('reads as a menu does', () => {
    expect(chordLabel('mod+z')).toBe('Ctrl+Z')
    expect(chordLabel('mod+shift+z')).toBe('Ctrl+Shift+Z')
    expect(chordLabel('delete')).toBe('Delete')
  })

  it('uses the Mac glyphs when asked', () => {
    expect(chordLabel('mod+shift+z', true)).toBe('⌘⇧Z')
  })
})

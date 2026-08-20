/**
 * Keyboard shortcuts that survive a change of layout (ADR 0030).
 *
 * The whole point is the difference between two things a `KeyboardEvent` carries:
 *
 * - **`code`** is the key's *physical position*, named after where it sits on US QWERTY. `KeyZ` is the
 *   bottom-left letter key. On AZERTY that same physical key is labelled **W**.
 * - **`key`** is the *character it produced*, which is what the person sees printed on the cap.
 *
 * Matching on `code` means "Ctrl+Z" is really "Ctrl+bottom-left-letter": an AZERTY user pressing the key
 * marked Z gets nothing, and pressing the key marked W gets undo. Matching on `key` means Ctrl+Z is the key
 * marked Z on every Latin layout, which is what every menu label promises. So `key` wins.
 *
 * `key` alone is not enough, though. On a Cyrillic or Greek layout it is a non-Latin character and no Latin
 * binding could ever match; on French AZERTY the digit row unshifted produces `&é"'(`, so Ctrl+1 arrives as
 * `&`. In both cases the physical position is the only thing left to go on, so `code` is the **fallback**,
 * not the primary. That ordering is the entire design.
 */

/** A key as a binding names it: a lowercase character, or a lowercase special-key name. */
export type ResolvedKey = string

const LATIN = /^[a-z0-9]$/

/**
 * The Latin character a physical key sits at, for layouts where `key` cannot give one. Only letters and
 * digits: every other physical key either already reports a stable `key` name (`Delete`, `Escape`) or is
 * punctuation whose position varies too much between layouts to be worth guessing at.
 */
const latinFromCode = (code: string): string | undefined => {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6)
  return undefined
}

/**
 * Which key a binding should consider pressed.
 *
 * Named keys (`Delete`, `Escape`, `ArrowUp`, `F2`) are already layout-independent in `key`, so they pass
 * straight through lowercased. A printable character is taken as typed — that is the layout-correct answer —
 * and only falls back to the physical position when what was typed is not a Latin letter or digit.
 */
export const resolveKey = (e: Pick<KeyboardEvent, 'key' | 'code'>): ResolvedKey => {
  const key = e.key.toLowerCase()
  if (key.length > 1) return key // 'delete', 'escape', 'arrowup', 'f2', 'tab'
  if (LATIN.test(key)) return key
  return latinFromCode(e.code) ?? key
}

/**
 * The chord an event represents, in a canonical order: `mod+alt+shift+key`.
 *
 * `mod` folds Ctrl and Cmd together so one binding table serves Windows, Linux and macOS. That does mean
 * Ctrl on a Mac also triggers, which is the lesser evil: the alternative is every binding declared twice, and
 * a Mac user pressing Ctrl+Z expects undo more than they expect nothing.
 */
export const chordOf = (e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string => {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('mod')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  parts.push(resolveKey(e))
  return parts.join('+')
}

/**
 * Put a hand-written chord into the same canonical order, so `'shift+mod+z'` and `'mod+shift+z'` are one
 * binding. Also accepts `ctrl`/`cmd`/`meta`/`control` as spellings of `mod`, since that is what a person
 * types when they are transcribing a menu.
 */
export const normalizeChord = (chord: string): string => {
  const raw = chord
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p !== '')
  const mods = new Set<string>()
  let key = ''
  for (const part of raw) {
    if (part === 'mod' || part === 'ctrl' || part === 'control' || part === 'cmd' || part === 'meta') mods.add('mod')
    else if (part === 'alt' || part === 'option') mods.add('alt')
    else if (part === 'shift') mods.add('shift')
    else key = part
  }
  const parts: string[] = []
  if (mods.has('mod')) parts.push('mod')
  if (mods.has('alt')) parts.push('alt')
  if (mods.has('shift')) parts.push('shift')
  parts.push(key)
  return parts.join('+')
}

/** One command the editor can run from the keyboard. */
export interface Binding {
  /** Stable id, for a cheat sheet and for tests. */
  id: string
  /** Chords that trigger it. More than one where a second spelling is genuinely expected (redo). */
  chords: readonly string[]
  /** What a menu or tooltip would call it. */
  label: string
  run: () => void
  /** True when the command applies right now. A binding that does not apply lets the browser have the key. */
  enabled?: () => boolean
  /**
   * Keep the browser's own behaviour instead of suppressing it. Off by default: a matched shortcut that also
   * scrolled the page or opened Save-As would be worse than no shortcut.
   */
  passthrough?: boolean
}

export interface Shortcuts {
  /** Feed a keydown. Returns the binding that ran, or `null` — so a caller can log or ignore. */
  handle: (e: KeyboardEvent) => Binding | null
  /** Every binding with its canonical chords, for a help panel. */
  list: () => { id: string; label: string; chords: string[] }[]
}

/**
 * Text fields own the keyboard. Typing "d" in a rename box must not delete the selection, and Ctrl+C in a
 * number field has to reach the browser's own copy. `isEditable` is also why the shortcut layer takes whole
 * events rather than chords: only the event knows where it landed.
 */
export const isEditable = (target: EventTarget | null): boolean => {
  // Duck-typed rather than `instanceof HTMLElement`, so this is testable without a DOM — and so it still
  // works on an element from another document, where `instanceof` quietly returns false.
  if (target === null || typeof target !== 'object') return false
  const node = target as { tagName?: unknown; isContentEditable?: unknown }
  if (node.isContentEditable === true) return true
  return typeof node.tagName === 'string' && ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName.toUpperCase())
}

export const createShortcuts = (bindings: readonly Binding[]): Shortcuts => {
  const byChord = new Map<string, Binding>()
  for (const binding of bindings) {
    for (const chord of binding.chords) {
      const normalized = normalizeChord(chord)
      // A duplicate is a mistake worth failing loudly on: the loser would silently never fire.
      if (byChord.has(normalized)) throw new Error(`shortcut ${normalized} is bound twice: ${byChord.get(normalized)!.id} and ${binding.id}`)
      byChord.set(normalized, binding)
    }
  }

  return {
    handle: (e) => {
      if (isEditable(e.target)) return null
      const binding = byChord.get(chordOf(e))
      if (binding === undefined) return null
      if (binding.enabled !== undefined && !binding.enabled()) return null
      if (binding.passthrough !== true) e.preventDefault()
      binding.run()
      return binding
    },
    list: () =>
      bindings.map((b) => ({ id: b.id, label: b.label, chords: b.chords.map(normalizeChord) })),
  }
}

/** A chord as a person reads it: `Ctrl+Shift+Z`, or `⌘` on a Mac. */
export const chordLabel = (chord: string, mac = false): string =>
  normalizeChord(chord)
    .split('+')
    .map((part) => {
      if (part === 'mod') return mac ? '⌘' : 'Ctrl'
      if (part === 'alt') return mac ? '⌥' : 'Alt'
      if (part === 'shift') return mac ? '⇧' : 'Shift'
      if (part.length === 1) return part.toUpperCase()
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(mac ? '' : '+')

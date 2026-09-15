/**
 * A blocking three-way question, for the moment before something is thrown away.
 *
 * Blocking on purpose. Switching game, switching between levels and prefabs, or opening another file all
 * replace the open document, and the document is where unsaved edits live — a console warning is not an
 * answer to "I am about to lose your work", and neither is doing it silently and hoping the undo stack
 * covers it (it does not: history is cleared with the document).
 *
 * A promise rather than callbacks, so the caller reads as the sequence it is: ask, then act. `cancel` is the
 * answer that means "do nothing at all", which is why it is what Escape and a click outside both give.
 */
export type UnsavedChoice = 'save' | 'discard' | 'cancel'

const STYLE = {
  scrim: 'position:fixed;inset:0;z-index:1000;background:#0009;display:flex;align-items:center;justify-content:center',
  box: 'background:#1c1f24;border:1px solid #34383f;border-radius:6px;padding:16px 18px;min-width:320px;color:#d5d9e0;font:13px system-ui,sans-serif;box-shadow:0 12px 32px #0008',
  title: 'font-weight:600;margin-bottom:6px',
  body: 'color:#8b929d;margin-bottom:14px;line-height:1.4',
  row: 'display:flex;gap:8px;justify-content:flex-end',
  button: 'padding:5px 12px;border-radius:4px;border:1px solid #34383f;background:#23272e;color:#d5d9e0;cursor:pointer;font:13px system-ui,sans-serif',
  primary: 'padding:5px 12px;border-radius:4px;border:1px solid #2f5fa8;background:#4a8cf7;color:#0b0d10;cursor:pointer;font:600 13px system-ui,sans-serif',
} as const

/**
 * Ask what to do about unsaved edits to `name`.
 *
 * Save is the default — Enter takes it — because losing work is the expensive mistake and saving is the one
 * answer that is never destructive.
 */
/**
 * Ask for a name: a new level, a duplicate. Resolves the trimmed name, or `null` for Escape, Cancel, a click
 * outside, or an empty field. Replaces `window.prompt`, whose empty answer once deleted a file.
 */
export const askName = (title: string, initial: string, hint: string): Promise<string | null> =>
  new Promise<string | null>((resolve) => {
    const scrim = document.createElement('div')
    scrim.style.cssText = STYLE.scrim
    const box = document.createElement('div')
    box.style.cssText = STYLE.box
    const heading = document.createElement('div')
    heading.style.cssText = STYLE.title
    heading.textContent = title
    const body = document.createElement('div')
    body.style.cssText = STYLE.body
    body.textContent = hint
    const input = document.createElement('input')
    input.type = 'text'
    input.value = initial
    input.style.cssText = 'width:100%;box-sizing:border-box;margin-bottom:12px;padding:5px 8px;border-radius:4px;border:1px solid #34383f;background:#12141a;color:#d5d9e0;font:13px system-ui,sans-serif'
    const row = document.createElement('div')
    row.style.cssText = STYLE.row

    let done = false
    const finish = (value: string | null): void => {
      if (done) return
      done = true
      window.removeEventListener('keydown', onKey, true)
      scrim.remove()
      resolve(value === null || value.trim() === '' ? null : value.trim())
    }
    const onKey = (e: KeyboardEvent): void => {
      e.stopPropagation()
      if (e.key === 'Escape') finish(null)
      else if (e.key === 'Enter') finish(input.value)
    }
    const button = (label: string, value: () => string | null, primary = false): HTMLButtonElement => {
      const b = document.createElement('button')
      b.style.cssText = primary ? STYLE.primary : STYLE.button
      b.textContent = label
      b.addEventListener('click', () => finish(value()))
      return b
    }
    row.append(button('Cancel', () => null), button('OK', () => input.value, true))
    box.append(heading, body, input, row)
    scrim.append(box)
    scrim.addEventListener('mousedown', (e) => {
      if (e.target === scrim) finish(null)
    })
    window.addEventListener('keydown', onKey, true)
    document.body.append(scrim)
    input.focus()
    input.select()
  })

export const askUnsaved = (name: string): Promise<UnsavedChoice> =>
  new Promise<UnsavedChoice>((resolve) => {
    const scrim = document.createElement('div')
    scrim.style.cssText = STYLE.scrim
    const box = document.createElement('div')
    box.style.cssText = STYLE.box
    const title = document.createElement('div')
    title.style.cssText = STYLE.title
    title.textContent = `Save changes to ${name}?`
    const body = document.createElement('div')
    body.style.cssText = STYLE.body
    body.textContent = 'It has edits that are not on disk. They cannot be recovered afterwards — the undo history goes with the document.'
    const row = document.createElement('div')
    row.style.cssText = STYLE.row

    // Set before the listeners are removed, so a second click cannot resolve twice.
    let done = false
    const finish = (choice: UnsavedChoice): void => {
      if (done) return
      done = true
      window.removeEventListener('keydown', onKey, true)
      scrim.remove()
      resolve(choice)
    }
    const onKey = (e: KeyboardEvent): void => {
      // Captured, and stopped: the editor's own shortcuts are on `window` too, and a stray key while this is
      // up must not also delete a node behind it.
      e.stopPropagation()
      if (e.key === 'Escape') finish('cancel')
      else if (e.key === 'Enter') finish('save')
    }

    const button = (label: string, choice: UnsavedChoice, primary = false): HTMLButtonElement => {
      const b = document.createElement('button')
      b.style.cssText = primary ? STYLE.primary : STYLE.button
      b.textContent = label
      b.addEventListener('click', () => finish(choice))
      return b
    }
    // Cancel first in the DOM so it is the leftmost, and the destructive one is not next to the default.
    row.append(button('Cancel', 'cancel'), button('Discard', 'discard'), button('Save', 'save', true))
    box.append(title, body, row)
    scrim.append(box)
    // A click on the scrim itself — not on the box — is the same as Escape.
    scrim.addEventListener('mousedown', (e) => {
      if (e.target === scrim) finish('cancel')
    })
    window.addEventListener('keydown', onKey, true)
    document.body.append(scrim)
    row.lastElementChild instanceof HTMLElement && row.lastElementChild.focus()
  })

/**
 * A yes/no on something that cannot be undone, with the consequences spelled out (ADR 0097).
 *
 * `askUnsaved`'s three-way shape with the middle option removed. The destructive button is last and primary,
 * and Enter does **not** take it: the keyboard default is Cancel, because the dialogue exists for the case
 * where somebody is about to lose work they did not know about.
 */
export const askDestructive = (title: string, body: string, confirmLabel: string): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const scrim = document.createElement('div')
    scrim.style.cssText = STYLE.scrim
    const box = document.createElement('div')
    box.style.cssText = STYLE.box
    const heading = document.createElement('div')
    heading.style.cssText = STYLE.title
    heading.textContent = title
    const text = document.createElement('div')
    text.style.cssText = STYLE.body
    text.textContent = body
    const row = document.createElement('div')
    row.style.cssText = STYLE.row

    let done = false
    const finish = (value: boolean): void => {
      if (done) return
      done = true
      window.removeEventListener('keydown', onKey, true)
      scrim.remove()
      resolve(value)
    }
    const onKey = (e: KeyboardEvent): void => {
      e.stopPropagation()
      if (e.key === 'Escape' || e.key === 'Enter') finish(false)
    }
    const button = (label: string, value: boolean, primary = false): HTMLButtonElement => {
      const b = document.createElement('button')
      b.style.cssText = primary ? STYLE.primary : STYLE.button
      b.textContent = label
      b.addEventListener('click', () => finish(value))
      return b
    }
    row.append(button('Cancel', false), button(confirmLabel, true, true))
    box.append(heading, text, row)
    scrim.append(box)
    scrim.addEventListener('mousedown', (e) => {
      if (e.target === scrim) finish(false)
    })
    window.addEventListener('keydown', onKey, true)
    document.body.append(scrim)
  })

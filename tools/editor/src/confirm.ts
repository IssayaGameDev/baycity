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
 * Ask for a name: a new level, a duplicate. Resolves the trimmed name, or `null` for Escape, Cancel, a click
 * outside, or an empty field. Replaces `window.prompt`, whose empty answer once deleted a file.
 */
export const askName = (title: string, initial: string, hint: string): Promise<string | null> =>
  new Promise<string | null>((resolve) => {
    const scrim = document.createElement('div')
    scrim.style.cssText = STYLE.scrim
    // So what is under it (the games window) leaves the keys to it.
    scrim.dataset.dialog = ''
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

/**
 * A yes/no on something that cannot be undone, with the consequences spelled out (ADR 0097).
 *
 * Blocking, and a promise, so the caller reads as the sequence it is: ask, then act. The destructive button is last
 * and primary, and Enter does **not** take it: the keyboard default is Cancel, because the dialogue exists for the case
 * where somebody is about to lose work they did not know about.
 */
export const askDestructive = (title: string, body: string, confirmLabel: string): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const scrim = document.createElement('div')
    scrim.style.cssText = STYLE.scrim
    // So what is under it (the games window) leaves the keys to it.
    scrim.dataset.dialog = ''
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

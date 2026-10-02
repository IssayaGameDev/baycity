import './admin.css'

/**
 * The admin page (ADR 0200): `/admin.html`, a tab of its own, opened from the top bar's Admin — for the emails in the
 * server's `admins` file; anyone else is told it is not theirs. One section so far, the assistant's: what everyone
 * may spend a day, the admin's own limit over it, and each person's day so far, each with a Reset that starts it
 * again.
 */

/** What the server shows an admin: `GET /api/assistant/admin`, and the answer to every change. */
export interface AdminView {
  readonly you: string
  readonly everyone: number
  readonly own: number | null
  readonly people: readonly { readonly email: string; readonly spent: number; readonly limit: number }[]
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const money = (usd: number): string => `$${usd.toFixed(2)}`

/** Ask the server, and hand back the view it answers with — or why not. */
const ask = async (url: string, init?: { method: string; body: unknown }): Promise<AdminView> => {
  const r = await fetch(url, init === undefined ? undefined : { method: init.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) })
  const body = (await r.json().catch(() => ({}))) as { error?: unknown }
  if (r.ok) return body as AdminView
  if (typeof body.error === 'string') throw new Error(body.error)
  throw new Error(r.status === 404 ? 'The assistant is not on this server.' : `The server answered ${r.status}.`)
}

/** Dollars typed into a field: a number, 0 or more; `null` for an empty field; `undefined` for anything else. */
const dollarsOf = (input: HTMLInputElement): number | null | undefined => {
  const text = input.value.trim()
  if (text === '') return null
  const n = Number(text)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

export const createAdminPage = (root: HTMLElement): void => {
  root.replaceChildren()
  root.classList.add('adm')
  const note = el('div', 'adm-note')
  const section = el('section', 'adm-sec')
  root.append(el('h1', 'adm-h', 'Admin'), note, section)

  const say = (text: string, bad = false): void => {
    note.textContent = text
    note.classList.toggle('adm-err', bad)
  }
  const failed = (e: unknown): void => say(e instanceof Error ? e.message : String(e), true)

  const limitField = (label: string, value: number | null, placeholder: string): { row: HTMLElement; input: HTMLInputElement } => {
    const row = el('label', 'adm-field')
    const input = el('input', 'adm-in')
    input.type = 'number'
    input.min = '0'
    input.step = '0.01'
    input.value = value === null ? '' : String(value)
    input.placeholder = placeholder
    row.append(el('span', 'adm-label', label), el('span', 'adm-cur', '$'), input)
    return { row, input }
  }

  const draw = (v: AdminView): void => {
    section.replaceChildren()
    section.append(el('h2', 'adm-h2', 'Assistant'), el('p', 'adm-d', 'Dollars a person may spend a day, the UTC day. Once it is reached, no new turn starts.'))

    const everyone = limitField('Everyone', v.everyone, '')
    const own = limitField(`You (${v.you})`, v.own, `everyone’s (${money(v.everyone)})`)
    const save = el('button', 'adm-b', 'Save')
    save.type = 'button'
    save.addEventListener('click', () => {
      const all = dollarsOf(everyone.input)
      const mine = dollarsOf(own.input)
      if (all === undefined || all === null) return say('Everyone: dollars, 0 or more.', true)
      if (mine === undefined) return say('You: dollars, 0 or more — or empty for everyone’s.', true)
      ask('/api/assistant/admin/limits', { method: 'PUT', body: { everyone: all, own: mine } }).then((next) => {
        draw(next)
        say('Saved.')
      }, failed)
    })
    const limits = el('div', 'adm-limits')
    limits.append(everyone.row, own.row, save)
    section.append(limits)

    const table = el('table', 'adm-t')
    const head = el('tr')
    for (const h of ['Person', 'Spent today', 'Limit', '']) head.append(el('th', '', h))
    table.append(head)
    for (const p of v.people) {
      const tr = el('tr', p.email === v.you ? 'adm-you' : undefined)
      const reset = el('button', 'adm-b adm-reset', 'Reset')
      reset.type = 'button'
      reset.title = `Start ${p.email}’s day again: nothing spent`
      reset.disabled = p.spent === 0
      reset.addEventListener('click', () => {
        ask('/api/assistant/admin/reset', { method: 'POST', body: { email: p.email } }).then((next) => {
          draw(next)
          say(`${p.email}: the day starts again.`)
        }, failed)
      })
      const action = el('td')
      action.append(reset)
      tr.append(el('td', 'adm-who', p.email), el('td', 'adm-num', money(p.spent)), el('td', 'adm-num', money(p.limit)), action)
      table.append(tr)
    }
    section.append(table)
  }

  ask('/api/assistant/admin').then(draw, failed)
}

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAdminPage, type AdminView } from './adminPage'

/** The admin page (ADR 0200), against a fake server: the limits, each person's day, Save and Reset. */

const VIEW: AdminView = {
  you: 'ada@x.com',
  everyone: 1,
  own: null,
  people: [
    { email: 'bob@x.com', spent: 0.42, limit: 1 },
    { email: 'ada@x.com', spent: 0, limit: 1 },
  ],
}

const settle = () => new Promise((r) => setTimeout(r, 20))

/** A server that answers every route with this view, or refuses with this status; each request kept. */
const serve = (status = 200) => {
  const sent: { url: string; method: string; body: unknown }[] = []
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    sent.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(init.body) })
    return status === 200 ? new Response(JSON.stringify(VIEW)) : new Response(JSON.stringify({ error: 'This is for admins.' }), { status })
  })
  return { sent }
}
afterEach(() => vi.unstubAllGlobals())

const open = async () => {
  const root = document.createElement('div')
  document.body.replaceChildren(root)
  createAdminPage(root)
  await settle()
  return root
}

describe('the admin page', () => {
  it('shows the limits and each person’s day, a Reset each where there is something to reset', async () => {
    serve()
    const root = await open()
    const inputs = root.querySelectorAll<HTMLInputElement>('.adm-in')
    expect([...inputs].map((i) => i.value)).toEqual(['1', ''])
    expect(inputs[1]!.placeholder).toBe('everyone’s ($1.00)')
    expect(root.querySelector('.adm-field:nth-child(2) .adm-label')!.textContent).toBe('You (ada@x.com)')
    const rows = [...root.querySelectorAll('.adm-t tr')].slice(1)
    expect(rows.map((r) => [...r.querySelectorAll('td')].slice(0, 3).map((td) => td.textContent))).toEqual([
      ['bob@x.com', '$0.42', '$1.00'],
      ['ada@x.com', '$0.00', '$1.00'],
    ])
    expect([...root.querySelectorAll<HTMLButtonElement>('.adm-reset')].map((b) => b.disabled)).toEqual([false, true])
  })

  it('saves everyone’s limit and the admin’s own; an empty own is everyone’s', async () => {
    const server = serve()
    const root = await open()
    const [everyone, own] = root.querySelectorAll<HTMLInputElement>('.adm-in')
    everyone!.value = '3'
    own!.value = '25'
    root.querySelector<HTMLButtonElement>('.adm-limits .adm-b')!.click()
    await settle()
    expect(server.sent.at(-1)).toEqual({ url: '/api/assistant/admin/limits', method: 'PUT', body: { everyone: 3, own: 25 } })
    expect(root.querySelector('.adm-note')!.textContent).toBe('Saved.')
    root.querySelectorAll<HTMLInputElement>('.adm-in')[1]!.value = ''
    root.querySelector<HTMLButtonElement>('.adm-limits .adm-b')!.click()
    await settle()
    expect(server.sent.at(-1)!.body).toEqual({ everyone: 1, own: null })
  })

  it('refuses a limit that is not dollars, and sends nothing', async () => {
    const server = serve()
    const root = await open()
    root.querySelector<HTMLInputElement>('.adm-in')!.value = '-2'
    root.querySelector<HTMLButtonElement>('.adm-limits .adm-b')!.click()
    await settle()
    expect(server.sent).toHaveLength(1)
    expect(root.querySelector('.adm-note.adm-err')!.textContent).toBe('Everyone: dollars, 0 or more.')
  })

  it('starts one person’s day again', async () => {
    const server = serve()
    const root = await open()
    root.querySelector<HTMLButtonElement>('.adm-reset')!.click()
    await settle()
    expect(server.sent.at(-1)).toEqual({ url: '/api/assistant/admin/reset', method: 'POST', body: { email: 'bob@x.com' } })
    expect(root.querySelector('.adm-note')!.textContent).toBe('bob@x.com: the day starts again.')
  })

  it('tells anyone but an admin it is not theirs', async () => {
    serve(403)
    const root = await open()
    expect(root.querySelector('.adm-note.adm-err')!.textContent).toBe('This is for admins.')
    expect(root.querySelector('.adm-t')).toBeNull()
  })
})

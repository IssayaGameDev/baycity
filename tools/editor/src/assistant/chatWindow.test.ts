// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sseParser } from './assistantApi'
import { createChatWindow } from './chatWindow'
import type { EditorLink } from './editorLink'
import { escapeHtml } from './markdown'

/**
 * The assistant's chat in the editor (ADR 0192): the stream read as it comes, the model's text made safe, and a turn
 * drawn — its activity, its answer, a draft and the button that files it — against a fake server.
 */

describe('reading a turn as it streams', () => {
  it('hands each whole event on, however the bytes are split', () => {
    const got: [string, string][] = []
    const feed = sseParser((event, data) => got.push([event, data]))
    feed('event: text\ndata: {"kind":"te')
    feed('xt","text":"Hi"}\n\n:keepalive\n\nevent: done\ndata: {"kind":"done"}\n\n')
    expect(got).toEqual([
      ['text', '{"kind":"text","text":"Hi"}'],
      ['done', '{"kind":"done"}'],
    ])
  })
})

/**
 * The cleaning itself is DOMPurify's in a real browser, checked there (Chrome, headless, ADR 0192): this test's DOM
 * runs it and breaks it. Here, the fallback where it cannot run at all — text, never HTML.
 */
describe('the model’s text, made safe', () => {
  it('escapes every character that could open a tag or an entity', () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;')
  })
})

describe('a turn in the chat', () => {
  const sse = (events: object[]): string => events.map((e) => `event: ${(e as { kind: string }).kind}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  let filed: string[] = []

  beforeEach(() => {
    filed = []
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0))
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string }) => {
      if (url === '/api/assistant') return new Response(JSON.stringify({ ready: true, github: true, spent: 0.1, limit: 1 }))
      if (url === '/api/assistant/chats' && init?.method === 'POST') return new Response(JSON.stringify({ id: 'a'.repeat(32) }))
      if (url.endsWith('/say'))
        return new Response(
          sse([
            { kind: 'activity', text: 'Reading docs/INDEX.md' },
            { kind: 'text', text: 'The **hazard** ' },
            { kind: 'text', text: 'missed you.' },
            { kind: 'draft', draft: { id: 'd1', kind: 'issue', title: 'Hazard misses riders', body: 'Steps…', labels: ['bug'] } },
            { kind: 'spent', spent: 0.12, limit: 1 },
            { kind: 'done' },
          ]),
        )
      if (url.includes('/file/')) {
        filed.push(url)
        return new Response(JSON.stringify({ url: 'https://github.com/o/r/issues/12' }))
      }
      return new Response('{}', { status: 404 })
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  const settle = () => new Promise((r) => setTimeout(r, 20))

  it('sends with Enter, draws the turn, and files the draft only on the click', async () => {
    const root = document.createElement('div')
    document.body.replaceChildren(root)
    createChatWindow({ root, context: async () => ({ game: 'keyboard' }) })
    await settle()
    expect(root.querySelector('.asst-spent')!.textContent).toBe('$0.10 of $1.00 today')

    const input = root.querySelector<HTMLTextAreaElement>('.asst-in')!
    input.value = 'Why did the hazard miss me?'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await settle()
    await settle()

    expect(root.querySelector('.asst-you')!.textContent).toBe('Why did the hazard miss me?')
    expect(root.querySelector('.asst-act')!.textContent).toBe('Reading docs/INDEX.md')
    expect(root.querySelector('.asst-ai')!.textContent).toContain('hazard')
    expect(root.querySelector('.asst-draft-t')!.textContent).toBe('Hazard misses riders')
    expect(root.querySelector('.asst-spent')!.textContent).toBe('$0.12 of $1.00 today')
    expect(filed, 'nothing filed before the click').toEqual([])

    root.querySelector<HTMLButtonElement>('.asst-file')!.click()
    await settle()
    expect(filed).toEqual([`/api/assistant/chats/${'a'.repeat(32)}/file/d1`])
    expect(root.querySelector<HTMLAnchorElement>('.asst-filed')!.href).toBe('https://github.com/o/r/issues/12')
  })

  it('says so when the assistant is not set up, and takes nothing typed', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ready: false, why: 'The assistant is not set up on this server yet.', github: false, spent: 0, limit: 1 })))
    const root = document.createElement('div')
    createChatWindow({ root, context: async () => ({}) })
    await settle()
    expect(root.querySelector('.asst-err')!.textContent).toBe('The assistant is not set up on this server yet.')
    expect(root.querySelector<HTMLTextAreaElement>('.asst-in')!.disabled).toBe(true)
  })
})

describe('the editing modes (ADR 0195)', () => {
  const sse = (events: object[]): string => events.map((e) => `event: ${(e as { kind: string }).kind}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  const CALL = { kind: 'call', call: { id: 'k1', name: 'rename_object', input: { id: 'n:a', name: 'Crate' } } }

  /** A server whose turn asks the tab to run one action and waits for its answer, as the real one does. */
  const serve = (modes: readonly string[]) => {
    const answers: unknown[] = []
    const says: Record<string, unknown>[] = []
    let release = (): void => {}
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0))
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
      if (url === '/api/assistant') return new Response(JSON.stringify({ ready: true, github: true, spent: 0, limit: 1, modes }))
      if (url === '/api/assistant/chats' && init?.method === 'POST') return new Response(JSON.stringify({ id: 'a'.repeat(32) }))
      if (url.endsWith('/say')) {
        says.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>)
        const gate = new Promise<void>((r) => (release = r))
        const enc = new TextEncoder()
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(c) {
              c.enqueue(enc.encode(sse([CALL])))
              await gate
              c.enqueue(enc.encode(sse([{ kind: 'done' }])))
              c.close()
            },
          }),
        )
      }
      if (url.includes('/result/')) {
        answers.push(JSON.parse(init?.body ?? '{}'))
        release()
        return new Response(null, { status: 204 })
      }
      return new Response('{}', { status: 404 })
    })
    return { answers, says }
  }

  /** An editor that renames, and says what it ran and which turn it was in. */
  const editor = () => {
    const ran: unknown[] = []
    const turns: string[] = []
    const link: EditorLink = {
      tools: async () => [{ name: 'rename_object', description: 'Rename an object.', input_schema: { type: 'object' }, edits: true }],
      begin: async (label) => void turns.push(`begin ${label}`),
      run: async (name, input) => {
        ran.push([name, input])
        return { ok: true, result: null }
      },
      describe: async () => 'Rename object — id: “Box”; name: Crate',
      end: async () => void turns.push('end'),
    }
    return { link, ran, turns }
  }
  afterEach(() => vi.unstubAllGlobals())
  const settle = () => new Promise((r) => setTimeout(r, 20))

  const start = async (modes: readonly string[], withEditor = true) => {
    const server = serve(modes)
    const ed = editor()
    const root = document.createElement('div')
    document.body.replaceChildren(root)
    createChatWindow({ root, context: async () => ({}), ...(withEditor ? { link: ed.link } : {}) })
    await settle()
    const sendText = async (text: string) => {
      const input = root.querySelector<HTMLTextAreaElement>('.asst-in')!
      input.value = text
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      await settle()
      await settle()
    }
    const pick = (label: string) => {
      root.querySelector<HTMLButtonElement>('.asst-modepick')!.click()
      ;[...root.querySelectorAll<HTMLButtonElement>('.asst-pop-mode')].find((b) => b.querySelector('.asst-pop-t')!.textContent === label)!.click()
    }
    return { root, server, ed, sendText, pick }
  }

  it('shows the mode beside Send only when the server opens the modes and there is an editor to change', async () => {
    expect((await start(['assistant'])).root.querySelector<HTMLElement>('.asst-modepick')!.hidden).toBe(true)
    expect((await start(['assistant', 'confirm', 'auto'], false)).root.querySelector<HTMLElement>('.asst-modepick')!.hidden).toBe(true)
    const { root, pick } = await start(['assistant', 'confirm', 'auto'])
    const picker = root.querySelector<HTMLElement>('.asst-modepick')!
    expect(picker.hidden).toBe(false)
    expect(picker.textContent).toBe('Assistant')
    pick('Auto')
    expect(picker.textContent).toBe('Auto')
    expect(root.querySelector('.asst-pop'), 'the menu closes on a pick').toBeNull()
  })

  it('in Confirm asks before the change, runs it on Apply, and makes the prompt one undo', async () => {
    const { root, server, ed, sendText, pick } = await start(['assistant', 'confirm', 'auto'])
    pick('Confirm')
    await sendText('Rename the box to Crate')
    expect(server.says[0]).toMatchObject({ mode: 'confirm', tools: [{ name: 'rename_object', description: 'Rename an object.', input_schema: { type: 'object' } }] })
    expect(root.querySelector('.asst-change-t')!.textContent).toBe('Rename object — id: “Box”; name: Crate')
    expect(ed.ran, 'nothing runs before the click').toEqual([])
    root.querySelector<HTMLButtonElement>('.asst-change .asst-file')!.click()
    await settle()
    await settle()
    expect(ed.ran).toEqual([['rename_object', { id: 'n:a', name: 'Crate' }]])
    expect(server.answers).toEqual([{ outcome: { ok: true, result: null } }])
    expect(root.querySelector('.asst-change .asst-note')!.textContent, 'said once it ran').toBe('Applied')
    expect(ed.turns).toEqual(['begin assistant: Rename the box to Crate', 'end'])
  })

  it('in Confirm answers no on Don’t, and runs nothing', async () => {
    const { root, server, ed, sendText, pick } = await start(['assistant', 'confirm', 'auto'])
    pick('Confirm')
    await sendText('Rename the box')
    root.querySelector<HTMLButtonElement>('.asst-dont')!.click()
    await settle()
    await settle()
    expect(ed.ran).toEqual([])
    expect(server.answers).toEqual([{ declined: true }])
    expect(root.querySelector('.asst-change .asst-note')!.textContent).toBe('Not done — say what you want instead')
  })

  it('in Auto runs the change without asking, and says what it did', async () => {
    const { root, server, ed, sendText, pick } = await start(['assistant', 'confirm', 'auto'])
    pick('Auto')
    await sendText('Rename the box')
    await settle()
    expect(root.querySelector('.asst-change')).toBeNull()
    expect(ed.ran).toHaveLength(1)
    expect(server.answers).toHaveLength(1)
    expect([...root.querySelectorAll('.asst-act')].map((n) => n.textContent)).toContain('Rename object — id: “Box”; name: Crate')
  })

  it('sends no tools in Assistant mode', async () => {
    const { server, sendText } = await start(['assistant', 'confirm', 'auto'])
    void sendText('How do I rename?')
    await settle()
    expect(server.says[0]).toMatchObject({ mode: 'assistant' })
    expect(server.says[0]!.tools).toBeUndefined()
  })
})

describe('a change that is refused when it runs', () => {
  it('says so on its card, not Applied', async () => {
    const sse = (events: object[]): string => events.map((e) => `event: ${(e as { kind: string }).kind}
data: ${JSON.stringify(e)}

`).join('')
    let release = (): void => {}
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0))
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string }) => {
      if (url === '/api/assistant') return new Response(JSON.stringify({ ready: true, github: true, spent: 0, limit: 1, modes: ['assistant', 'confirm', 'auto'] }))
      if (url === '/api/assistant/chats' && init?.method === 'POST') return new Response(JSON.stringify({ id: 'a'.repeat(32) }))
      if (url.endsWith('/say')) {
        const gate = new Promise<void>((r) => (release = r))
        const enc = new TextEncoder()
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(c) {
              c.enqueue(enc.encode(sse([{ kind: 'call', call: { id: 'k1', name: 'rename_object', input: { id: 'n:a', name: 'X' } } }])))
              await gate
              c.enqueue(enc.encode(sse([{ kind: 'done' }])))
              c.close()
            },
          }),
        )
      }
      if (url.includes('/result/')) {
        release()
        return new Response(null, { status: 204 })
      }
      return new Response('{}', { status: 404 })
    })
    const link: EditorLink = {
      tools: async () => [{ name: 'rename_object', description: 'Rename.', input_schema: { type: 'object' }, edits: true }],
      begin: async () => {},
      run: async () => ({ ok: false, error: 'Bob has “Box” selected, so it was left alone' }),
      describe: async () => 'Rename object',
      end: async () => {},
    }
    const settle = () => new Promise((r) => setTimeout(r, 20))
    const root = document.createElement('div')
    document.body.replaceChildren(root)
    createChatWindow({ root, context: async () => ({}), link })
    await settle()
    root.querySelector<HTMLButtonElement>('.asst-modepick')!.click()
    ;[...root.querySelectorAll<HTMLButtonElement>('.asst-pop-mode')].find((b) => b.querySelector('.asst-pop-t')!.textContent === 'Confirm')!.click()
    const input = root.querySelector<HTMLTextAreaElement>('.asst-in')!
    input.value = 'rename'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await settle()
    await settle()
    root.querySelector<HTMLButtonElement>('.asst-change .asst-file')!.click()
    await settle()
    await settle()
    expect(root.querySelector('.asst-change .asst-err')!.textContent).toBe('Not applied — Bob has “Box” selected, so it was left alone')
    vi.unstubAllGlobals()
  })
})

describe('saved chats (ADR 0197)', () => {
  const settle = () => new Promise((r) => setTimeout(r, 20))
  const A = 'a'.repeat(32)
  const B = 'b'.repeat(32)

  /** A server with two saved chats; what was deleted, kept. */
  const serve = () => {
    const deleted: string[] = []
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0))
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string }) => {
      if (url === '/api/assistant') return new Response(JSON.stringify({ ready: true, github: false, spent: 0, limit: 1, modes: ['assistant', 'confirm', 'auto'] }))
      if (url === '/api/assistant/chats' && (init?.method ?? 'GET') === 'GET')
        return new Response(
          JSON.stringify({
            chats: [
              { id: A, title: 'Make the box red', mode: 'auto', lastUsed: Date.now() - 5 * 60_000 },
              { id: B, title: 'How do I add a Hazard?', mode: 'assistant', lastUsed: Date.now() - 3 * 86_400_000 },
            ].filter((c) => !deleted.includes(c.id)),
          }),
        )
      if (url === `/api/assistant/chats/${A}` && (init?.method ?? 'GET') === 'GET')
        return new Response(JSON.stringify({ shown: [{ kind: 'you', text: 'Make the box red' }, { kind: 'assistant', text: 'Done.' }], filed: {}, busy: false, title: 'Make the box red', mode: 'auto' }))
      if (url.startsWith('/api/assistant/chats/') && init?.method === 'DELETE') {
        deleted.push(url.split('/').at(-1)!)
        return new Response(null, { status: 204 })
      }
      return new Response('{}', { status: 404 })
    })
    return { deleted }
  }
  afterEach(() => vi.unstubAllGlobals())

  const open = async () => {
    const root = document.createElement('div')
    document.body.replaceChildren(root)
    const link: EditorLink = { tools: async () => [], begin: async () => {}, run: async () => ({ ok: true, result: null }), describe: async () => '', end: async () => {} }
    createChatWindow({ root, context: async () => ({}), link })
    await settle()
    return root
  }

  it('lists the saved chats, the latest first, and opens one as it was — its mode too', async () => {
    serve()
    const root = await open()
    root.querySelector<HTMLButtonElement>('.asst-chats')!.click()
    await settle()
    const titles = [...root.querySelectorAll('.asst-pop-open .asst-pop-t')].map((n) => n.textContent)
    expect(titles).toEqual(['Make the box red', 'How do I add a Hazard?'])
    expect([...root.querySelectorAll('.asst-pop-open .asst-pop-d')].map((n) => n.textContent)).toEqual(['5 min', '3 d'])
    root.querySelector<HTMLButtonElement>('.asst-pop-open')!.click()
    await settle()
    expect(root.querySelector('.asst-chats-t')!.textContent).toBe('Make the box red')
    expect([...root.querySelectorAll('.asst-you')].map((n) => n.textContent)).toEqual(['Make the box red'])
    expect(root.querySelector('.asst-modepick')!.textContent).toBe('Auto')
  })

  it('deletes a chat only once asked again', async () => {
    const server = serve()
    const root = await open()
    root.querySelector<HTMLButtonElement>('.asst-chats')!.click()
    await settle()
    root.querySelectorAll<HTMLButtonElement>('.asst-pop-x')[1]!.click()
    expect(server.deleted, 'not yet').toEqual([])
    expect(root.querySelector('.asst-pop-sure .asst-pop-t')!.textContent).toBe('Delete “How do I add a Hazard?”?')
    root.querySelector<HTMLButtonElement>('.asst-pop-yes')!.click()
    await settle()
    expect(server.deleted).toEqual([B])
    expect(root.querySelectorAll('.asst-pop-chat')).toHaveLength(1)
  })

  it('starts a new chat from the menu', async () => {
    serve()
    const root = await open()
    root.querySelector<HTMLButtonElement>('.asst-chats')!.click()
    await settle()
    root.querySelector<HTMLButtonElement>('.asst-pop-open')!.click()
    await settle()
    root.querySelector<HTMLButtonElement>('.asst-chats')!.click()
    await settle()
    root.querySelector<HTMLButtonElement>('.asst-pop-new')!.click()
    await settle()
    expect(root.querySelector('.asst-chats-t')!.textContent).toBe('New chat')
    expect(root.querySelector('.asst-you')).toBeNull()
  })
})

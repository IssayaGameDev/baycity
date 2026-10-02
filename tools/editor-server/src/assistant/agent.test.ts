import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'

import { forModel, runTurn, type AssistantEvent, type AssistantMode, type Conversation, type Talk } from './agent'
import { createBudget } from './budget'
import { TOOLS, type ToolRun } from './tools'

/**
 * The assistant's turn (ADR 0192): the model and its tools in a loop until it answers, streamed, counted against the
 * person's day — with a scripted model, so nothing here calls Claude.
 */

const text = (t: string): Anthropic.TextBlock => ({ type: 'text', text: t, citations: null })
const use = (id: string, name: string, input: Record<string, unknown>): Anthropic.ToolUseBlock => ({ type: 'tool_use', id, name, input, caller: { type: 'direct' } })
const usage = { input_tokens: 1000, output_tokens: 100 }

/** A model that answers from a script, one reply a call, streaming each reply's text. */
const scripted = (replies: (readonly Anthropic.ContentBlock[])[]): { talk: Talk; seen: Anthropic.MessageParam[][]; systems: string[] } => {
  const seen: Anthropic.MessageParam[][] = []
  const systems: string[] = []
  let n = 0
  const talk: Talk = async (request, onText) => {
    seen.push(request.messages)
    systems.push(request.system.map((b) => b.text).join(''))
    const content = replies[n++] ?? [text('…')]
    for (const b of content) if (b.type === 'text') onText(b.text)
    return { content, usage, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' }
  }
  return { talk, seen, systems }
}

const chat = (): Conversation => ({ id: 'c', email: 'ada@x.com', name: 'Ada', title: '', mode: 'assistant', createdAt: 0, messages: [], shown: [], drafts: new Map(), filed: new Map(), lastUsed: 0, busy: false, stopping: false })

const turn = async (talk: Talk, run: (name: string, input: Record<string, unknown>) => Promise<ToolRun>, conv = chat(), limit = 1, mode: AssistantMode = 'assistant', text = 'Why does the hazard not kill?') => {
  const events: AssistantEvent[] = []
  const budget = createBudget({ file: null, limit })
  await runTurn(
    conv,
    text,
    { game: 'keyboard', level: 'World 1', selection: ['Lava (Collider, Hazard)'] },
    { instructions: 'Answer from the docs.', tools: TOOLS, mode, silent: (n) => n === 'rename_object', talk, run, budget },
    (e) => events.push(e),
  )
  return { events, conv, budget }
}

describe('a turn', () => {
  it('searches, reads what it found, and answers — each step shown as it happens', async () => {
    const { talk, seen, systems } = scripted([[text('Let me look.'), use('t1', 'search_repo', { query: 'onContact' })], [text('It kills on contact.')]])
    const ran: string[] = []
    const { events, conv } = await turn(talk, async (name, input) => {
      ran.push(`${name}:${String(input.query)}`)
      return { result: 'src/hazard.ts:10:onContact kills' }
    })
    expect(ran).toEqual(['search_repo:onContact'])
    expect(events.filter((e) => e.kind === 'text').map((e) => (e.kind === 'text' ? e.text : ''))).toEqual(['Let me look.', 'It kills on contact.'])
    expect(events.find((e) => e.kind === 'activity')).toEqual({ kind: 'activity', text: 'Searching for “onContact”' })
    expect(events.at(-1)).toEqual({ kind: 'done' })
    // The instructions were the system prompt, every call.
    expect(systems).toEqual(['Answer from the docs.', 'Answer from the docs.'])
    // What the person was looking at went with the message.
    const first = seen[0]![0]!
    const firstText = typeof first.content === 'string' ? first.content : (first.content[0] as Anthropic.TextBlockParam).text
    expect(firstText).toContain('<editor>\nmode: assistant\ngame: keyboard\nlevel: World 1\nselected: Lava (Collider, Hazard)\n</editor>')
    // The tool's answer went back as the result of that call.
    expect(JSON.stringify(seen[1]!.at(-1))).toContain('"tool_use_id":"t1"')
    expect(conv.shown.map((s) => s.kind)).toEqual(['you', 'assistant', 'activity', 'assistant'])
  })

  it('shows a draft to the person and keeps it for filing', async () => {
    const { talk } = scripted([[use('t1', 'draft_issue', { title: 'Hazard misses', body: 'Steps…' })], [text('Drafted — file it if it looks right.')]])
    const draft = { id: 'd1', kind: 'issue', title: 'Hazard misses', body: 'Steps…', labels: [] } as const
    const { events, conv } = await turn(talk, async () => ({ result: 'Draft d1 is shown.', draft }))
    expect(events.find((e) => e.kind === 'draft')).toEqual({ kind: 'draft', draft })
    expect(conv.drafts.get('d1')).toEqual(draft)
  })

  it('stops for the day once the person’s budget is spent', async () => {
    const { talk } = scripted([[use('t1', 'search_repo', { query: 'x' })], [text('never said')]])
    // 1000 in + 100 out at Haiku's rates is $0.0015 a call: a limit under that ends the turn after one.
    const { events } = await turn(talk, async () => ({ result: 'r' }), chat(), 0.001)
    expect(events.at(-1)).toMatchObject({ kind: 'error' })
    expect(events.some((e) => e.kind === 'text' && e.text === 'never said')).toBe(false)
    const { events: next } = await turn(talk, async () => ({ result: 'r' }), chat(), 0)
    expect(next).toEqual([{ kind: 'error', message: "Today's $0.00 is used up. The assistant is back tomorrow (UTC)." }])
  })

  it('takes a failed turn back out, so the next one starts clean', async () => {
    const talk: Talk = async () => {
      throw new Error('overloaded')
    }
    const { events, conv } = await turn(talk, async () => ({ result: 'r' }))
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'The assistant failed: overloaded' })
    expect(conv.messages).toEqual([])
    expect(conv.busy).toBe(false)
  })
})

describe('a turn that edits (ADR 0195)', () => {
  it('ends where the person says no: the rest of the round is answered, not run, and the model is not asked again', async () => {
    const { talk, seen } = scripted([[use('t1', 'rename_object', { id: 'n:a', name: 'X' }), use('t2', 'rename_object', { id: 'n:b', name: 'Y' })], [text('never said')]])
    const ran: string[] = []
    const { events, conv } = await turn(
      talk,
      async (_name, input) => {
        ran.push(String(input.id))
        return { result: 'declined', isError: true, ends: true }
      },
      chat(),
      1,
      'confirm',
    )
    expect(ran, 'only the first is asked about').toEqual(['n:a'])
    expect(seen).toHaveLength(1)
    expect(events.at(-1)).toEqual({ kind: 'done' })
    const results = conv.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]
    expect(results.map((r) => [r.tool_use_id, r.content])).toEqual([
      ['t1', 'declined'],
      ['t2', 'Not run: the person ended this turn.'],
    ])
  })

  it('takes the next message onto the results it ended on, one user turn', async () => {
    const conv = chat()
    await turn(scripted([[use('t1', 'rename_object', { id: 'n:a' })]]).talk, async () => ({ result: 'declined', isError: true, ends: true }), conv, 1, 'confirm')
    const next = scripted([[text('Understood.')]])
    await turn(next.talk, async () => ({ result: 'r' }), conv, 1, 'confirm', 'Make it blue instead')
    const roles = conv.messages.map((m) => m.role)
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant'])
    const joined = conv.messages[2]!.content as Anthropic.ContentBlockParam[]
    expect(joined.map((b) => b.type)).toEqual(['tool_result', 'text'])
    expect((joined[1] as Anthropic.TextBlockParam).text).toContain('Make it blue instead')
  })

  it('stops at the next step once the person says stop', async () => {
    const conv = chat()
    const { talk, seen } = scripted([[use('t1', 'rename_object', { id: 'n:a' })], [text('never said')]])
    await turn(
      talk,
      async () => {
        conv.stopping = true
        return { result: 'renamed' }
      },
      conv,
      1,
      'auto',
    )
    expect(seen, 'no model call after the stop').toHaveLength(1)
  })

  it('leaves the activity of an editor action to the tab, and keeps it for a tab the chat moves to', async () => {
    const { talk } = scripted([[use('t1', 'rename_object', { id: 'n:a' })], [text('Done.')]])
    const { events, conv } = await turn(talk, async () => ({ result: 'ok' }), chat(), 1, 'auto')
    expect(events.some((e) => e.kind === 'activity')).toBe(false)
    expect(conv.shown.some((s) => s.kind === 'activity' && s.text === 'Rename object')).toBe(true)
  })
})

describe('what goes back to the model', () => {
  const result = (id: string): Anthropic.MessageParam => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `result ${id}` }] })
  const call = (id: string): Anthropic.MessageParam => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'list_assets', input: {} }] })
  const contents = (ms: Anthropic.MessageParam[]): string[] =>
    ms.flatMap((m) => (typeof m.content === 'string' ? [] : m.content.flatMap((b) => (b.type === 'tool_result' && typeof b.content === 'string' ? [b.content] : []))))

  it('keeps every result of this turn whole however long it runs, and trims an earlier turn’s old ones', () => {
    const earlier = [call('e1'), result('e1')]
    const thisTurn = Array.from({ length: 12 }, (_, n) => [call(`t${n}`), result(`t${n}`)]).flat()
    const sent = contents(forModel([...earlier, { role: 'user', content: 'next' }, ...thisTurn], earlier.length))
    expect(sent[0]).toBe('[earlier result trimmed — read it again if needed]')
    expect(sent.slice(1)).toEqual(Array.from({ length: 12 }, (_, n) => `result t${n}`))
  })
})
